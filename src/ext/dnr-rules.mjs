// DNR rule generation (notes/ui.md § DNR implementation sketch).
//
// Pure functions from (activation, mode, lists, escape hatches) to the exact
// rule state the extension must hold: which static rulesets are enabled, the
// full dynamic rule set, and session rules. The extension applies this
// declaratively (diff against chrome.declarativeNetRequest state); tests
// assert the JSON directly.
//
// Interception is main_frame-only by design: bridge fetches and native
// subresources must never hit these rules.

import { isIpLiteral } from './list-match.mjs';

export const CATCHALL_RULESET_ID = 'catchall';

export const PRIORITY = {
  CATCHALL: 1, // static whitelist-mode redirect-everything
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

// The static catch-all ruleset (whitelist mode). Generated at build time into
// rules/catchall.json; requires a pinned extension id (manifest "key") because
// regexSubstitution needs an absolute URL.
// \0 carries the raw matched URL un-encoded; the viewer must slice
// location.search at the first "url=" rather than using URLSearchParams.
export function catchallRules(viewerBase) {
  return [
    {
      id: 1,
      priority: PRIORITY.CATCHALL,
      action: {
        type: 'redirect',
        redirect: { regexSubstitution: `${viewerBase}?url=\\0` },
      },
      condition: {
        regexFilter: '^https?://.*',
        resourceTypes: MAIN_FRAME,
      },
    },
  ];
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

  if (!active) return { enabledStaticRulesets: [], dynamicRules: [], sessionRules: [] };

  const dynamicRules = [];
  const enabledStaticRulesets = [];

  if (mode === 'whitelist') {
    enabledStaticRulesets.push(CATCHALL_RULESET_ID);
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
          redirect: { regexSubstitution: `${viewerBase}?url=\\0` },
        },
        condition: { regexFilter: entryRegex(entry), resourceTypes: MAIN_FRAME },
      });
    });
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }

  const sessionRules = escapeHatches.map(({ tabId, entry }) => ({
    id: ID_BASE.escape + tabId,
    priority: PRIORITY.ESCAPE,
    action: { type: 'allow' },
    condition: {
      regexFilter: entryRegex(entry),
      resourceTypes: MAIN_FRAME,
      tabIds: [tabId],
    },
  }));

  return { enabledStaticRulesets, dynamicRules, sessionRules };
}
