// Observational webRequest capture for bridge fetches (notes/bridge-probe.md
// decisions 1–2). fetch() cannot see Set-Cookie at all, and redirect:'error'
// rejects without exposing the 3xx — but onHeadersReceived (with
// ['responseHeaders','extraHeaders']) delivers status, Location, and every
// Set-Cookie (incl. HttpOnly) before the abort. We record per-URL FIFO queues
// (URL-keyed correlation is correct for the jar; FIFO covers concurrent
// same-URL requests) and the bridge takes exactly one entry per fetch.

export class RedirectCapture {
  #queues = new Map(); // url -> [{status, headers: [[k,v],...]}]
  #waiters = new Map(); // url -> [resolve, ...]
  #listener = null;

  /** @param {string} origin only requests initiated by this origin are kept */
  start(origin, chromeApi = globalThis.chrome) {
    this.#listener = (details) => {
      if (details.initiator !== origin) return;
      const entry = {
        status: details.statusCode,
        headers: (details.responseHeaders ?? []).map((h) => [
          h.name.toLowerCase(),
          h.value ?? '',
        ]),
      };
      const q = this.#queues.get(details.url);
      const w = this.#waiters.get(details.url);
      if (w?.length) w.shift()(entry);
      else if (q) q.push(entry);
      else this.#queues.set(details.url, [entry]);
    };
    chromeApi.webRequest.onHeadersReceived.addListener(
      this.#listener,
      { urls: ['http://*/*', 'https://*/*'], types: ['xmlhttprequest'] },
      ['responseHeaders', 'extraHeaders'],
    );
    this.chromeApi = chromeApi;
  }

  stop() {
    if (this.#listener) this.chromeApi.webRequest.onHeadersReceived.removeListener(this.#listener);
    this.#listener = null;
    this.#queues.clear();
    this.#waiters.clear();
  }

  /**
   * Take the next captured entry for `url`, waiting up to timeoutMs (event
   * delivery can trail the fetch promise). Resolves null on timeout.
   * @returns {Promise<{status: number, headers: [string,string][]} | null>}
   */
  take(url, timeoutMs = 800) {
    const q = this.#queues.get(url);
    if (q?.length) {
      const entry = q.shift();
      if (!q.length) this.#queues.delete(url);
      return Promise.resolve(entry);
    }
    return new Promise((resolve) => {
      let waiters = this.#waiters.get(url);
      if (!waiters) this.#waiters.set(url, (waiters = []));
      const timer = setTimeout(() => {
        const i = waiters.indexOf(wrapped);
        if (i >= 0) waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      const wrapped = (entry) => {
        clearTimeout(timer);
        resolve(entry);
      };
      waiters.push(wrapped);
    });
  }
}

// Pull every set-cookie value out of a captured header list.
export function setCookiesOf(entry) {
  return entry.headers.filter(([k]) => k === 'set-cookie').map(([, v]) => v);
}

export function locationOf(entry) {
  return entry.headers.find(([k]) => k === 'location')?.[1] ?? null;
}
