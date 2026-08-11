// The fetch bridge (notes/networking.md; ABI: src/abi/bib_abi.h).
//
// Engine side emits requests through the bibNetBegin hook; this class guards
// them, performs the privileged fetch, and streams results back through the
// bib_net_* exports with credit-window flow control. Redirects are
// engine-driven: fetch(redirect:'error') + webRequest capture recovers the
// 3xx, reported via bib_net_redirect; the engine issues the next hop itself.
//
// `module` is the Module-shaped engine interface (real Emscripten Module or
// the tier-1 stub): HEAPU8, _bib_wasm_alloc/_bib_wasm_free, and the bib_net_*
// exports. The bridge installs the bibNet* hooks on it; it must be
// constructed before the engine script loads.

import { NET_ERR, NET_WINDOW_BYTES } from '../abi/abi.mjs';
import { evaluateRequest, CAPS } from './guard.mjs';
import { readCString, readBytes, allocCString, allocBytes } from './heap.mjs';
import { setCookiesOf, locationOf } from './redirect-capture.mjs';
import { BRIDGE_RULE, baseSessionRules, perRequestHeaderRule } from '../ext/bridge-rules.mjs';

// Fetch-forbidden request headers the engine may legitimately send; these
// ride via the per-request DNR rule instead of the fetch init.
const DNR_HEADERS = new Set(['cookie', 'referer', 'origin']);

// Forbidden headers we silently drop (the host fetch stack owns them).
// prettier-ignore
const DROP_HEADERS = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers',
  'access-control-request-method', 'connection', 'content-length', 'cookie2',
  'date', 'dnt', 'expect', 'host', 'keep-alive', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'via', 'user-agent',
]);
const isDropped = (name) =>
  DROP_HEADERS.has(name) || name.startsWith('proxy-') || name.startsWith('sec-');

// Max bytes per bib_net_data call (bounds engine-side copies and keeps the
// credit window honest against coalesced fetch chunks).
const SLICE_BYTES = 64 * 1024;

export class Bridge {
  #inflight = new Map(); // reqId -> {ctrl, ruleId, unacked, ackWaiter, idleTimer}
  #nextRuleId = BRIDGE_RULE.PER_REQUEST_MIN_ID;
  #usedRuleIds = new Set();

  /**
   * @param {object} module Module-shaped engine interface
   * @param {{
   *   capture: import('./redirect-capture.mjs').RedirectCapture,
   *   userAgent: string,
   *   chromeApi?: typeof chrome,
   *   guardOpts?: {allowPrivateNetwork?: boolean},
   *   maxResponseBytes?: number,
   *   idleTimeoutMs?: number,
   *   windowBytes?: number,
   * }} opts
   */
  constructor(module, opts) {
    this.module = module;
    this.capture = opts.capture;
    this.userAgent = opts.userAgent;
    // 2.4 sandboxed->native boundary: called with the URL of every TOP-LEVEL
    // document request ("main":1 from the engine); returning 'native' cancels
    // the request engine-side and fires onNativeNavigation (the viewer then
    // navigates the real tab).
    this.navigationPolicy = opts.navigationPolicy ?? null;
    this.onNativeNavigation = opts.onNativeNavigation ?? null;
    this.chrome = opts.chromeApi ?? globalThis.chrome;
    this.guardOpts = opts.guardOpts ?? {};
    this.maxResponseBytes = opts.maxResponseBytes ?? CAPS.MAX_RESPONSE_BYTES;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? CAPS.IDLE_TIMEOUT_MS;
    this.windowBytes = opts.windowBytes ?? NET_WINDOW_BYTES;
    this.extId = new URL(this.chrome.runtime.getURL('')).hostname;

    module.bibNetBegin = (ptr) => this.#begin(ptr);
    module.bibNetCancel = (id) => this.#cancel(id);
    module.bibNetAck = (id, bytes) => this.#ack(id, bytes);
  }

  async init() {
    this.capture.start(new URL(this.chrome.runtime.getURL('')).origin, this.chrome);
    await this.chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: baseSessionRules(this.extId, { userAgent: this.userAgent }).map((r) => r.id),
      addRules: baseSessionRules(this.extId, { userAgent: this.userAgent }),
    });
  }

  async dispose() {
    for (const [id, st] of this.#inflight) {
      st.ctrl.abort();
      this.#inflight.delete(id);
    }
    this.capture.stop();
    await this.chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [BRIDGE_RULE.BASE_ID, ...this.#usedRuleIds],
    });
  }

  // ------------------------------------------------------------- internals

  #fail(id, kind, message) {
    const st = this.#inflight.get(id);
    if (!st) return;
    this.module._bib_net_fail(id, kind, message ? allocCString(this.module, message) : 0);
    this.#finish(id);
  }

  #finish(id) {
    const st = this.#inflight.get(id);
    if (!st) return;
    this.#inflight.delete(id);
    clearTimeout(st.idleTimer);
    st.ackWaiter?.();
    if (st.ruleId != null) {
      this.#usedRuleIds.delete(st.ruleId);
      this.chrome.declarativeNetRequest
        .updateSessionRules({ removeRuleIds: [st.ruleId] })
        .catch(() => {});
    }
  }

  #allocRuleId() {
    const { PER_REQUEST_MIN_ID: min, PER_REQUEST_MAX_ID: max } = BRIDGE_RULE;
    do {
      this.#nextRuleId = this.#nextRuleId >= max - 1 ? min : this.#nextRuleId + 1;
    } while (this.#usedRuleIds.has(this.#nextRuleId));
    this.#usedRuleIds.add(this.#nextRuleId);
    return this.#nextRuleId;
  }

  async #begin(reqPtr) {
    const m = this.module;
    let req;
    try {
      req = JSON.parse(readCString(m, reqPtr));
    } finally {
      m._bib_wasm_free(reqPtr);
    }
    const body = req.bodyLen > 0 ? readBytes(m, req.bodyPtr, req.bodyLen) : null;
    if (req.bodyPtr) m._bib_wasm_free(req.bodyPtr);

    const id = req.id;
    const st = { ctrl: new AbortController(), ruleId: null, unacked: 0, ackWaiter: null };
    this.#inflight.set(id, st);

    if (req.main && this.navigationPolicy && this.navigationPolicy(req.url) === 'native') {
      this.#fail(id, NET_ERR.CANCELLED, 'native disposition');
      this.onNativeNavigation?.(req.url);
      return;
    }

    const verdict = evaluateRequest(req.url, this.guardOpts);
    if (!verdict.allow) return this.#fail(id, NET_ERR.GUARD, verdict.reason);

    // Partition engine headers: fetchable / DNR-carried / dropped.
    const fetchHeaders = [];
    const dnr = {};
    for (const [name, value] of req.headers ?? []) {
      const n = name.toLowerCase();
      if (DNR_HEADERS.has(n)) dnr[n] = value;
      else if (!isDropped(n)) fetchHeaders.push([name, value]);
    }
    const rule = Object.keys(dnr).length
      ? perRequestHeaderRule(this.#allocRuleId(), req.url, dnr, this.extId)
      : null;
    if (rule) {
      st.ruleId = rule.id;
      try {
        await this.chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
      } catch (e) {
        return this.#fail(id, NET_ERR.PROTOCOL, `dnr: ${e.message}`);
      }
    }

    let res;
    try {
      // credentials:'omit' is the load-bearing line (security.md): the host
      // jar/auth/client-certs never ride, structurally. cache:'no-store'
      // because the engine runs its own HTTP cache and a host cache hit would
      // skip webRequest, losing Set-Cookie capture.
      res = await fetch(req.url, {
        method: req.method ?? 'GET',
        headers: fetchHeaders,
        body,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrer: '',
        signal: st.ctrl.signal,
      });
    } catch (err) {
      if (!this.#inflight.has(id)) return; // cancelled meanwhile
      if (st.ctrl.signal.aborted) return this.#fail(id, NET_ERR.CANCELLED, null);
      // TypeError is either a network failure or the redirect:'error' abort —
      // the capture disambiguates (a 3xx was observed iff it was a redirect).
      const entry = await this.capture.take(req.url);
      if (entry && entry.status >= 300 && entry.status < 400) {
        const headers = { status: entry.status, url: req.url, headers: entry.headers };
        m._bib_net_redirect(id, entry.status, allocCString(m, JSON.stringify(headers)));
        this.#finish(id);
        return;
      }
      return this.#fail(id, NET_ERR.NETWORK, String(err?.message ?? err));
    }
    if (!this.#inflight.has(id)) return;

    // Merge captured Set-Cookie (invisible to fetch) into the header list.
    // Bodies arrive decoded — strip encoding/length headers per the ABI.
    const stripped = new Set(['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding']);
    const entry = await this.capture.take(req.url);
    const headers = [...res.headers.entries()].filter(([k]) => !stripped.has(k));
    if (entry) for (const v of setCookiesOf(entry)) headers.push(['set-cookie', v]);
    m._bib_net_response(
      id,
      allocCString(
        m,
        JSON.stringify({ status: res.status, statusText: res.statusText, url: res.url, headers }),
      ),
    );

    await this.#stream(id, st, res);
  }

  async #stream(id, st, res) {
    const m = this.module;
    const t0 = performance.now();
    let bytes = 0;
    let chunks = 0;
    let maxUnacked = 0;
    const armIdle = () => {
      clearTimeout(st.idleTimer);
      st.idleTimer = setTimeout(() => st.ctrl.abort('idle'), this.idleTimeoutMs);
    };
    armIdle();
    const reader = res.body?.getReader();
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (!this.#inflight.has(id)) return void reader.cancel().catch(() => {});
        if (done) break;
        armIdle();
        bytes += value.length;
        chunks++;
        if (bytes > this.maxResponseBytes) {
          st.ctrl.abort('too-large');
          return this.#fail(id, NET_ERR.TOO_LARGE, `cap ${this.maxResponseBytes}`);
        }
        // Deliver in bounded slices, honoring the credit window before each
        // slice, so a coalesced multi-MB fetch chunk can't overshoot it.
        for (let off = 0; off < value.length; off += SLICE_BYTES) {
          while (st.unacked >= this.windowBytes && this.#inflight.has(id))
            await new Promise((r) => (st.ackWaiter = r));
          if (!this.#inflight.has(id)) return void reader.cancel().catch(() => {});
          const slice = value.subarray(off, off + SLICE_BYTES);
          m._bib_net_data(id, allocBytes(m, slice), slice.length);
          st.unacked += slice.length;
          maxUnacked = Math.max(maxUnacked, st.unacked);
        }
      }
    } catch (err) {
      if (!this.#inflight.has(id)) return;
      const kind =
        st.ctrl.signal.reason === 'idle'
          ? NET_ERR.TIMEOUT
          : st.ctrl.signal.aborted
            ? NET_ERR.CANCELLED
            : NET_ERR.NETWORK;
      return this.#fail(id, kind, String(err?.message ?? err));
    }
    if (!this.#inflight.has(id)) return;
    const metrics = { bytes, chunks, ms: Math.round(performance.now() - t0), maxUnacked };
    m._bib_net_done(id, allocCString(m, JSON.stringify(metrics)));
    this.#finish(id);
  }

  #cancel(id) {
    const st = this.#inflight.get(id);
    if (!st) return;
    st.ctrl.abort();
    this.#fail(id, NET_ERR.CANCELLED, null);
  }

  #ack(id, bytes) {
    const st = this.#inflight.get(id);
    if (!st) return;
    st.unacked -= bytes;
    if (st.unacked < this.windowBytes) st.ackWaiter?.(), (st.ackWaiter = null);
  }
}
