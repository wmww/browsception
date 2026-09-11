// JS mirror of src/abi/bib_abi.h — the engine ⇄ shim ABI (Phase 1.1).
//
// bib_abi.h is the source of truth; test/tier0/abi.test.mjs asserts this file
// matches it. Shim code imports constants from here, never hardcodes them.

export const ABI_VERSION = 1;

// JS → engine exports (Module._<name>), fire-and-forget. The worker host
// (src/ext/engine-worker.js) calls them; the viewer names them through
// EngineLink.call(name, ...args).
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
  'bib_present_done',
  'bib_mouse_move',
  'bib_mouse_button',
  'bib_wheel',
  'bib_key',
  'bib_set_focus',
  'bib_edit',
  'bib_net_response',
  'bib_net_data',
  'bib_net_done',
  'bib_net_fail',
  'bib_net_redirect',
  'bib_query',
  'bib_crash', // dev builds only
];

// engine → JS hooks on Module, by scope. [host] = the engine worker's Module
// (src/ext/engine-worker.js; the page's Module in the proxy link), [worker] =
// the pre-js's own hooks next to the engine.
export const HOOKS = {
  host: [
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

// Load-failure kinds (BIB_NET_ERR_*). 1-6 ride bib_net_fail; ENGINE is
// engine→shim only, on the bibChrome "loadfailed" signal.
export const NET_ERR = {
  GUARD: 1,
  NETWORK: 2,
  TIMEOUT: 3,
  TOO_LARGE: 4,
  CANCELLED: 5,
  PROTOCOL: 6,
  ENGINE: 7,
};

// Per-request unacked-bytes window for bib_net_data flow control
// (BIB_NET_WINDOW_BYTES).
export const NET_WINDOW_BYTES = 4 * 1024 * 1024;

// bibChrome signal kinds (v1; reserved fast-follows excluded).
export const CHROME_KINDS = ['title', 'url', 'progress', 'cursor', 'hover', 'favicon', 'loadfailed', 'clipboard'];

// bibChrome "url" nav kinds: what the navigation did to the engine's
// back/forward list. The viewer mirrors it into real tab history.
export const NAV_KINDS = ['new', 'replace', 'traverse', 'reload'];

// bib_query kinds (v1). 'eval' exists in dev builds only.
export const QUERY_KINDS = ['text', 'state', 'metrics', 'eval'];
