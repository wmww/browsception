// JS mirror of src/abi/bib_abi.h — the engine ⇄ shim ABI (Phase 1.1).
//
// bib_abi.h is the source of truth; test/tier0/abi.test.mjs asserts this file
// matches it. Shim code imports constants from here, never hardcodes them.

export const ABI_VERSION = 1;

// JS → engine exports (Module._<name>). Fire-and-forget via engine-thread
// proxy except bib_abi_version / bib_wasm_alloc / bib_wasm_free, which run on
// the calling thread.
export const EXPORTS = [
  'bib_abi_version',
  'bib_tick',
  'bib_pump',
  'bib_load_url',
  'bib_stop',
  'bib_reload',
  'bib_go',
  'bib_persist_now',
  'bib_set_visible',
  'bib_set_viewport',
  'bib_wasm_alloc',
  'bib_wasm_free',
  'bib_mouse_move',
  'bib_mouse_button',
  'bib_wheel',
  'bib_key',
  'bib_set_focus',
  'bib_net_response',
  'bib_net_data',
  'bib_net_done',
  'bib_net_fail',
  'bib_net_redirect',
  'bib_query',
];

// engine → JS hooks on Module, by scope. [page] = viewer main thread
// (MAIN_THREAD_ASYNC_EM_ASM), [worker] = engine pthread's worker global.
export const HOOKS = {
  page: [
    'bibNetBegin',
    'bibNetCancel',
    'bibNetAck',
    'bibFrame',
    'bibChrome',
    'bibQueryResult',
    'bibPersist',
    'bibReady',
  ],
  worker: ['bibWakeUp', 'bibArmTimer'],
};

// Input modifier bits (BIB_MOD_*).
export const MOD = { SHIFT: 1, CTRL: 2, ALT: 4, META: 8 };

// bib_key type values (BIB_KEY_*).
export const KEY = { RAWDOWN: 0, UP: 1, CHAR: 2 };

// bib_net_fail error kinds (BIB_NET_ERR_*).
export const NET_ERR = {
  GUARD: 1,
  NETWORK: 2,
  TIMEOUT: 3,
  TOO_LARGE: 4,
  CANCELLED: 5,
  PROTOCOL: 6,
};

// Per-request unacked-bytes window for bib_net_data flow control
// (BIB_NET_WINDOW_BYTES).
export const NET_WINDOW_BYTES = 4 * 1024 * 1024;

// bibChrome signal kinds (v1; reserved fast-follows excluded).
export const CHROME_KINDS = ['title', 'url', 'progress', 'cursor', 'hover', 'favicon'];

// bib_query kinds (v1). 'eval' exists in dev builds only.
export const QUERY_KINDS = ['text', 'state', 'metrics', 'eval'];
