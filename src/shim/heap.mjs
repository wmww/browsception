// Shared-heap marshalling helpers (ownership rules: src/abi/bib_abi.h).
// `module` is the Module-shaped engine interface: needs HEAPU8,
// _bib_wasm_alloc, _bib_wasm_free. Works for both the real Emscripten Module
// and the tier-1 stub engine.

const dec = new TextDecoder();
const enc = new TextEncoder();

// Read a NUL-terminated UTF-8 string at ptr (does not free).
export function readCString(module, ptr) {
  const heap = module.HEAPU8;
  let end = ptr;
  while (heap[end] !== 0) end++;
  return dec.decode(heap.subarray(ptr, end));
}

// Copy `len` bytes out of the heap (does not free).
export function readBytes(module, ptr, len) {
  return module.HEAPU8.slice(ptr, ptr + len);
}

// Allocate and write bytes; ownership of the returned ptr transfers to the
// callee per ABI rules.
export function allocBytes(module, bytes) {
  const ptr = module._bib_wasm_alloc(bytes.length);
  module.HEAPU8.set(bytes, ptr);
  return ptr;
}

// Allocate and write a NUL-terminated UTF-8 string.
export function allocCString(module, str) {
  const bytes = enc.encode(str);
  const ptr = module._bib_wasm_alloc(bytes.length + 1);
  module.HEAPU8.set(bytes, ptr);
  module.HEAPU8[ptr + bytes.length] = 0;
  return ptr;
}
