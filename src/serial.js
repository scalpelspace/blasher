/**
 * Web Serial transport: buffered reads with timeouts + modem control lines.
 *
 * The STM32 bootloader protocol is strictly request/response, so a single
 * pump task drains `port.readable` into a byte buffer that `read()` slices
 * from. That keeps the reader lock held for the whole session (Chrome only
 * allows one) while still giving callers simple awaitable, timed reads.
 */

export class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "TimeoutError";
  }
}

const CP2102N = {usbVendorId: 0x10c4, usbProductId: 0xea60};

export function isSupported() {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

/** Prompt the user for a port, optionally limited to the Blasher's CP2102N. */
export async function requestPort({anyDevice = false} = {}) {
  const filters = anyDevice ? [] : [CP2102N];
  return navigator.serial.requestPort({filters});
}

export function describePort(port) {
  const info = port.getInfo ? port.getInfo() : {};
  if (info.usbVendorId === undefined) return "Serial port";
  const vid = info.usbVendorId.toString(16).padStart(4, "0");
  const pid = (info.usbProductId ?? 0).toString(16).padStart(4, "0");
  const known = info.usbVendorId === CP2102N.usbVendorId && info.usbProductId === CP2102N.usbProductId ? "CP2102N (Blasher)" : "USB serial device";
  return `${known} - ${vid}:${pid}`;
}

export class SerialTransport {
  constructor(port) {
    this.port = port;
    this.reader = null;
    this.writer = null;
    this._buf = new Uint8Array(0);
    this._wake = null;
    this._pumpError = null;
    this._draining = false;
  }

  get isOpen() {
    return this.writer !== null;
  }

  async open({baudRate = 115200, parity = "even"} = {}) {
    await this.port.open({
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity,
      flowControl: "none",
      bufferSize: 8192,
    });
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this._buf = new Uint8Array(0);
    this._pumpError = null;
    this._pump();
  }

  async close() {
    this._draining = true;
    try {
      if (this.reader) await this.reader.cancel().catch(() => {
      });
      if (this.reader) this.reader.releaseLock();
    } catch {
      /* already released */
    }
    try {
      if (this.writer) this.writer.releaseLock();
    } catch {
      /* already released */
    }
    this.reader = null;
    this.writer = null;
    try {
      await this.port.close();
    } catch {
      /* port may already be gone (unplugged) */
    }
  }

  async _pump() {
    try {
      while (this.reader) {
        const {value, done} = await this.reader.read();
        if (done) break;
        if (value && value.length) {
          const merged = new Uint8Array(this._buf.length + value.length);
          merged.set(this._buf, 0);
          merged.set(value, this._buf.length);
          this._buf = merged;
          this._notify();
        }
      }
    } catch (err) {
      if (!this._draining) this._pumpError = err;
      this._notify();
    }
  }

  _notify() {
    if (this._wake) {
      const wake = this._wake;
      this._wake = null;
      wake();
    }
  }

  _waitForData(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._wake === onData) this._wake = null;
        reject(new TimeoutError(`No response within ${timeoutMs} ms`));
      }, timeoutMs);
      const onData = () => {
        clearTimeout(timer);
        resolve();
      };
      this._wake = onData;
    });
  }

  /** Discard anything already received (stale bootloader chatter, echoes). */
  flushInput() {
    this._buf = new Uint8Array(0);
  }

  get available() {
    return this._buf.length;
  }

  async write(bytes) {
    if (!this.writer) throw new Error("Port is not open");
    await this.writer.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  /** Read exactly `count` bytes, or throw TimeoutError. */
  async read(count, timeoutMs = 2000) {
    const deadline = performance.now() + timeoutMs;
    while (this._buf.length < count) {
      if (this._pumpError) throw this._pumpError;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new TimeoutError(`Timed out waiting for ${count} byte(s); got ${this._buf.length}`);
      }
      await this._waitForData(remaining);
    }
    const out = this._buf.slice(0, count);
    this._buf = this._buf.slice(count);
    return out;
  }

  async readByte(timeoutMs = 2000) {
    return (await this.read(1, timeoutMs))[0];
  }

  /**
   * Drive the modem control lines. `dataTerminalReady` / `requestToSend` are
   * asserted-true; on a CP2102N an asserted line reads low at the TTL pin.
   */
  async setSignals(signals) {
    await this.port.setSignals(signals);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
