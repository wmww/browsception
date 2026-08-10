// Viewer bootstrap. Real engine hosting lands with 1.2b/1.3; today this boots
// the fetch bridge against either the stub engine (?stub=1, used by tier-1
// tests) or nothing.

import { ABI_VERSION } from '../abi/abi.mjs';
import { Bridge } from '../shim/bridge.mjs';
import { RedirectCapture } from '../shim/redirect-capture.mjs';
import { createStubModule } from '../shim/engine-stub.mjs';

const params = new URLSearchParams(location.search);

// Test hook: (re)create a stub-engine + bridge pair with the given overrides.
// Tier-1 drives this via page.evaluate.
let current = null;
globalThis.__bsBoot = async (opts = {}) => {
  if (current) await current.bridge.dispose();
  const module = createStubModule(opts.stub ?? {});
  const bridge = new Bridge(module, {
    capture: new RedirectCapture(),
    userAgent: opts.userAgent ?? 'BrowsceptionBridge/0.1',
    guardOpts: opts.guardOpts,
    maxResponseBytes: opts.maxResponseBytes,
    idleTimeoutMs: opts.idleTimeoutMs,
    windowBytes: opts.windowBytes,
  });
  await bridge.init();
  current = { module, bridge };
  globalThis.__bs = {
    abiVersion: ABI_VERSION,
    request: (req) => module.stub.request(req),
    cancel: (id) => module.stub.cancel(id),
    liveAllocs: () => module.stub.liveAllocs(),
  };
  return true;
};

if (params.has('stub')) {
  await __bsBoot();
  document.getElementById('boot').textContent = 'bridge up (stub engine)';
}
