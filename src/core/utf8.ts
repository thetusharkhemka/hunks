/**
 * The handful of places where git's output depends on bytes rather than
 * characters: the hunk header's function name is cut at 80 bytes, the header
 * line at 128, and the result is then trimmed at the first byte sequence git
 * does not consider valid UTF-8.
 *
 * Text-mode input is encoded to UTF-8 here so those rules apply to the same
 * bytes git would see; byte-mode input already is bytes.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBytes(s: string, bytes: boolean): Uint8Array {
  if (!bytes) return encoder.encode(s);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function fromBytes(b: Uint8Array, bytes: boolean): string {
  if (!bytes) return decoder.decode(b);
  let s = '';
  for (let i = 0; i < b.length; i += 8192) {
    s += String.fromCharCode.apply(null, b.subarray(i, i + 8192) as unknown as number[]);
  }
  return s;
}

/** Text as a byte-mode string: its UTF-8 bytes, one per char. */
export function byteString(text: string): string {
  return fromBytes(encoder.encode(text), true);
}

/** A byte-mode string read back as text (UTF-8, invalid bytes replaced). */
export function textOf(bytesAsChars: string): string {
  return decoder.decode(toBytes(bytesAsChars, true));
}

/**
 * Length of the longest prefix of `b` that git's UTF-8 decoder accepts.
 * Stricter than the standard: U+FFFE and U+FFFF are rejected too.
 */
export function validUtf8Prefix(b: Uint8Array): number {
  let i = 0;
  const n = b.length;
  while (i < n) {
    const c = b[i];
    if (c < 0x80) {
      i += 1;
    } else if ((c & 0xe0) === 0xc0) {
      if (n - i < 2 || (b[i + 1] & 0xc0) !== 0x80 || (c & 0xfe) === 0xc0) break;
      i += 2;
    } else if ((c & 0xf0) === 0xe0) {
      if (n - i < 3 ||
          (b[i + 1] & 0xc0) !== 0x80 ||
          (b[i + 2] & 0xc0) !== 0x80 ||
          (c === 0xe0 && (b[i + 1] & 0xe0) === 0x80) ||
          (c === 0xed && (b[i + 1] & 0xe0) === 0xa0) ||
          (c === 0xef && b[i + 1] === 0xbf && (b[i + 2] & 0xfe) === 0xbe)) break;
      i += 3;
    } else if ((c & 0xf8) === 0xf0) {
      if (n - i < 4 ||
          (b[i + 1] & 0xc0) !== 0x80 ||
          (b[i + 2] & 0xc0) !== 0x80 ||
          (b[i + 3] & 0xc0) !== 0x80 ||
          (c === 0xf0 && (b[i + 1] & 0xf0) === 0x80) ||
          (c === 0xf4 && b[i + 1] > 0x8f) || c > 0xf4) break;
      i += 4;
    } else {
      break;
    }
  }
  return i;
}

const HEADING_MAX = 80;
const HEADER_BUF = 128;

function isSpaceByte(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

/**
 * The function-name part of a hunk header, as git's emitter keeps it: at most
 * 80 bytes, then trailing whitespace removed. The cut may land inside a
 * multibyte character; that is resolved later, on the whole header line.
 */
export function headingBytes(raw: string, bytes: boolean): Uint8Array {
  let b = toBytes(raw, bytes);
  let len = Math.min(b.length, HEADING_MAX);
  while (len > 0 && isSpaceByte(b[len - 1])) len--;
  if (len !== b.length) b = b.subarray(0, len);
  return b;
}

/** The hunk header line, without its newline. */
export function hunkHeader(
  oldStart: number, oldLines: number, newStart: number, newLines: number,
  heading: Uint8Array | null, bytes: boolean,
): string {
  let head = '@@ -' + (oldLines ? oldStart : oldStart - 1);
  if (oldLines !== 1) head += ',' + oldLines;
  head += ' +' + (newLines ? newStart : newStart - 1);
  if (newLines !== 1) head += ',' + newLines;
  head += ' @@';
  if (!heading || heading.length === 0) return head;

  // git formats into a 128-byte buffer, then cuts the line at the first
  // sequence that is not valid UTF-8 (sane_truncate_line in diff.c).
  const room = HEADER_BUF - (head.length + 1) - 1;
  const func = heading.length > room ? heading.subarray(0, Math.max(room, 0)) : heading;
  return head + ' ' + fromBytes(func.subarray(0, validUtf8Prefix(func)), bytes);
}
