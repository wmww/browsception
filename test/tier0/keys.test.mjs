// Tier 0: canvas key routing (src/ext/keys.mjs) — who gets a key, and what
// text a keydown inserts. The engine's key map decides what combos mean;
// these only decide host vs guest and prevented vs not.

import test from 'node:test';
import assert from 'node:assert/strict';
import { hostKey, hostPasteKey, keyText } from '../../src/ext/keys.mjs';

const ev = (key, mods = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  getModifierState: (m) => (m === 'AltGraph' ? !!mods.altGraph : false),
  ...mods,
});
const ctrl = (key, more = {}) => ev(key, { ctrlKey: true, ...more });
const cmd = (key, more = {}) => ev(key, { metaKey: true, ...more });

test('host keys: browser shortcuts stay with the host, Ctrl and Cmd alike', () => {
  for (const e of [
    ev('F5'), ev('F12'), ev('F11'), ev('ArrowLeft', { altKey: true }), ev('ArrowRight', { altKey: true }),
    ctrl('l'), ctrl('t'), ctrl('w'), ctrl('n'), ctrl('r'), ctrl('R', { shiftKey: true }), ctrl('T', { shiftKey: true }),
    ctrl('Tab'), ctrl('Tab', { shiftKey: true }), ctrl('1'), ctrl('9'), ctrl('PageDown'),
    ctrl('I', { shiftKey: true }), ctrl('J', { shiftKey: true }), ctrl('C', { shiftKey: true }),
    ctrl('='), ctrl('-'), ctrl('0'), ctrl('F5'),
    cmd('l'), cmd('t'), cmd('w'), cmd('i', { altKey: true }),
  ])
    assert.equal(hostKey(e), true, JSON.stringify(e));
});

test('guest keys: editing and page shortcuts are forwarded', () => {
  for (const e of [
    ev('a'), ev('A', { shiftKey: true }), ev('Enter'), ev('Tab'), ev('Backspace'), ev('ArrowLeft'), ev('Escape'),
    ctrl('c'), ctrl('x'), ctrl('v'), ctrl('a'), ctrl('b'), ctrl('k'), ctrl('s'), ctrl('f'), ctrl('z'), ctrl('d'),
    ctrl('Enter'), ctrl('Insert'), ev('Delete', { shiftKey: true }), ev('Insert', { shiftKey: true }),
    cmd('c'), cmd('v'), ev('Control', { ctrlKey: true }),
  ])
    assert.equal(hostKey(e), false, JSON.stringify(e));
});

test('paste keys: Ctrl/Cmd+V (any Shift) and Shift+Insert, nothing else', () => {
  for (const e of [ctrl('v'), ctrl('V', { shiftKey: true }), cmd('v'), cmd('V', { shiftKey: true }), ev('Insert', { shiftKey: true })])
    assert.equal(hostPasteKey(e), true, JSON.stringify(e));
  for (const e of [ev('v'), ctrl('c'), ctrl('x'), ctrl('Insert'), ev('Insert'), ctrl('v', { altKey: true }), ev('Delete', { shiftKey: true })])
    assert.equal(hostPasteKey(e), false, JSON.stringify(e));
});

test('key text: printable keys insert, Ctrl/Cmd combos do not, AltGr does', () => {
  assert.equal(keyText(ev('a')), 'a');
  assert.equal(keyText(ev('A', { shiftKey: true })), 'A');
  assert.equal(keyText(ev('å', { altKey: true })), 'å'); // Mac Option layer
  assert.equal(keyText(ev('Enter')), '\r');
  assert.equal(keyText(ev('Tab')), '\t');
  assert.equal(keyText(ev('ArrowLeft')), '');
  assert.equal(keyText(ctrl('c')), '');
  assert.equal(keyText(ctrl('Enter')), '');
  assert.equal(keyText(cmd('v')), '');
  // Windows AltGr arrives as Ctrl+Alt with the produced character.
  assert.equal(keyText(ctrl('@', { altKey: true })), '@');
  assert.equal(keyText(ev('€', { altGraph: true })), '€');
});
