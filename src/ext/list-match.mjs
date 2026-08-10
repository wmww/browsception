// Site-list semantics (notes/ui.md § List semantics).
//
// An entry is a domain; it matches itself and all subdomains.
// Exact-host entries (power users) are prefixed with '=': "=host.example.com"
// matches only that host. Entries are matched against URL hostnames only
// (http/https navigations; scheme scoping happens in rule generation).

// Normalize user input to a canonical entry, or null if unusable.
// Accepts bare domains, full URLs, entries with stray whitespace/trailing dots.
export function normalizeEntry(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (s === '') return null;
  const exact = s.startsWith('=');
  if (exact) s = s.slice(1);
  // Tolerate pasted URLs.
  if (s.includes('/') || s.includes(':')) {
    try {
      s = new URL(s.includes('://') ? s : `https://${s}`).hostname;
    } catch {
      return null;
    }
  }
  s = s.replace(/\.+$/, '');
  // Reject empty labels, spaces, and non-hostname junk. IDNs arrive punycoded
  // when they come from URLs; accept xn-- labels as-is.
  if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(s) && !isIpLiteral(s)) return null;
  return exact ? `=${s}` : s;
}

export function isIpLiteral(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // v4 (post-URL-normalization)
  return host.includes(':'); // v6 (hostname form, brackets already stripped by URL)
}

// Does a single list entry match a hostname?
export function entryMatches(entry, hostname) {
  if (!entry || !hostname) return false;
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  if (entry.startsWith('=')) return host === entry.slice(1);
  if (isIpLiteral(entry)) return host === entry; // IPs never match "subdomains"
  return host === entry || host.endsWith(`.${entry}`);
}

// Does any entry in the list match the hostname?
export function listMatches(list, hostname) {
  return list.some((e) => entryMatches(e, hostname));
}
