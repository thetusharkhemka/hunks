/**
 * git's quote_c_style, with core.quotePath at its default (on): a name that
 * contains a control character, a double quote, a backslash or any non-ASCII
 * byte is written in double quotes with C escapes. Besides matching git's
 * output, this keeps a name from breaking out of its header line.
 */

const encoder = new TextEncoder();
const NAMED: Record<number, string> = { 7: 'a', 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r', 34: '"', 92: '\\' };

export function quotePath(name: string): string {
  const bytes = encoder.encode(name);
  let needs = false;
  let out = '';
  for (const c of bytes) {
    if (c < 0x20 || c === 0x22 || c === 0x5c || c >= 0x7f) {
      needs = true;
      out += NAMED[c] !== undefined ? '\\' + NAMED[c] : '\\' + c.toString(8).padStart(3, '0');
    } else {
      out += String.fromCharCode(c);
    }
  }
  return needs ? `"${out}"` : name;
}

/**
 * A `---` or `+++` line: git ends it with a tab when the name contains a
 * space, so that patch(1) can tell the name from a timestamp.
 */
export function fileLine(marker: '---' | '+++', label: string): string {
  return `${marker} ${label}${label.includes(' ') ? '\t' : ''}`;
}
