import { type DataStore } from '@argus/data';
import { type AppConfig } from '../config/app-config';
import { CryptoService, HASH_KEY_SETTING } from '../core/crypto.service';

/** Settings documents that hold encrypted values (any field whose name ends in "Enc"). */
const ENCRYPTED_SETTINGS = ['integrations.jira', 'ai', 'integrations.entraImport'];
const PAGE = 500;

export interface RotationReport {
  reencrypted: number;
  alreadyRotated: number;
  /** Values readable with neither key: left untouched and reported. */
  unreadable: string[];
  hashKeyPreserved: boolean;
  dryRun: boolean;
}

function cryptoFor(masterKey: string): CryptoService {
  return new CryptoService({ masterKey } as AppConfig);
}

/**
 * Re-encrypts every stored credential from the current master key to a new one, and preserves the keyed-hash key
 * (encrypted with the new key) so refresh tokens, API tokens, MFA recovery codes and secret-finding identities stay
 * valid. Idempotent: values already encrypted with the new key are left alone, so an interrupted run can be repeated.
 * Run it while Argus is stopped, then start Argus with the new key.
 */
export async function rotateMasterKey(store: DataStore, oldKey: string, newKey: string, opts: { dryRun?: boolean } = {}): Promise<RotationReport> {
  if (oldKey === newKey) throw new Error('The new master key must differ from the current one.');
  if (newKey.length < 32) throw new Error('The new master key must be at least 32 characters.');
  const oldC = cryptoFor(oldKey);
  const newC = cryptoFor(newKey);
  const report: RotationReport = { reencrypted: 0, alreadyRotated: 0, unreadable: [], hashKeyPreserved: false, dryRun: !!opts.dryRun };

  const rotate = (value: string, where: string): string => {
    try {
      newC.decrypt(value);
      report.alreadyRotated++;
      return value;
    } catch {
      // not yet rotated
    }
    try {
      const plain = oldC.decrypt(value);
      report.reencrypted++;
      return newC.encrypt(plain);
    } catch {
      report.unreadable.push(where);
      return value;
    }
  };

  // 1. The hash key first: as long as it is stored, hashes keep working whatever happens next.
  const stored = await store.settings.get<string>(HASH_KEY_SETTING);
  let hashKey: string;
  if (stored?.value) {
    try {
      hashKey = newC.decrypt(stored.value);
    } catch {
      hashKey = oldC.decrypt(stored.value);
    }
  } else {
    hashKey = oldC.exportHashKey();
  }
  if (!opts.dryRun) await store.settings.set(HASH_KEY_SETTING, newC.encrypt(hashKey), null);
  report.hashKeyPreserved = true;

  // 2. MFA secrets.
  for (let offset = 0; ; offset += PAGE) {
    const page = await store.users.list({ offset, limit: PAGE });
    for (const u of page.items) {
      const patch: Record<string, string> = {};
      if (u.mfaSecretEnc) patch.mfaSecretEnc = rotate(u.mfaSecretEnc, `user ${u.username} (MFA secret)`);
      if (u.mfaPendingSecretEnc) patch.mfaPendingSecretEnc = rotate(u.mfaPendingSecretEnc, `user ${u.username} (pending MFA secret)`);
      if (Object.keys(patch).length && !opts.dryRun) await store.users.update(u.id, patch);
    }
    if (page.items.length < PAGE) break;
  }

  // 3. Source tokens and webhook secrets.
  for (const s of await store.sources.list()) {
    const patch = { tokenEnc: rotate(s.tokenEnc, `source ${s.name} (token)`), webhookSecretEnc: rotate(s.webhookSecretEnc, `source ${s.name} (webhook secret)`) };
    if (!opts.dryRun) await store.sources.update(s.id, patch);
  }

  // 4. Notification channel secrets.
  for (const c of await store.channels.list()) {
    if (!c.secretEnc) continue;
    const secretEnc = rotate(c.secretEnc, `channel ${c.name}`);
    if (!opts.dryRun) await store.channels.update(c.id, { secretEnc });
  }

  // 5. Settings documents (Jira token, AI provider keys, Entra import secret).
  const walk = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, k.endsWith('Enc') && typeof x === 'string' ? rotate(x, `${path}.${k}`) : walk(x, `${path}.${k}`)]));
    }
    return v;
  };
  for (const key of ENCRYPTED_SETTINGS) {
    const rec = await store.settings.get<unknown>(key);
    if (!rec) continue;
    const value = walk(rec.value, key);
    if (!opts.dryRun) await store.settings.set(key, value, rec.updatedBy);
  }
  return report;
}
