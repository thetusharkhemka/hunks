// Plain-JavaScript check of the built package, for runtimes that cannot
// run the TypeScript sources directly (Node 20). Run after `npm run build`.
import assert from 'node:assert/strict';
import { diff, diffArrays, edits, inline, patch } from '../dist/index.js';

assert.equal(patch('a\nb\nc\n', 'a\nB\nc\n'), '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n');
assert.equal(patch('x', 'x\n'), '@@ -1 +1 @@\n-x\n\\ No newline at end of file\n+x\n');
const bytes = patch(new Uint8Array([0xff, 10]), new Uint8Array([0xfe, 10]));
assert.deepEqual([...bytes], [...Buffer.from('@@ -1 +1 @@\n-'), 0xff, 10, 0x2b, 0xfe, 10]);
assert.equal(diff('a\n', 'b\n', { inline: true }).hunks[0].lines.length, 2);
assert.deepEqual(edits('a\n', 'a\nb\n'), [{ oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 2 }]);
assert.equal(diffArrays([1, 2, 3], [1, 3], { algorithm: 'histogram' }).length, 1);
assert.deepEqual(inline(['price * quantity'], ['price * amount']).added, [[[8, 14]]]);
console.log(`smoke test passed on Node ${process.versions.node}`);
