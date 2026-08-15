// Self-signed cert for the local fixture servers. Chromium is launched with
// --ignore-certificate-errors (open-questions #20), so the cert only has to
// exist; its SANs are cosmetic. Generated on first use into a gitignored dir.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** @param {{dir: string, name?: string, sans?: string}} opts */
export function ensureCert({ dir, name = 'bstest', sans = 'DNS:bstest,DNS:*.bstest' }) {
  const key = join(dir, `${name}.key`);
  const crt = join(dir, `${name}.crt`);
  if (!existsSync(key) || !existsSync(crt)) {
    mkdirSync(dir, { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
      '-keyout', key, '-out', crt, '-days', '3650', '-nodes',
      '-subj', `/CN=${name} fixture`,
      '-addext', `subjectAltName=${sans}`,
    ]);
  }
  return { key: readFileSync(key), cert: readFileSync(crt) };
}
