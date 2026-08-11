// Activation/mode/list state (notes/ui.md), shared by SW, viewer, popup,
// and options. storage.sync holds only explicitly-set keys; readers overlay
// defaults. Shipped default: active, whitelist mode (sandbox-by-default;
// empty whitelist → every http(s) site runs nested). Must agree with the
// manifest's static-ruleset enabled flag (tools/gen-ext.mjs) so a fresh
// install intercepts before the SW ever runs.

export const DEFAULT_STATE = {
  active: true,
  mode: 'whitelist',
  whitelist: [],
  blacklist: [],
  allowPrivateNetwork: false, // guard override (options page; networking.md)
};

export async function getState(chromeApi = globalThis.chrome) {
  return {
    ...DEFAULT_STATE,
    ...(await chromeApi.storage.sync.get(Object.keys(DEFAULT_STATE))),
  };
}

// Subscribe to state changes; returns an unsubscribe function.
export function onStateChanged(fn, chromeApi = globalThis.chrome) {
  const listener = (_, area) => {
    if (area === 'sync') getState(chromeApi).then(fn);
  };
  chromeApi.storage.onChanged.addListener(listener);
  return () => chromeApi.storage.onChanged.removeListener(listener);
}
