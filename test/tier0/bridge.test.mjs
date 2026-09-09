// Tier 0: Bridge decisions that no real browser reproduces on demand, against
// a stubbed fetch/chrome/capture. The load-bearing case: Firefox follows an
// HSTS upgrade inside the fetch itself (redirect-capture.mjs header), so the
// fetch RESOLVES with the target's response while the capture holds a 307 for
// the URL the engine asked for. The engine must get the hop, never the body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../../src/shim/bridge.mjs';
import { NET_ERR } from '../../src/abi/abi.mjs';

const chromeApi = {
  runtime: { getURL: () => 'moz-extension://0123-4567/' },
  declarativeNetRequest: { updateSessionRules: async () => {} },
};

function fakeCapture(entries) {
  const taken = [];
  const discarded = [];
  return {
    taken,
    discarded,
    start() {},
    stop() {},
    pending: () => 0,
    take: async (url) => (taken.push(url), entries.get(url) ?? null),
    discard: (url) => discarded.push(url),
  };
}

function fakeEngine() {
  const calls = [];
  return {
    calls,
    netResponse: (id, json) => calls.push(['response', id, JSON.parse(json)]),
    netData: (id, bytes) => calls.push(['data', id, bytes.length]),
    netDone: (id) => calls.push(['done', id]),
    netFail: (id, kind, message) => calls.push(['fail', id, kind, message]),
    netRedirect: (id, status, json) => calls.push(['redirect', id, status, JSON.parse(json)]),
  };
}

// A Response whose body reports whether anyone cancelled it.
function bodyResponse(text, init) {
  const state = { cancelled: false };
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { res: new Response(stream, init), state };
}

async function run({ fetchImpl, entries, req }) {
  const engine = fakeEngine();
  const capture = fakeCapture(entries);
  const failures = [];
  const bridge = new Bridge(engine, {
    capture,
    chromeApi,
    userAgent: 'ua',
    onMainLoadFailed: (...a) => failures.push(a),
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    engine.onNetBegin({ id: 1, method: 'GET', url: req.url, headers: [], main: req.main ?? 0 }, null);
    // Everything the bridge does is a handful of awaits deep.
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
  } finally {
    globalThis.fetch = realFetch;
  }
  return { engine, capture, failures };
}

test('a resolved fetch behind an internal redirect is reported as the hop, body cancelled', async () => {
  const { res, state } = bodyResponse('<html>target</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  const entries = new Map([['http://wikipedia.org/', { status: 307, headers: [['location', 'https://wikipedia.org/']] }]]);
  const { engine, failures } = await run({ fetchImpl: async () => res, entries, req: { url: 'http://wikipedia.org/', main: 1 } });
  assert.deepEqual(engine.calls, [
    ['redirect', 1, 307, { status: 307, url: 'http://wikipedia.org/', headers: [['location', 'https://wikipedia.org/']] }],
  ]);
  assert.ok(state.cancelled, 'the target body is not streamed');
  assert.deepEqual(failures, []);
});

test('a rejected fetch with a redirect entry is the hop; without one, a network failure', async () => {
  const reject = async () => {
    throw new TypeError('NetworkError when attempting to fetch resource.');
  };
  const entries = new Map([['http://a.example/', { status: 301, headers: [['location', 'https://a.example/']] }]]);
  let r = await run({ fetchImpl: reject, entries, req: { url: 'http://a.example/', main: 1 } });
  assert.equal(r.engine.calls[0][0], 'redirect');
  assert.equal(r.engine.calls[0][2], 301);

  r = await run({ fetchImpl: reject, entries: new Map(), req: { url: 'http://b.example/', main: 1 } });
  assert.deepEqual(r.engine.calls, [['fail', 1, NET_ERR.NETWORK, 'NetworkError when attempting to fetch resource.']]);
  assert.equal(r.failures.length, 1, 'top-level failure surfaces to the viewer');
});

test('an ordinary 200 streams, with the captured Set-Cookie merged in', async () => {
  const { res } = bodyResponse('hello', { status: 200, headers: { 'content-type': 'text/plain', 'content-length': '5' } });
  const entries = new Map([['https://a.example/', { status: 200, headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2']] }]]);
  const { engine } = await run({ fetchImpl: async () => res, entries, req: { url: 'https://a.example/' } });
  assert.deepEqual(engine.calls.map((c) => c[0]), ['response', 'data', 'done']);
  const headers = engine.calls[0][2].headers;
  assert.deepEqual(headers.filter(([k]) => k === 'set-cookie').map(([, v]) => v), ['a=1', 'b=2']);
  assert.ok(!headers.some(([k]) => k === 'content-length'), 'length/encoding headers stripped');
});
