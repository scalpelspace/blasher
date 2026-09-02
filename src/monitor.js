/**
 * Serial monitor formatting: turns a byte stream into display lines, and
 * typed input into bytes.
 *
 * Kept free of DOM so the rules that are easy to get wrong - partial UTF-8
 * sequences split across chunks, CRLF arriving in two reads, a hex row that
 * is only half full when the target goes quiet - can be reasoned about and
 * exercised on their own.
 */

/**
 * Parse loose hex input into bytes. Accepts "01 0A ff", "0x01,0x0A,0xFF" or
 * "010AFF", matching the input pyblasher's util.parse_hex takes.
 */
export function parseHex(text) {
  const cleaned = String(text)
    .replace(/0x/gi, " ")
    .replace(/[,\r\n\t]/g, " ")
    .trim();
  if (cleaned === "") return new Uint8Array(0);

  const parts = cleaned.split(/\s+/);
  // A single unbroken run of hex digits is a byte string, not one number.
  if (parts.length === 1 && /^[0-9a-f]+$/i.test(parts[0])) {
    const run = parts[0];
    if (run.length % 2 !== 0) {
      throw new Error(`Hex needs an even number of digits, got ${run.length}`);
    }
    const out = new Uint8Array(run.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = Number.parseInt(run.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  const out = new Uint8Array(parts.length);
  parts.forEach((part, i) => {
    if (!/^[0-9a-f]{1,2}$/i.test(part)) {
      throw new Error(`Not a hex byte: ${part}`);
    }
    out[i] = Number.parseInt(part, 16);
  });
  return out;
}

const printable = (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".");

/** One hexdump row: offset, hex columns, ASCII gutter. */
export function hexdumpRow(bytes, offset, width = 16) {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ")
    .padEnd(width * 3 - 1, " ");
  const ascii = Array.from(bytes).map(printable).join("");
  return `${offset.toString(16).padStart(8, "0")}  ${hex}  ${ascii}`;
}

export const LINE_ENDINGS = {
  none: "", lf: "\n", cr: "\r", crlf: "\r\n",
};

/**
 * Accumulates incoming bytes and emits whole display lines.
 *
 * Text mode decodes UTF-8 across chunk boundaries and splits on newlines,
 * holding an unterminated tail until the rest arrives. Hex mode holds bytes
 * until a full 16-byte row is available. Either way `flush()` forces out
 * whatever is pending, which the caller should do on an idle timer so a
 * target that stops mid-line still shows what it sent.
 */
export class StreamFormatter {
  constructor({hex = false, width = 16} = {}) {
    this.width = width;
    this.hex = hex;
    this.offset = 0;
    this._decoder = new TextDecoder("utf-8", {fatal: false});
    this._text = "";
    this._bytes = new Uint8Array(0);
  }

  /** Switching modes flushes the old one; offsets restart. */
  setHex(hex) {
    if (hex === this.hex) return [];
    const tail = this.flush();
    this.hex = hex;
    this.offset = 0;
    return tail;
  }

  push(chunk) {
    return this.hex ? this._pushHex(chunk) : this._pushText(chunk);
  }

  _pushText(chunk) {
    this._text += this._decoder.decode(chunk, {stream: true});
    if (!this._text.includes("\n")) return [];
    const parts = this._text.split("\n");
    this._text = parts.pop();
    // Strip the CR of a CRLF pair; a bare CR is left for the caller to see.
    return parts.map((line) => line.replace(/\r$/, ""));
  }

  _pushHex(chunk) {
    const merged = new Uint8Array(this._bytes.length + chunk.length);
    merged.set(this._bytes, 0);
    merged.set(chunk, this._bytes.length);

    const lines = [];
    let at = 0;
    while (merged.length - at >= this.width) {
      lines.push(hexdumpRow(merged.subarray(at, at + this.width), this.offset, this.width));
      this.offset += this.width;
      at += this.width;
    }
    this._bytes = merged.slice(at);
    return lines;
  }

  /** Emit any partial line or half-full hex row. */
  flush() {
    if (this.hex) {
      if (this._bytes.length === 0) return [];
      const line = hexdumpRow(this._bytes, this.offset, this.width);
      this.offset += this._bytes.length;
      this._bytes = new Uint8Array(0);
      return [line];
    }
    if (this._text === "") return [];
    const line = this._text;
    this._text = "";
    return [line];
  }

  reset() {
    this.offset = 0;
    this._text = "";
    this._bytes = new Uint8Array(0);
    this._decoder = new TextDecoder("utf-8", {fatal: false});
  }
}

/** Bytes for a line typed into the monitor. */
export function encodeInput(text, {hex = false, lineEnding = "lf"} = {}) {
  if (hex) return parseHex(text);
  return new TextEncoder().encode(text + (LINE_ENDINGS[lineEnding] ?? "\n"));
}
