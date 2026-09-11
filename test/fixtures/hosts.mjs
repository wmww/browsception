// Every host the fixture server answers for: the interception-matrix hosts the
// probe extensions' static rules name plus one per fixture page. Chromium maps
// *.bstest wholesale (--host-resolver-rules) and ignores cert errors; Firefox
// resolves exactly these (network.dns.localDomains) and verifies the cert for
// real, and mozilla::pkix refuses a wildcard with a single label after it
// (*.bstest), so the leaf names each host explicitly.
export const FIXTURE_HOSTS = [
  'grid.bstest', 'input.bstest', 'app.bstest', 'scroll.bstest', 'scroll-sticky.bstest',
  'hostile.bstest', 'final.bstest', 'plain-http.bstest', 'site-a.bstest', 'site-b.bstest',
  'other.bstest', 'x.bstest', 'clipboard.bstest',
];
export const FIXTURE_SANS = ['DNS:bstest', 'DNS:*.bstest', ...FIXTURE_HOSTS.map((h) => `DNS:${h}`)].join(',');
