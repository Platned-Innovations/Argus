import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isTestPath } from '../risk';
import { type DraftFinding, type ScanInput, type Scanner, type ScannerOutput } from '../types';

const DAY = 86_400_000;
const CERT_FILE = /\.(pem|crt|cer|der)$/i;
const KEYSTORE_FILE = /\.(pfx|p12)$/i;
const CONFIG_FILE = /\.(json|ya?ml|env|config|properties|xml|ini|toml|tfvars)$|(^|\/)\.env(\.[\w-]+)?$/i;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

function certificates(raw: Buffer): X509Certificate[] {
  const text = raw.toString('latin1');
  const pems = text.match(PEM_CERT);
  if (pems) return pems.flatMap((p) => tryParse(Buffer.from(p)));
  return tryParse(raw);
}

function tryParse(data: Buffer): X509Certificate[] {
  try {
    return [new X509Certificate(data)];
  } catch {
    return [];
  }
}

/** Certificates and expiring credentials committed to the repository. */
export class CertificatesScanner implements Scanner {
  readonly name = 'certificates' as const;

  async run(input: ScanInput): Promise<ScannerOutput> {
    const now = Date.now();
    const warnDays = input.settings.expiryWarningDays;
    const findings: DraftFinding[] = [];

    for (const file of input.files) {
      if (file.size > 5 * 1024 * 1024) continue;
      const testPath = isTestPath(file.path);

      if (KEYSTORE_FILE.test(file.path)) {
        findings.push({
          ruleId: 'keystore-in-repository',
          identity: [file.path],
          title: `Key store committed: ${file.path}`,
          description: 'A PKCS#12 (.pfx/.p12) file usually contains a private key together with its certificate. Its contents and expiry cannot be checked without the password.',
          path: file.path,
          line: null,
          package: null,
          advisory: null,
          secret: null,
          details: null,
          remediation: 'Remove the key store from the repository and history, rotate the certificate and private key, and load it from a secret store (e.g. Azure Key Vault) at runtime.',
          risk: { base: 55, baseLabel: 'Private key store in source control', testPath },
        });
        continue;
      }

      if (CERT_FILE.test(file.path)) {
        for (const cert of certificates(await readFile(file.abs))) findings.push(...this.checkCertificate(cert, file.path, now, warnDays, testPath));
        continue;
      }

      if (CONFIG_FILE.test(file.path) && file.size <= 1024 * 1024) {
        const text = await input.readText(file);
        if (text) findings.push(...this.checkTokens(text, file.path, now, warnDays, testPath, input));
      }
    }
    return { status: 'ok', message: null, findings };
  }

  private checkCertificate(cert: X509Certificate, path: string, now: number, warnDays: number, testPath: boolean): DraftFinding[] {
    const out: DraftFinding[] = [];
    const subject = cert.subject.replace(/\n/g, ', ');
    const validTo = new Date(cert.validTo);
    const daysLeft = Math.floor((validTo.getTime() - now) / DAY);
    const selfSigned = cert.subject === cert.issuer;
    const details = {
      subject,
      issuer: cert.issuer.replace(/\n/g, ', '),
      serialNumber: cert.serialNumber,
      validFrom: new Date(cert.validFrom).toISOString(),
      validTo: validTo.toISOString(),
      daysLeft,
      selfSigned,
      fingerprintSha256: cert.fingerprint256,
      subjectAltName: cert.subjectAltName ?? null,
    };
    const base = { path, line: null, package: null, advisory: null, secret: null, details };

    if (daysLeft < 0 || daysLeft <= Math.max(warnDays, 90)) {
      const expired = daysLeft < 0;
      out.push({
        ...base,
        ruleId: expired ? 'certificate-expired' : 'certificate-expiring',
        identity: [path, cert.fingerprint256],
        title: expired ? `Certificate expired ${-daysLeft} day(s) ago: ${subject}` : `Certificate expires in ${daysLeft} day(s): ${subject}`,
        description: `${path} contains a certificate valid until ${validTo.toISOString().slice(0, 10)}${selfSigned ? ' (self-signed)' : ''}.`,
        remediation: expired
          ? 'Replace the certificate. If it is still used anywhere, connections relying on it are already failing or trusting an expired certificate.'
          : 'Renew the certificate before it expires and roll the new one out to every system that uses it.',
        risk: expired ? { base: 60, baseLabel: 'Expired certificate', testPath } : { base: daysLeft <= warnDays ? 55 : 35, baseLabel: `Expires in ${daysLeft} day(s)`, testPath },
      });
    }

    const key = cert.publicKey.asymmetricKeyDetails;
    if (cert.publicKey.asymmetricKeyType === 'rsa' && key?.modulusLength && key.modulusLength < 2048) {
      out.push({
        ...base,
        ruleId: 'certificate-weak-key',
        identity: [path, cert.fingerprint256],
        title: `Weak ${key.modulusLength}-bit RSA key: ${subject}`,
        description: 'RSA keys shorter than 2048 bits are considered breakable.',
        remediation: 'Re-issue the certificate with at least a 2048-bit RSA key (3072+ recommended) or an ECDSA P-256 key.',
        risk: { base: 45, baseLabel: `RSA ${key.modulusLength}-bit key`, testPath },
      });
    }
    return out;
  }

  private checkTokens(text: string, path: string, now: number, warnDays: number, testPath: boolean, input: ScanInput): DraftFinding[] {
    const out: DraftFinding[] = [];
    for (const m of text.matchAll(JWT)) {
      let exp: number | undefined;
      try {
        exp = (JSON.parse(Buffer.from(m[0].split('.')[1], 'base64url').toString('utf8')) as { exp?: unknown }).exp as number | undefined;
      } catch {
        continue;
      }
      if (typeof exp !== 'number') continue;
      const daysLeft = Math.floor((exp * 1000 - now) / DAY);
      if (daysLeft > warnDays) continue;
      const expired = daysLeft < 0;
      // The token value itself is never stored; the hash only keeps the finding stable across scans.
      const hash = input.hashSecret(m[0]);
      out.push({
        ruleId: expired ? 'token-expired' : 'token-expiring',
        identity: [path, hash],
        title: expired ? `Expired token in ${path}` : `Token in ${path} expires in ${daysLeft} day(s)`,
        description: `A JSON Web Token with an expiry of ${new Date(exp * 1000).toISOString().slice(0, 10)} is committed in ${path}.`,
        path,
        line: text.slice(0, m.index).split('\n').length,
        package: null,
        advisory: null,
        secret: { type: 'jwt', preview: `${m[0].slice(0, 4)}…${m[0].slice(-4)}`, hash },
        details: { expiresAt: new Date(exp * 1000).toISOString(), daysLeft },
        remediation: expired
          ? 'Remove the expired token from the repository; anything still relying on it is broken.'
          : 'Issue a replacement before it expires, store it outside the repository, and update the systems that use it.',
        risk: expired ? { base: 20, baseLabel: 'Expired token in repository', testPath } : { base: 45, baseLabel: `Token expires in ${daysLeft} day(s)`, testPath },
      });
    }
    return out;
  }
}
