// DNR rule generation (notes/ui.md § DNR implementation sketch).
//
// Pure functions from (activation, mode, lists, escape hatches) to the exact
// rule state the extension must hold: the full dynamic rule set and the
// session rules. The extension applies this declaratively (one atomic
// updateDynamicRules); tests assert the JSON directly.
//
// Interception is main_frame-only by design: bridge fetches and native
// subresources must never hit these rules.

import { entryMatches, isIpLiteral, listMatches } from './list-match.mjs';
import { isHttpUrl, viewerTarget, viewerURLFor } from './viewer-url.mjs';

// The catch-all rule's id inside the dynamic rule set.
export const CATCHALL_RULE_ID = 1;

export const PRIORITY = {
  CATCHALL: 1, // whitelist-mode redirect-everything
  LIST_REDIRECT: 1, // blacklist-mode per-domain redirect
  ALLOW: 10, // whitelist-mode per-domain allow (beats CATCHALL)
  ESCAPE: 100, // session+tab-scoped one-time allow (beats everything)
};

// Dynamic/session rule id namespaces (whole sets are replaced atomically, so
// ids only need to be unique and deterministic within one generation).
const ID_BASE = { allow: 1000, redirect: 2000, escape: 100000 };

const MAIN_FRAME = ['main_frame'];

// RE2-escape a hostname (only chars that can appear in hostnames need care).
function escapeHost(host) {
  return host.replace(/\./g, '\\.');
}

// Regex matching any http(s) URL on `entry` (list-match semantics: bare entry
// covers subdomains, '=host' is exact, IP literals exact).
export function entryRegex(entry) {
  const exact = entry.startsWith('=');
  const host = escapeHost(exact ? entry.slice(1) : entry);
  const sub = exact || isIpLiteral(entry) ? '' : '(?:[^/:@?#]+\\.)?';
  return `^https?://${sub}${host}(?::\\d+)?(?:[/?#].*)?$`;
}

// The catch-all rule (whitelist mode: redirect every http(s) main_frame).
// Always dynamic, on both browsers: `regexSubstitution` needs an ABSOLUTE
// viewer URL (a relative one is a silent no-op, and `extensionPath` cannot
// carry \0), so a static ruleset could only carry it by pinning the
// extension id at build time — which is exactly what stops the package from
// being installed from a store. Runtime knows the real id, so the SW installs
// this at first run instead (desiredRuleState below); dynamic rules persist
// across restarts and extension updates.
// \0 carries the raw matched URL un-encoded — viewer-url.mjs owns that
// contract on both sides.
export function catchallRules(viewerBase) {
  return [
    {
      id: CATCHALL_RULE_ID,
      priority: PRIORITY.CATCHALL,
      action: {
        type: 'redirect',
        redirect: { regexSubstitution: viewerURLFor(viewerBase, '\\0') },
      },
      condition: {
        regexFilter: '^https?://.*',
        resourceTypes: MAIN_FRAME,
      },
    },
  ];
}

// Would this URL be sandboxed under `state`? Mirrors what the DNR rules from
// desiredRuleState() do at request time — used for the tab sweep and the
// per-tab disposition badge (2.4). Escape hatches are not consulted here.
export function shouldSandbox(state, url) {
  if (!state.active) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return state.mode === 'whitelist'
    ? !listMatches(state.whitelist ?? [], u.hostname)
    : listMatches(state.blacklist ?? [], u.hostname);
}

// --- tab sweep -------------------------------------------------------------
// The sweep (sw.mjs) is what catches navigations the rules missed, so its view
// of a tab must be the same one DNR would have had.

// The URL a tab is effectively at. `pendingUrl` FIRST: a navigation in flight
// is what the tab is about to be, and the tab the sweep exists for — one that
// raced ruleset registration at startup — is by definition mid-navigation,
// with `url` still 'about:blank' (verified: Chromium 151). Its request is
// already on the wire, so no rule will ever re-evaluate it.
export function tabUrl(tab) {
  return tab.pendingUrl || tab.url || '';
}

/**
 * What the sweep should do with one tab: sandbox it, take it native, or
 * nothing. Symmetric by design (ui.md § toggle/edit behavior).
 * @param escapeEntry live "open natively" grant for THIS tab, if any — DNR
 *   would let that navigation through (PRIORITY.ESCAPE), so the sweep must
 *   too, or the next reconcile silently revokes the escape hatch.
 */
export function sweepAction(state, tab, viewerBase, escapeEntry = null) {
  const url = tabUrl(tab);
  const target = viewerTarget(url, viewerBase);
  if (target !== null) {
    if (shouldSandbox(state, target)) return null; // correctly sandboxed
    // Taking a tab native means tabs.update(target) — a host-world sink. A
    // non-http(s) target would resolve against the extension origin and
    // 404 the tab; the viewer already shows "blocked" for it. Leave it.
    return isHttpUrl(target) ? { op: 'native', url: target } : null;
  }
  if (!shouldSandbox(state, url)) return null;
  if (escapeEntry) {
    try {
      if (entryMatches(escapeEntry, new URL(url).hostname)) return null;
    } catch {}
  }
  return { op: 'sandbox', url: viewerURLFor(viewerBase, url) };
}

/**
 * Compute the complete desired DNR state.
 * @param {{
 *   active: boolean,
 *   mode: 'whitelist'|'blacklist',
 *   whitelist: string[],   // trusted → native (allow) entries
 *   blacklist: string[],   // untrusted → sandboxed (redirect) entries
 *   escapeHatches?: {tabId: number, entry: string}[],
 * }} state
 * @param {string} viewerBase e.g. "chrome-extension://<id>/viewer.html"
 */
export function desiredRuleState(state, viewerBase) {
  const { active, mode, whitelist = [], blacklist = [], escapeHatches = [] } = state;

  if (!active) return { dynamicRules: [], sessionRules: [] };

  const dynamicRules = [];

  if (mode === 'whitelist') {
    // Catch-all first: one atomic swap installs it together with the allow
    // rules, so a reconcile never leaves a less-intercepting half-state.
    dynamicRules.push(...catchallRules(viewerBase));
    whitelist.forEach((entry, i) => {
      dynamicRules.push({
        id: ID_BASE.allow + i,
        priority: PRIORITY.ALLOW,
        action: { type: 'allow' },
        condition: { regexFilter: entryRegex(entry), resourceTypes: MAIN_FRAME },
      });
    });
  } else if (mode === 'blacklist') {
    blacklist.forEach((entry, i) => {
      dynamicRules.push({
        id: ID_BASE.redirect + i,
        priority: PRIORITY.LIST_REDIRECT,
        action: {
          type: 'redirect',
          redirect: { regexSubstitution: viewerURLFor(viewerBase, '\\0') },
        },
        condition: { regexFilter: entryRegex(entry), resourceTypes: MAIN_FRAME },
      });
    });
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }

  const sessionRules = escapeHatches.map(({ tabId, entry }) => escapeSessionRule(tabId, entry));

  return { dynamicRules, sessionRules };
}

// One tab-scoped "open natively" allow rule (2.3 escape hatch). Id is
// deterministic per tab so re-grants replace and tab close can clean up.
export const escapeRuleId = (tabId) => ID_BASE.escape + tabId;
export function escapeSessionRule(tabId, entry) {
  return {
    id: escapeRuleId(tabId),
    priority: PRIORITY.ESCAPE,
    action: { type: 'allow' },
    condition: {
      regexFilter: entryRegex(entry),
      resourceTypes: MAIN_FRAME,
      tabIds: [tabId],
    },
  };
}
