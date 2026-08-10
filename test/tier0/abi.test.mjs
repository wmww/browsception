// Tier 0: src/abi/abi.mjs must mirror src/abi/bib_abi.h exactly.
// Parses the header (macros, export prototypes, hook-list comment) and
// compares against the JS module, so the two can't drift silently.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ABI_VERSION,
  EXPORTS,
  HOOKS,
  MOD,
  KEY,
  NET_ERR,
  NET_WINDOW_BYTES,
} from '../../src/abi/abi.mjs';

const header = readFileSync(
  fileURLToPath(new URL('../../src/abi/bib_abi.h', import.meta.url)),
  'utf8',
);

function macros(prefix) {
  const out = {};
  const re = new RegExp(`^#define ${prefix}(\\w+) \\(?([\\d* ]+?)\\)?(?:\\s*/\\*.*)?$`, 'gm');
  for (const m of header.matchAll(re))
    out[m[1]] = eval(m[2]); // values are integer literals / products only
  return out;
}

test('ABI version matches', () => {
  assert.equal(ABI_VERSION, macros('BIB_ABI_').VERSION);
});

test('modifier, key-type, and net-error constants match', () => {
  assert.deepEqual(MOD, macros('BIB_MOD_'));
  assert.deepEqual(KEY, macros('BIB_KEY_'));
  assert.deepEqual(NET_ERR, macros('BIB_NET_ERR_'));
  assert.equal(NET_WINDOW_BYTES, macros('BIB_NET_').WINDOW_BYTES);
});

test('every export in abi.mjs is declared in the header, and vice versa', () => {
  const declared = [...header.matchAll(/^(?:int|void|char\*) (bib_\w+)\(/gm)].map((m) => m[1]);
  assert.deepEqual(new Set(EXPORTS), new Set(declared));
});

test('every hook in abi.mjs appears in the header hook section with its scope', () => {
  const hookSection = header.slice(header.indexOf('Hooks (engine'));
  for (const [scope, names] of Object.entries(HOOKS))
    for (const name of names) {
      const line = new RegExp(`${name}\\([^)]*\\)?[\\s\\S]{0,120}?\\[${scope}\\]`);
      assert.match(hookSection, line, `${name} [${scope}]`);
    }
  // No hook named in the header is missing from abi.mjs.
  const all = [...HOOKS.page, ...HOOKS.worker];
  for (const m of hookSection.matchAll(/^ \* (bib\w+)\(/gm))
    assert.ok(all.includes(m[1]), `header hook ${m[1]} missing from abi.mjs`);
});
