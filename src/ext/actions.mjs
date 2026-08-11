// Popup per-site action matrix (notes/ui.md § Toolbar UI) — pure logic so
// tier 0 can pin the semantics. `disposition` is the CURRENT tab reality
// ('sandboxed' | 'native' | 'other'); ops are applied by the popup.

import { entryMatches, normalizeEntry } from './list-match.mjs';

// Which list entry (if any) covers this host?
const coveringEntry = (list, host) => list.find((e) => entryMatches(e, host)) ?? null;

/**
 * @returns {{op: string, label: string, entry?: string}[]} ordered actions.
 * Ops: trust / untrust / sandbox / unsandbox / open-native-once.
 */
export function primaryActions(state, disposition, host) {
  if (!state.active || !host || disposition === 'other') return [];
  const entry = normalizeEntry(host);
  if (!entry) return [];

  if (state.mode === 'whitelist') {
    if (disposition === 'sandboxed')
      return [
        { op: 'trust', entry, label: `Trust ${host} — always run natively` },
        { op: 'open-native-once', label: 'Open natively once' },
      ];
    const covering = coveringEntry(state.whitelist, host);
    return covering
      ? [{ op: 'untrust', entry: covering, label: `Remove ${covering} from trusted list` }]
      : []; // native without a whitelist entry: escape hatch / race — no list action
  }

  // blacklist mode
  if (disposition === 'native')
    return [{ op: 'sandbox', entry, label: `Sandbox ${host}` }];
  const covering = coveringEntry(state.blacklist, host);
  return covering
    ? [
        { op: 'unsandbox', entry: covering, label: `Remove ${covering} from sandbox list` },
        { op: 'open-native-once', label: 'Open natively once' },
      ]
    : [{ op: 'open-native-once', label: 'Open natively once' }];
}
