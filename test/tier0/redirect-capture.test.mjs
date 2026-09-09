// Tier 0: RedirectCapture event bookkeeping, against a fake chrome.webRequest.
// The load-bearing case is a redirect the network stack synthesizes (HSTS
// upgrade, DNR redirect): onBeforeRedirect fires with no onHeadersReceived at
// all, and missing it left the bridge reporting a bare network failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RedirectCapture, isRedirectEntry, setCookiesOf } from '../../src/shim/redirect-capture.mjs';

const ORIGIN = 'chrome-extension://abcd';
const URL_A = 'https://app.example/a';

// Chrome shape by default: `initiator` on details, 'extraHeaders' advertised
// (and required — without it Chrome hides Set-Cookie). firefox: true models
// Firefox — no extraHeaders option (the string is rejected there), the
// requesting page named by `originUrl` instead of `initiator`.
function fakeChrome({ firefox = false } = {}) {
  const listeners = { onHeadersReceived: [], onBeforeRedirect: [] };
  const event = (k) => ({
    addListener: (fn, filter, extra) => {
      assert.deepEqual(filter.types, ['xmlhttprequest']);
      assert.ok(extra.includes('responseHeaders'));
      if (firefox) assert.ok(!extra.includes('extraHeaders'), 'Firefox rejects extraHeaders');
      else assert.ok(extra.includes('extraHeaders'));
      listeners[k].push(fn);
    },
    removeListener: (fn) => {
      const i = listeners[k].indexOf(fn);
      if (i >= 0) listeners[k].splice(i, 1);
    },
  });
  const who = firefox ? { originUrl: `${ORIGIN}/ext/viewer.html?url=x` } : { initiator: ORIGIN };
  return {
    webRequest: {
      onHeadersReceived: event('onHeadersReceived'),
      onBeforeRedirect: event('onBeforeRedirect'),
      ...(firefox ? {} : { OnHeadersReceivedOptions: { EXTRA_HEADERS: 'extraHeaders' } }),
    },
    fire: (k, details) => listeners[k].slice().forEach((fn) => fn({ ...who, ...details })),
    listenerCount: () => listeners.onHeadersReceived.length + listeners.onBeforeRedirect.length,
  };
}

const started = (opts) => {
  const chrome = fakeChrome(opts);
  const capture = new RedirectCapture();
  capture.start(ORIGIN, chrome);
  return { chrome, capture };
};
const hdrs = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));

test('server redirect: exactly one entry, resolved Location + hop Set-Cookie', async () => {
  const { chrome, capture } = started();
  const responseHeaders = hdrs({
    'Content-Type': 'text/plain',
    'Set-Cookie': 'hop=2; Path=/',
    Location: '/final',
  });
  chrome.fire('onHeadersReceived', { requestId: '1', url: URL_A, statusCode: 302, responseHeaders });
  chrome.fire('onBeforeRedirect', {
    requestId: '1', url: URL_A, statusCode: 302, responseHeaders,
    redirectUrl: 'https://app.example/final',
  });
  const entry = await capture.take(URL_A, 10);
  assert.equal(entry.status, 302);
  assert.deepEqual(setCookiesOf(entry), ['hop=2; Path=/']);
  const h = Object.fromEntries(entry.headers);
  assert.equal(h.location, 'https://app.example/final', 'relative Location resolved');
  assert.equal(entry.headers.filter(([k]) => k === 'location').length, 1);
  assert.equal(await capture.take(URL_A, 10), null, 'one fetch, one entry');
});

// Firefox never fires onBeforeRedirect for a redirect:'error' fetch (verified
// 2026-09-09, Firefox 155): the 3xx must be complete from onHeadersReceived
// alone, with the Location as the server sent it.
test('firefox: a server redirect is complete from onHeadersReceived alone', async () => {
  const { chrome, capture } = started({ firefox: true });
  chrome.fire('onHeadersReceived', {
    requestId: '1', url: URL_A, statusCode: 302,
    responseHeaders: hdrs({ 'Set-Cookie': 'hop=2; Path=/', Location: '/final' }),
  });
  const entry = await capture.take(URL_A, 10);
  assert.equal(entry.status, 302);
  assert.deepEqual(setCookiesOf(entry), ['hop=2; Path=/']);
  assert.equal(Object.fromEntries(entry.headers).location, '/final');
  assert.equal(await capture.take(URL_A, 10), null, 'one fetch, one entry');
  // Another extension page's fetch (originUrl elsewhere) is not ours.
  chrome.fire('onHeadersReceived', {
    originUrl: 'moz-extension://other/x.html', requestId: '2', url: URL_A, statusCode: 200, responseHeaders: [],
  });
  assert.equal(await capture.take(URL_A, 10), null);
});

test('stack-synthesized redirect (HSTS/DNR): onBeforeRedirect alone still yields an entry', async () => {
  const { chrome, capture } = started();
  chrome.fire('onBeforeRedirect', {
    requestId: '1', url: 'http://wikipedia.org/', statusCode: 307, responseHeaders: [],
    redirectUrl: 'https://wikipedia.org/',
  });
  const entry = await capture.take('http://wikipedia.org/', 10);
  assert.equal(entry.status, 307);
  assert.deepEqual(entry.headers, [['location', 'https://wikipedia.org/']]);
});

test('non-redirect response is captured for its Set-Cookie', async () => {
  const { chrome, capture } = started();
  chrome.fire('onHeadersReceived', {
    requestId: '1', url: URL_A, statusCode: 200,
    responseHeaders: hdrs({ 'Set-Cookie': 'a=1; HttpOnly' }),
  });
  const entry = await capture.take(URL_A, 10);
  assert.equal(entry.status, 200);
  assert.deepEqual(setCookiesOf(entry), ['a=1; HttpOnly']);
});

test('3xx without Location is an ordinary response (no onBeforeRedirect follows)', async () => {
  const { chrome, capture } = started();
  chrome.fire('onHeadersReceived', {
    requestId: '1', url: URL_A, statusCode: 302,
    responseHeaders: hdrs({ 'Set-Cookie': 'a=1' }),
  });
  const entry = await capture.take(URL_A, 10);
  assert.equal(entry.status, 302);
  assert.deepEqual(setCookiesOf(entry), ['a=1']);
});

test('other initiators are ignored', async () => {
  const { chrome, capture } = started();
  chrome.fire('onHeadersReceived', {
    initiator: 'https://evil.example', requestId: '1', url: URL_A, statusCode: 200, responseHeaders: [],
  });
  chrome.fire('onBeforeRedirect', {
    initiator: 'https://evil.example', requestId: '2', url: URL_A, statusCode: 302,
    responseHeaders: [], redirectUrl: 'https://evil.example/x',
  });
  assert.equal(await capture.take(URL_A, 10), null);
});

test('take() before the event resolves when it arrives; same-URL entries are FIFO', async () => {
  const { chrome, capture } = started();
  const pending = capture.take(URL_A, 1000);
  chrome.fire('onHeadersReceived', { requestId: '1', url: URL_A, statusCode: 200, responseHeaders: [] });
  chrome.fire('onHeadersReceived', { requestId: '2', url: URL_A, statusCode: 500, responseHeaders: [] });
  assert.equal((await pending).status, 200);
  assert.equal((await capture.take(URL_A, 10)).status, 500);
});

test('keys are normalized: the engine URL and Chromium\'s form must agree', async () => {
  // Chromium reports the URL it normalized; the engine hands the bridge its
  // own string. Mismatch = dropped Set-Cookie + a redirect read as a network
  // failure, so both sides key on the WHATWG form.
  const pairs = [
    ['https://app.example:443/a', 'https://app.example/a'],
    ['https://app.example/x/../a', 'https://app.example/a'],
    ['https://app.example/a?q=b c', 'https://app.example/a?q=b%20c'],
    ['https://app.example/café', 'https://app.example/caf%C3%A9'],
    ['https://APP.example/a', 'https://app.example/a'],
  ];
  for (const [engineURL, chromeURL] of pairs) {
    const { chrome, capture } = started();
    chrome.fire('onHeadersReceived', {
      requestId: '1', url: chromeURL, statusCode: 200,
      responseHeaders: hdrs({ 'Set-Cookie': 'a=1' }),
    });
    const entry = await capture.take(engineURL, 10);
    assert.ok(entry, `${engineURL} did not match ${chromeURL}`);
    assert.equal(entry.status, 200);
  }
});

test('unparseable URLs fall back to the raw key', async () => {
  const { chrome, capture } = started();
  chrome.fire('onHeadersReceived', { requestId: '1', url: 'not a url', statusCode: 200, responseHeaders: [] });
  assert.equal((await capture.take('not a url', 10)).status, 200);
});

test('discard() drops the entry a finished request never claimed', async () => {
  const { chrome, capture } = started();
  chrome.fire('onHeadersReceived', {
    requestId: '1', url: URL_A, statusCode: 200, responseHeaders: hdrs({ 'Set-Cookie': 'stale=1' }),
  });
  assert.equal(capture.pending(), 1);
  capture.discard(URL_A);
  assert.equal(capture.pending(), 0);
  // ...and the next request for the same URL gets ITS OWN entry.
  chrome.fire('onHeadersReceived', {
    requestId: '2', url: URL_A, statusCode: 200, responseHeaders: hdrs({ 'Set-Cookie': 'fresh=2' }),
  });
  assert.deepEqual(setCookiesOf(await capture.take(URL_A, 10)), ['fresh=2']);
});

test('discard() also swallows an entry that arrives after the request ended', async () => {
  const { chrome, capture } = started();
  capture.discard(URL_A, 200);
  chrome.fire('onHeadersReceived', {
    requestId: '1', url: URL_A, statusCode: 200, responseHeaders: hdrs({ 'Set-Cookie': 'stale=1' }),
  });
  assert.equal(capture.pending(), 0);
  assert.equal(await capture.take(URL_A, 10), null);
});

test('unclaimed entries are swept, so queues cannot grow without bound', async () => {
  const chrome = fakeChrome();
  const capture = new RedirectCapture({ maxAgeMs: 0, sweepIntervalMs: 0 });
  capture.start(ORIGIN, chrome);
  const fire = (url) =>
    chrome.fire('onHeadersReceived', { requestId: '1', url, statusCode: 200, responseHeaders: [] });
  fire(URL_A);
  assert.equal(capture.pending(), 1, 'the first push cannot sweep itself');
  fire('https://app.example/b');
  assert.equal(capture.pending(), 1, 'the stale entry went, the new one stayed');
});

test('stop() unregisters both listeners and drops queued entries', async () => {
  const { chrome, capture } = started();
  assert.equal(chrome.listenerCount(), 2);
  chrome.fire('onHeadersReceived', { requestId: '1', url: URL_A, statusCode: 200, responseHeaders: [] });
  capture.stop();
  assert.equal(chrome.listenerCount(), 0);
  assert.equal(await capture.take(URL_A, 10), null);
});

// Firefox reports repeated headers as ONE value joined with "\n" (verified
// 2026-09-09, Firefox 155: google.com's 8 Set-Cookie lines arrived as a single
// string). The engine rejects any header value carrying a newline, so a page
// that set two cookies failed with "Response contained invalid HTTP headers".
test('firefox: newline-joined repeated headers are split back into one entry per line', async () => {
  const { chrome, capture } = started({ firefox: true });
  chrome.fire('onHeadersReceived', {
    requestId: '1', url: URL_A, statusCode: 200,
    responseHeaders: hdrs({ 'Set-Cookie': 'a=1; Path=/\nb=2; Path=/; HttpOnly\n', 'X-Empty': '' }),
  });
  const entry = await capture.take(URL_A, 10);
  assert.deepEqual(setCookiesOf(entry), ['a=1; Path=/', 'b=2; Path=/; HttpOnly']);
  assert.deepEqual(entry.headers.filter(([k]) => k === 'x-empty'), [['x-empty', '']], 'empty values survive');
  assert.ok(entry.headers.every(([, v]) => !v.includes('\n')));
});

// Firefox's HSTS upgrade (verified 2026-09-09, Firefox 155): onBeforeRedirect
// fires with statusCode 0, then the SAME request continues to the https
// target inside the same fetch — redirect:'error' does not stop it. The
// bridge must see a redirect entry (the 307 Chrome reports for the same
// thing), and nothing from the continuation, which the engine never asked
// for: it re-issues the target itself.
test('firefox: an HSTS upgrade is a 307 entry; the continued request\'s events are dropped', async () => {
  const { chrome, capture } = started({ firefox: true });
  chrome.fire('onBeforeRedirect', {
    requestId: '1', url: 'http://wikipedia.org/', statusCode: 0, responseHeaders: [],
    redirectUrl: 'https://wikipedia.org/',
  });
  chrome.fire('onHeadersReceived', {
    requestId: '1', url: 'https://wikipedia.org/', statusCode: 301,
    responseHeaders: hdrs({ 'Set-Cookie': 'target=1', Location: 'https://www.wikipedia.org/' }),
  });
  const entry = await capture.take('http://wikipedia.org/', 10);
  assert.equal(entry.status, 307);
  assert.deepEqual(entry.headers, [['location', 'https://wikipedia.org/']]);
  assert.ok(isRedirectEntry(entry));
  assert.equal(await capture.take('https://wikipedia.org/', 10), null, 'continuation not queued');
  assert.equal(capture.pending(), 0);
  // The engine's own request for the target gets its own entry.
  chrome.fire('onHeadersReceived', {
    requestId: '2', url: 'https://wikipedia.org/', statusCode: 301,
    responseHeaders: hdrs({ 'Set-Cookie': 'target=2', Location: 'https://www.wikipedia.org/' }),
  });
  const own = await capture.take('https://wikipedia.org/', 10);
  assert.deepEqual(setCookiesOf(own), ['target=2']);
});

test('isRedirectEntry: 3xx with a Location only', () => {
  assert.ok(isRedirectEntry({ status: 302, headers: [['location', '/x']] }));
  assert.ok(!isRedirectEntry({ status: 302, headers: [] }));
  assert.ok(!isRedirectEntry({ status: 200, headers: [['location', '/x']] }));
  assert.ok(!isRedirectEntry(null));
});
