# Vendored dev-harness deps bypass the project's dep conventions

`engine/WebkitWasm/web/vendor/` came in verbatim with the fork absorption and doesn't follow
how this repo otherwise handles deps (npm + lockfile for JS; gitignored `third_party/` fetched
by pinned script for engine bulk):

- **binaryen.js (13 MB)** — by far the largest tracked file (next is 140 KB). Live, not dead:
  browser.html's guest-wasm wasm2js shim imports it (dev harness only; the extension ships no
  guest-wasm — stage-engine copies just embedder.js/wasm). Published on npm as `binaryen`;
  could be an exact-pinned devDependency (v130 — the harness has v130-specific workarounds:
  multi-table FATAL, bulk-memory abort, memory-packing extraction breakage) served/copied from
  node_modules by the dev server. Note: the blob is already in history (df282cd), so removal
  doesn't shrink clones — the win is integrity-pinned updates and diff hygiene. Becomes more
  important if roadmap item 2 (ship the wasm shim in the extension) lands.
- **LICENSING.md** — its third-party table is framed "fetched, not redistributed by us", which
  is wrong for binaryen.js (it carries an inline Apache-2.0 header). Needs a row for it.

Everything else is consistent: package-lock tracked, node_modules/third_party/build ignored,
no other copied-in third-party code in src/.
