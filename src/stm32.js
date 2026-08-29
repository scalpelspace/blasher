/**
 * STM32 USART bootloader protocol (ST AN3155).
 *
 * Wire format: 115200 8E1. Every command is <code, code ^ 0xFF>; the target
 * answers 0x79 (ACK) or 0x1F (NACK). Addresses are 32-bit big-endian followed
 * by an XOR checksum of those four bytes.
 */

import {TimeoutError} from "./serial.js";

export const ACK = 0x79;
export const NACK = 0x1f;
export const SYNC = 0x7f;

export const CMD = {
  GET: 0x00,
  GET_VERSION: 0x01,
  GET_ID: 0x02,
  READ_MEMORY: 0x11,
  GO: 0x21,
  WRITE_MEMORY: 0x31,
  ERASE: 0x43,
  EXTENDED_ERASE: 0x44,
  WRITE_UNPROTECT: 0x73,
  READOUT_UNPROTECT: 0x92,
};

/** Max payload of a single Write Memory / Read Memory command. */
export const BLOCK_SIZE = 256;

export function checksum(bytes, seed = 0) {
  let acc = seed;
  for (const b of bytes) acc ^= b;
  return acc & 0xff;
}

export class BootloaderError extends Error {
  constructor(message) {
    super(message);
    this.name = "BootloaderError";
  }
}

const addressFrame = (addr) => {
  const a = new Uint8Array([(addr >>> 24) & 0xff, (addr >>> 16) & 0xff, (addr >>> 8) & 0xff, addr & 0xff,]);
  return new Uint8Array([...a, checksum(a)]);
};

export class Bootloader {
  /**
   * @param {import("./serial.js").SerialTransport} transport
   * @param {{log?: (msg: string, level?: string) => void, ackTimeout?: number,
   *          eraseTimeout?: number}} [options]
   */
  constructor(transport, options = {}) {
    this.io = transport;
    this.log = options.log ?? (() => {
    });
    this.ackTimeout = options.ackTimeout ?? 2000;
    this.eraseTimeout = options.eraseTimeout ?? 40000;
    this.commands = null; // filled in by get()
    this.version = null;
  }

  async _ack(timeoutMs = this.ackTimeout, what = "command") {
    let byte;
    try {
      byte = await this.io.readByte(timeoutMs);
    } catch (err) {
      if (err instanceof TimeoutError) {
        throw new BootloaderError(`No reply to ${what} (timed out)`);
      }
      throw err;
    }
    if (byte === ACK) return;
    if (byte === NACK) throw new BootloaderError(`${what} rejected (NACK)`);
    throw new BootloaderError(`${what}: unexpected reply 0x${byte.toString(16).padStart(2, "0")}`);
  }

  async _command(code, what, timeoutMs = this.ackTimeout) {
    this.io.flushInput();
    await this.io.write(new Uint8Array([code, code ^ 0xff]));
    await this._ack(timeoutMs, what);
  }

  /**
   * Auto-baud sync. A fresh bootloader answers ACK; one that is already
   * synced answers NACK, which is equally good news.
   */
  async sync({attempts = 3, timeoutMs = 500} = {}) {
    for (let i = 1; i <= attempts; i++) {
      this.io.flushInput();
      await this.io.write(new Uint8Array([SYNC]));
      try {
        const byte = await this.io.readByte(timeoutMs);
        if (byte === ACK) {
          this.log("Bootloader synced (ACK)");
          return;
        }
        if (byte === NACK) {
          this.log("Bootloader already synced (NACK)");
          return;
        }
        this.log(`Sync attempt ${i}: unexpected 0x${byte
          .toString(16)
          .padStart(2, "0")}`, "warn");
      } catch (err) {
        if (!(err instanceof TimeoutError)) throw err;
        this.log(`Sync attempt ${i}: no reply`, "warn");
      }
    }
    throw new BootloaderError("Bootloader did not answer the 0x7F sync byte. Check the 5-pin wiring, " + "that BOOT0 is high at reset, and that the target is powered.");
  }

  /** Get (0x00): protocol version + list of supported commands. */
  async get() {
    await this._command(CMD.GET, "Get");
    const n = await this.io.readByte(this.ackTimeout);
    const payload = await this.io.read(n + 1, this.ackTimeout);
    await this._ack(this.ackTimeout, "Get");
    this.version = payload[0];
    this.commands = Array.from(payload.slice(1));
    const major = this.version >> 4;
    const minor = this.version & 0x0f;
    this.log(`Bootloader v${major}.${minor}, commands: ` + this.commands
      .map((c) => "0x" + c.toString(16).padStart(2, "0"))
      .join(" "));
    return {version: this.version, commands: this.commands};
  }

  supports(cmd) {
    return this.commands === null || this.commands.includes(cmd);
  }

  /** Get ID (0x02): 12-bit device signature. */
  async getId() {
    await this._command(CMD.GET_ID, "Get ID");
    const n = await this.io.readByte(this.ackTimeout);
    const payload = await this.io.read(n + 1, this.ackTimeout);
    await this._ack(this.ackTimeout, "Get ID");
    let id = 0;
    for (const b of payload) id = (id << 8) | b;
    return id;
  }

  /** Mass erase, using Extended Erase (0x44) when the target offers it. */
  async massErase() {
    if (this.supports(CMD.EXTENDED_ERASE)) {
      await this._command(CMD.EXTENDED_ERASE, "Extended Erase");
      const frame = new Uint8Array([0xff, 0xff]);
      await this.io.write(new Uint8Array([...frame, checksum(frame)]));
      await this._ack(this.eraseTimeout, "Global erase");
    } else if (this.supports(CMD.ERASE)) {
      await this._command(CMD.ERASE, "Erase");
      await this.io.write(new Uint8Array([0xff, 0x00]));
      await this._ack(this.eraseTimeout, "Global erase");
    } else {
      throw new BootloaderError("Target supports neither 0x43 nor 0x44 erase");
    }
    this.log("Mass erase complete");
  }

  /** Write Memory (0x31). `data` must be <= 256 bytes and 4-byte aligned. */
  async writeMemory(addr, data) {
    if (data.length === 0 || data.length > BLOCK_SIZE) {
      throw new RangeError(`Invalid block length ${data.length}`);
    }
    await this._command(CMD.WRITE_MEMORY, "Write Memory");
    await this.io.write(addressFrame(addr));
    await this._ack(this.ackTimeout, "Write address");
    const frame = new Uint8Array([data.length - 1, ...data]);
    await this.io.write(new Uint8Array([...frame, checksum(frame)]));
    await this._ack(this.ackTimeout, "Write data");
  }

  /** Read Memory (0x11). Returns up to 256 bytes. */
  async readMemory(addr, length) {
    if (length === 0 || length > BLOCK_SIZE) {
      throw new RangeError(`Invalid read length ${length}`);
    }
    await this._command(CMD.READ_MEMORY, "Read Memory");
    await this.io.write(addressFrame(addr));
    await this._ack(this.ackTimeout, "Read address");
    const n = length - 1;
    await this.io.write(new Uint8Array([n, n ^ 0xff]));
    await this._ack(this.ackTimeout, "Read length");
    return this.io.read(length, this.ackTimeout);
  }

  /** Go (0x21): jump to the application without a reset. */
  async go(addr) {
    await this._command(CMD.GO, "Go");
    await this.io.write(addressFrame(addr));
    await this._ack(this.ackTimeout, "Go address");
    this.log(`Jumped to 0x${addr.toString(16).padStart(8, "0")}`);
  }

  /**
   * Program an image in 256-byte blocks.
   * @param {Uint8Array} image padded to a 4-byte boundary by the caller
   */
  async writeImage(image, baseAddr, onProgress = () => {
  }) {
    for (let offset = 0; offset < image.length; offset += BLOCK_SIZE) {
      const chunk = image.slice(offset, offset + BLOCK_SIZE);
      await this.writeMemory(baseAddr + offset, chunk);
      onProgress(Math.min(offset + chunk.length, image.length), image.length);
    }
  }

  /** Read the image back and compare byte for byte. */
  async verifyImage(image, baseAddr, onProgress = () => {
  }) {
    for (let offset = 0; offset < image.length; offset += BLOCK_SIZE) {
      const expected = image.slice(offset, offset + BLOCK_SIZE);
      const actual = await this.readMemory(baseAddr + offset, expected.length);
      for (let i = 0; i < expected.length; i++) {
        if (expected[i] !== actual[i]) {
          const at = baseAddr + offset + i;
          throw new BootloaderError(`Verify failed at 0x${at.toString(16).padStart(8, "0")}: ` + `expected 0x${expected[i].toString(16).padStart(2, "0")}, ` + `read 0x${actual[i].toString(16).padStart(2, "0")}`);
        }
      }
      onProgress(Math.min(offset + expected.length, image.length), image.length);
    }
  }
}

/** Pad to a 4-byte boundary with 0xFF (erased flash) so writes stay aligned. */
export function padImage(bytes) {
  const remainder = bytes.length % 4;
  if (remainder === 0) return bytes;
  const padded = new Uint8Array(bytes.length + (4 - remainder)).fill(0xff);
  padded.set(bytes, 0);
  return padded;
}
