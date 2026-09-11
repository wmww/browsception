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
//    Sec-Fetch-* is NOT stripped: the engine omits it only for http targets,
//    where neither host stamps it either, so a request the engine sent
//    without it keeps the host's values rather than going out bare.
// 2. Per-request rule (priority 2, short-lived, exact urlFilter): carries the
//    DNR_REQUEST_HEADERS the engine DID send. Added before the fetch, removed
//    after its terminal event; never static, so a redirect can never ride an
//    engine cookie cross-origin (hops abort under redirect:'error' anyway).
//    Priority 2 beats the base rule's strips per DNR's per-header
//    highest-priority-wins conflict resolution.
//
// Not fixable here: cache:'no-store' makes both hosts add `Pragma: no-cache`,
// and `Cache-Control: no-cache` unless the request carries its own, below
// the extension layer — a DNR remove never sees them (experiment-log
// 2026-09-10). The engine's own Cache-Control is not forbidden and rides the
// fetch init, so only a request the engine sent without one gets `no-cache`.

export const BRIDGE_RULE = {
  BASE_ID: 9001,
  BASE_PRIORITY: 1,
  PER_REQUEST_PRIORITY: 2,
  PER_REQUEST_MIN_ID: 10000, // ids cycle in [MIN, MAX); collisions guarded by
  PER_REQUEST_MAX_ID: 100000, // the bridge's in-flight set
};

// Engine request headers that ride the per-request rule instead of the fetch
// init — each is fetch-forbidden, or overwritten by the host's own value:
//   cookie          engine jar (the host jar never rides: credentials:'omit')
//   referer, origin engine policy; the base rule strips the extension's
//   user-agent      engine UA; usually adopted into the base rule (bridge.mjs)
//   sec-fetch-*     WebCore's fetch metadata; the host stamps its extension-
//                   fetch values (Chrome `none/cors/empty`, Firefox
//                   `same-origin/cors/empty`) and GitHub 422s on `none`.
//                   Sec-Fetch-User is the embedder's (EmbedderStrategies.cpp).
export const DNR_REQUEST_HEADERS = [
  'cookie',
  'referer',
  'origin',
  'user-agent',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
];

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
 * Per-request rule carrying engine-supplied DNR_REQUEST_HEADERS.
 * Returns null when the request needs none (plain http GETs: no rule churn).
 *
 * urlFilter uses exact anchors `|url|`. A literal `*` inside the URL would
 * widen the match, but the condition still confines it to bridge fetches on
 * the same origin prefix — worst case a cookie reaches a sibling bridge
 * request of the same origin, which the engine jar allowed anyway. Known
 * residual, same root: two in-flight bridge requests for the SAME URL (an
 * `<img>` and a `fetch()` of it) both match both rules, and one may go out
 * with the other's Sec-Fetch-Dest/Mode. DNR cannot condition on request
 * headers and fragments never reach the wire, so there is no per-request
 * marker to tell them apart.
 *
 * Platform ceiling: 5000 session rules (Chrome and Firefox). An in-flight
 * count that high is unreachable through the credit window and the engine's
 * per-host connection limits; if it ever happens the add rejects and the
 * bridge fails the request rather than fetch without its headers.
 * @param {number} id
 * @param {string} url
 * @param {Partial<Record<(typeof DNR_REQUEST_HEADERS)[number], string>>} h
 * @param {string} extId
 */
export function perRequestHeaderRule(id, url, h, extId) {
  const ops = [];
  for (const header of DNR_REQUEST_HEADERS)
    if (h[header] != null) ops.push({ header, operation: 'set', value: h[header] });
  if (!ops.length) return null;
  return {
    id,
    priority: BRIDGE_RULE.PER_REQUEST_PRIORITY,
    action: { type: 'modifyHeaders', requestHeaders: ops },
    condition: { ...bridgeCondition(extId), urlFilter: `|${url}|` },
  };
}
