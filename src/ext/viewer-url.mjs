// The viewer `?url=` wire format — sole owner of parsing and building it.
//
// Contract: everything from the first `[?&]url=` to end-of-string is the
// target, RAW. DNR's `\0` substitution is un-encoded, and the target carries
// its own `?`, `&` and `#`, so URLSearchParams would truncate it. Viewer
// params must therefore precede `url=`.
//
// Tolerated legacy/manual form: a percent-encoded ABSOLUTE http(s) URL,
// detected by the slice starting `https%3A`/`http%3A`. The detection is
// unambiguous — a raw absolute target always starts literally `http`, and
// nothing http(s)-valid starts with the encoded form — and it matters because
// the sweep's input is any tab URL in the browser (old bookmarks, hand-typed
// URLs), not just URLs we wrote. Anything else passes through raw and is
// refused later by an isHttpUrl gate.

const URL_PARAM = /[?&]url=/;

/**
 * The `?url=` target of a viewer URL or search string, or null.
 * @param {string} urlOrSearch full tab URL, or location.search
 * @param {string} [rawHash] fragment to glue back onto a RAW target. Full tab
 *   URLs already include it in the slice; location.search does not, and a raw
 *   target's own `#frag` lands as OUR fragment (the tab URLs we write back
 *   carry it). An encoded target's fragment is inside the decoded string.
 */
export function sliceTarget(urlOrSearch, rawHash = '') {
  const m = URL_PARAM.exec(urlOrSearch);
  if (!m) return null;
  const raw = urlOrSearch.slice(m.index + m[0].length);
  if (!/^https?%3A/i.test(raw)) return raw + rawHash;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // malformed %-escape: the raw slice is all we have
  }
}

/** Target URL of a viewer tab, or null if the URL isn't one. */
export function viewerTarget(url, viewerBase) {
  if (!url.startsWith(`${viewerBase}?`)) return null;
  return sliceTarget(url);
}

/**
 * The viewer's OWN params (everything before `url=`), as a bare param string
 * for URLSearchParams / viewerURLFor.
 */
export function viewerParams(urlOrSearch) {
  const m = URL_PARAM.exec(urlOrSearch);
  const head = m ? urlOrSearch.slice(0, m.index) : urlOrSearch;
  return head.startsWith('?') ? head.slice(1) : head;
}

/** Canonical (raw) viewer URL for `target`. `params` is bare: 'blit=2d'. */
export function viewerURLFor(viewerBase, target, params = '') {
  return `${viewerBase}?${params ? `${params}&` : ''}url=${target}`;
}

/**
 * May this URL cross from sandbox-world to a host-world sink (tabs.update,
 * location.replace)? Duplicated as a private helper in src/shim/bridge.mjs,
 * which must not import extension-layer modules — keep the two in sync.
 */
export function isHttpUrl(url) {
  let protocol;
  try {
    ({ protocol } = new URL(url));
  } catch {
    return false;
  }
  return protocol === 'http:' || protocol === 'https:';
}
