// Tier 0: clipboard data packing (src/ext/clipboard.mjs) — a paste event's
// DataTransfer → bib_edit "paste" items + byte payload, and the engine's
// "clipboard" signal → a ClipboardItem record.

import test from 'node:test';
import assert from 'node:assert/strict';
import { packDataTransfer, toClipboardRecord } from '../../src/ext/clipboard.mjs';

// A DataTransfer after the paste event has been dispatched: getData goes
// dead, the File objects stay readable.
function fakeDataTransfer(strings, files = []) {
  let live = true;
  return {
    types: [...Object.keys(strings), ...(files.length ? ['Files'] : [])],
    getData: (t) => (live ? strings[t] ?? '' : ''),
    files,
    end: () => (live = false),
  };
}
const file = (bytes, type, name) => new File([new Uint8Array(bytes)], name, { type });

test('strings are read synchronously, files awaited into one payload', async () => {
  const dt = fakeDataTransfer(
    { 'text/plain': 'hi', 'text/html': '<b>hi</b>', 'application/x-custom': 'no' },
    [file([1, 2, 3], 'image/png', 'a.png'), file([4, 5], 'image/jpeg', 'b.jpg')],
  );
  const packed = packDataTransfer(dt);
  dt.end(); // the event handler returned
  const { items, bytes } = await packed;
  assert.deepEqual(items, [
    { type: 'text/plain', text: 'hi' },
    { type: 'text/html', text: '<b>hi</b>' },
    { type: 'image/png', name: 'a.png', off: 0, len: 3 },
    { type: 'image/jpeg', name: 'b.jpg', off: 3, len: 2 },
  ]);
  assert.deepEqual([...bytes], [1, 2, 3, 4, 5]);
});

test('text-only paste has no payload; empty strings are skipped', async () => {
  const { items, bytes } = await packDataTransfer(fakeDataTransfer({ 'text/plain': 'x', 'text/uri-list': '' }));
  assert.deepEqual(items, [{ type: 'text/plain', text: 'x' }]);
  assert.equal(bytes, null);
});

test('files past the cap are dropped, text kept', async () => {
  const dt = fakeDataTransfer({ 'text/plain': 'abcd' }, [file(new Array(20).fill(7), 'image/png', 'big.png'), file([9], 'image/png', 'small.png')]);
  const { items, bytes } = await packDataTransfer(dt, 16);
  assert.deepEqual(items, [
    { type: 'text/plain', text: 'abcd' },
    { type: 'image/png', name: 'small.png', off: 0, len: 1 },
  ]);
  assert.deepEqual([...bytes], [9]);
});

test('clipboard signal → ClipboardItem record: writable types only, bytes by range', async () => {
  const buf = new Uint8Array([0, 137, 80, 78, 71, 0]).buffer;
  const json = JSON.stringify({
    items: [
      { type: 'text/plain', text: 'hello' },
      { type: 'text/html', text: '<i>hello</i>' },
      { type: 'text/uri-list', text: 'https://x/' },
      { type: 'image/png', name: 'i.png', off: 1, len: 4 },
    ],
  });
  const { record, plain } = toClipboardRecord(json, buf);
  assert.deepEqual(Object.keys(record), ['text/plain', 'text/html', 'image/png']);
  assert.equal(await record['text/plain'].text(), 'hello');
  assert.equal(record['text/html'].type, 'text/html');
  assert.deepEqual([...new Uint8Array(await record['image/png'].arrayBuffer())], [137, 80, 78, 71]);
  assert.equal(plain, 'hello');
});

test('clipboard signal: nothing writable, bad ranges, bad JSON → no record', () => {
  assert.equal(toClipboardRecord(JSON.stringify({ items: [{ type: 'text/uri-list', text: 'u' }] })).record, null);
  assert.equal(toClipboardRecord(JSON.stringify({ items: [{ type: 'image/png', off: 2, len: 9 }] }), new ArrayBuffer(4)).record, null);
  assert.equal(toClipboardRecord('{').record, null);
});
