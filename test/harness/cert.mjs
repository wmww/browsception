// Certs for the local fixture servers: a tiny CA plus a leaf it signs. Chromium
// is launched with --ignore-certificate-errors (open-questions #20) and would
// take anything; Firefox gets the CA imported into its profile as a trust
// anchor (harness/firefox.mjs) so the connection is genuinely clean — which is
// what HSTS needs (Firefox ignores Strict-Transport-Security behind a cert
// override). A self-signed leaf cannot play both roles: mozilla::pkix rejects
// a CA:TRUE cert used as an end entity. Generated on first use into a
// gitignored dir.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const KEY = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];

/**
 * @param {{dir: string, name?: string, sans?: string}} opts
 * @returns {{key: Buffer, cert: Buffer, ca: string}} leaf key/cert + the CA cert's path
 */
export function ensureCert({ dir, name = 'bstest', sans = 'DNS:bstest,DNS:*.bstest' }) {
  const caKey = join(dir, `${name}-ca.key`);
  const ca = join(dir, `${name}-ca.crt`);
  const key = join(dir, `${name}.key`);
  const crt = join(dir, `${name}.crt`);
  const csr = join(dir, `${name}.csr`);
  const ext = join(dir, `${name}.ext`);
  const extText = `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${sans}\n`;
  const fresh = [caKey, ca, key, crt, ext].every(existsSync) && readFileSync(ext, 'utf8') === extText;
  if (!fresh) {
    mkdirSync(dir, { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', ...KEY, '-keyout', caKey, '-out', ca, '-days', '3650',
      '-subj', `/CN=${name} fixture CA`,
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    ]);
    execFileSync('openssl', ['req', '-new', ...KEY, '-keyout', key, '-out', csr, '-subj', `/CN=${name} fixture`]);
    writeFileSync(ext, extText);
    execFileSync('openssl', [
      'x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', crt, '-days', '3650', '-extfile', ext,
    ], { stdio: 'ignore' });
  }
  return { key: readFileSync(key), cert: readFileSync(crt), ca };
}
