// DNR session-rule generation for bridge fetches (notes/bridge-probe.md
// decisions 3–4). Pure functions; applied by the bridge, asserted by tier-0.
//
// Two layers, both scoped to our own fetches via
// `initiatorDomains: [extId]` + `resourceTypes: ['xmlhttprequest']`:
//
// 1. Base rule (priority 1, one per profile): set the User-Agent (the
//    engine's own string once the bridge has seen it — the wire must agree
//    with what guest JS reads from navigator.userAgent, or sites score the
//    mismatch as a bot), strip sec-ch-ua* client hints (they'd leak the host
//    browser), and strip Origin/Referer so the extension origin never leaks
//    to target sites when the engine didn't send those headers itself.
// 2. Per-request rule (priority 2, short-lived, exact urlFilter): carries the
//    fetch-forbidden headers the engine DID send — Cookie (engine jar),
//    Referer, Origin, and a User-Agent differing from the base rule's.
//    Added before the fetch, removed after its terminal event; never static,
//    so a redirect can never ride an engine cookie cross-origin (hops abort
//    under redirect:'error' anyway). Priority 2 beats the base rule's strips
//    per DNR's per-header highest-priority-wins conflict resolution.

export const BRIDGE_RULE = {
  BASE_ID: 9001,
  BASE_PRIORITY: 1,
  PER_REQUEST_PRIORITY: 2,
  PER_REQUEST_MIN_ID: 10000, // ids cycle in [MIN, MAX); collisions guarded by
  PER_REQUEST_MAX_ID: 100000, // the bridge's in-flight set
};

// Client-hint request headers that leak the host browser.
export const CLIENT_HINT_HEADERS = [
  'sec-ch-ua',
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness',
  'sec-ch-ua-full-version',
  'sec-ch-ua-full-version-list',
  'sec-ch-ua-mobile',
  'sec-ch-ua-model',
  'sec-ch-ua-platform',
  'sec-ch-ua-platform-version',
  'sec-ch-ua-wow64',
];

function bridgeCondition(extId) {
  return { initiatorDomains: [extId], resourceTypes: ['xmlhttprequest'] };
}

/** @param {{userAgent?: string|null}} o no userAgent → the host's rides */
export function baseSessionRules(extId, { userAgent = null } = {}) {
  return [
    {
      id: BRIDGE_RULE.BASE_ID,
      priority: BRIDGE_RULE.BASE_PRIORITY,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          ...(userAgent != null ? [{ header: 'user-agent', operation: 'set', value: userAgent }] : []),
          { header: 'origin', operation: 'remove' },
          { header: 'referer', operation: 'remove' },
          ...CLIENT_HINT_HEADERS.map((h) => ({ header: h, operation: 'remove' })),
        ],
      },
      condition: bridgeCondition(extId),
    },
  ];
}

/**
 * Per-request rule carrying engine-supplied forbidden headers.
 * Returns null when the request needs none (no rule churn for plain GETs).
 *
 * urlFilter uses exact anchors `|url|`. A literal `*` inside the URL would
 * widen the match, but the condition still confines it to bridge fetches on
 * the same origin prefix — worst case a cookie reaches a sibling bridge
 * request of the same origin, which the engine jar allowed anyway.
 * @param {number} id
 * @param {string} url
 * @param {{cookie?: string, referer?: string, origin?: string, 'user-agent'?: string}} h
 * @param {string} extId
 */
export function perRequestHeaderRule(id, url, h, extId) {
  const ops = [];
  for (const header of ['cookie', 'referer', 'origin', 'user-agent'])
    if (h[header] != null) ops.push({ header, operation: 'set', value: h[header] });
  if (!ops.length) return null;
  return {
    id,
    priority: BRIDGE_RULE.PER_REQUEST_PRIORITY,
    action: { type: 'modifyHeaders', requestHeaders: ops },
    condition: { ...bridgeCondition(extId), urlFilter: `|${url}|` },
  };
}
