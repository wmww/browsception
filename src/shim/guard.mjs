// Bridge request guard list (notes/networking.md § Shim guard list).
//
// Applied to every bridge request before fetch(). Deliberately coarse and
// boring: web-platform security (SOP/CORS/CSP/mixed content) runs inside the
// engine; this list only withholds host capabilities the nested world must
// never reach. credentials:'omit' is NOT here — it is hardcoded at the single
// fetch() call site, structurally.

export const CAPS = {
  MAX_RESPONSE_BYTES: 256 * 1024 * 1024, // per-response cap
  IDLE_TIMEOUT_MS: 30_000, // no-progress abort
};

// Standard fetch bad-ports list (defense in depth; host fetch blocks most).
// prettier-ignore
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
  // Our additions beyond the fetch spec: well-known internal-service ports
  // that never serve legitimate public websites (SSRF defense in depth).
  3306, 5432, 5900, 6379, 9200, 11211, 27017,
]);

function parseIpv4(host) {
  // Hostnames arrive WHATWG-URL-normalized, so v4 literals (incl. hex/short
  // forms) are already dotted-quad. Anything else is not an IPv4 literal.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((x) => x <= 255) ? o : null;
}

function isPrivateIpv4(o) {
  const [a, b] = o;
  if (a === 0 || a === 127 || a === 10) return true; // this-host, loopback, RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 255) return true; // broadcast
  return false;
}

function isPrivateIpv6(host) {
  // URL hostname form: brackets stripped, lowercase, compressed.
  const h = host.toLowerCase();
  if (h === '::' || h === '::1') return true; // unspecified, loopback
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb'))
    return true; // fe80::/10 link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 ULA
  // v4-mapped/compat forms: ::ffff:a.b.c.d or ::ffff:hex — check embedded v4.
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (mapped) {
    const o = parseIpv4(mapped[1]);
    return o ? isPrivateIpv4(o) : true; // unparseable mapped form: deny
  }
  if (h.startsWith('::ffff:')) return true; // hex-form mapped v4: deny outright
  return false;
}

function isPrivateHostname(host) {
  const h = host.toLowerCase().replace(/\.+$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h === 'local' || h === 'internal')
    return true;
  if (h === '') return true;
  return false;
}

/**
 * Evaluate a bridge request URL against the guard list.
 * @param {string} urlString absolute URL the engine wants to fetch
 * @param {{allowPrivateNetwork?: boolean}} [opts] per-profile override (ui.md options page)
 * @returns {{allow: boolean, reason: string}}
 */
export function evaluateRequest(urlString, opts = {}) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return { allow: false, reason: 'unparseable-url' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return { allow: false, reason: `scheme:${url.protocol.replace(/:$/, '')}` };

  if (url.username || url.password) return { allow: false, reason: 'userinfo' };

  if (url.port !== '' && BAD_PORTS.has(Number(url.port)))
    return { allow: false, reason: `bad-port:${url.port}` };

  if (!opts.allowPrivateNetwork) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const v4 = parseIpv4(host);
    if (v4 ? isPrivateIpv4(v4) : host.includes(':') ? isPrivateIpv6(host) : isPrivateHostname(host))
      return { allow: false, reason: 'private-network' };
  }

  return { allow: true, reason: 'ok' };
}
