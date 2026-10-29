import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { createDataStore, type DataStore } from '@argus/data';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../src/app.factory';
import { rotateMasterKey } from '../../src/cli/rotate-master-key';
import { AppConfig } from '../../src/config/app-config';
import { CryptoService } from '../../src/core/crypto.service';
import { DATA_STORE } from '../../src/core/tokens';
import { BASE_TEST_ENV, Client, dbHarnesses } from './helpers';

const OLD_KEY = BASE_TEST_ENV.ARGUS_MASTER_KEY;
const NEW_KEY = 'rotated-master-key-abcdefghijklmnopqrstuvwxyz-0123';

const harnesses = dbHarnesses();

describe.each(harnesses)('master-key rotation e2e: $name', (h) => {
  let env: Record<string, string>;
  let app: INestApplication;
  let store: DataStore;
  let apiToken = '';
  let sessionCookies = new Map<string, string>();
  const ids = { source: '', channel: '' };

  const start = async (masterKey: string) => {
    const a = await createApiApp(AppConfig.fromEnv({ ...env, ...BASE_TEST_ENV, ARGUS_MASTER_KEY: masterKey, ARGUS_ADMIN_PASSWORD: 'Initial-Admin-Pass-1', ARGUS_ROLE: 'api' }));
    await a.init();
    return a;
  };

  beforeAll(async () => {
    env = await h.env();
    app = await start(OLD_KEY);
    const admin = new Client(app);
    await admin.login('admin', 'Initial-Admin-Pass-1');
    await admin.call('post', '/api/v1/auth/change-password', { currentPassword: 'Initial-Admin-Pass-1', newPassword: 'Second-Root-Pass-9' });
    apiToken = (await admin.call('post', '/api/v1/me/tokens', { name: 'CI', scopes: ['findings:read'], expiresInDays: 30 })).body.token;
    ids.channel = (await admin.call('post', '/api/v1/integrations/channels', { type: 'webhook', name: 'Hook', enabled: true, config: { url: 'https://hooks.example.com/x' }, secret: 'whsec_0123456789abcdef' })).body.id;
    const providers = { anthropic: { enabled: true, model: 'claude-opus-5-5', baseUrl: null, inputPricePerMTok: null, outputPricePerMTok: null, apiKey: 'sk-ant-rotate-0001' } };
    const off = { enabled: false, model: 'm', baseUrl: null, inputPricePerMTok: null, outputPricePerMTok: null };
    await admin.call('put', '/api/v1/settings/ai', {
      enabled: false,
      defaultProvider: 'anthropic',
      providers: { ...providers, openai: off, gemini: off },
      useCases: { remediation: { enabled: true, provider: null }, ticket_draft: { enabled: true, provider: null }, secret_triage: { enabled: false, provider: null }, vuln_applicability: { enabled: false, provider: null } },
      monthlyBudgetUsd: null,
      maxContextChars: 12000,
      maxScanChecks: 20,
    });
    const crypto = app.get(CryptoService);
    const s = app.get<DataStore>(DATA_STORE);
    ids.source = (await s.sources.create({ name: 'GitHub', provider: 'github', baseUrl: null, scope: null, username: null, tokenEnc: crypto.encrypt('ghp_rotation-test-token'), tokenLast4: 'oken', webhookSecretEnc: crypto.encrypt('webhook-secret-1'), autoActivatePattern: null, defaultTeamId: null })).id;
    sessionCookies = new Map(admin.cookies);
    await app.close();
    store = await createDataStore({ kind: env.ARGUS_DB_TYPE as 'postgres' | 'mongodb', url: env.ARGUS_DB_URL, dbName: env.ARGUS_DB_NAME });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await store?.close();
    await h.stop();
  });

  it('re-encrypts every stored credential and is safe to repeat', async () => {
    const dry = await rotateMasterKey(store, OLD_KEY, NEW_KEY, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, unreadable: [] });
    expect(dry.reencrypted).toBe(4); // source token + webhook secret, channel secret, AI key
    const report = await rotateMasterKey(store, OLD_KEY, NEW_KEY);
    expect(report).toMatchObject({ reencrypted: 4, alreadyRotated: 0, unreadable: [], hashKeyPreserved: true });
    // Interrupted or repeated runs change nothing.
    expect(await rotateMasterKey(store, OLD_KEY, NEW_KEY)).toMatchObject({ reencrypted: 0, alreadyRotated: 4 });
    await expect(rotateMasterKey(store, NEW_KEY, NEW_KEY)).rejects.toThrow(/must differ/);
  });

  it('starts with the new key: credentials decrypt, API tokens and sessions keep working', async () => {
    app = await start(NEW_KEY);
    const crypto = app.get(CryptoService);
    const s = app.get<DataStore>(DATA_STORE);
    const source = (await s.sources.findById(ids.source))!;
    expect(crypto.decrypt(source.tokenEnc)).toBe('ghp_rotation-test-token');
    expect(crypto.decrypt(source.webhookSecretEnc)).toBe('webhook-secret-1');
    expect(crypto.decrypt((await s.channels.findById(ids.channel))!.secretEnc!)).toBe('whsec_0123456789abcdef');
    const ai = (await s.settings.get<{ providers: { anthropic: { keyEnc: string } } }>('ai'))!.value;
    expect(crypto.decrypt(ai.providers.anthropic.keyEnc)).toBe('sk-ant-rotate-0001');

    // Keyed hashes made before the rotation still match.
    expect((await request(app.getHttpServer()).get('/api/v1/findings').set('Authorization', `Bearer ${apiToken}`)).status).toBe(200);
    const admin = new Client(app);
    admin.cookies = new Map(sessionCookies);
    // The old access token was signed with the old key; the refresh token (a keyed hash) still works.
    expect((await admin.call('get', '/api/v1/auth/me')).status).toBe(401);
    expect((await admin.call('post', '/api/v1/auth/refresh')).status).toBe(200);
    expect((await admin.call('get', '/api/v1/auth/me')).status).toBe(200);
  });

  it('the old key no longer decrypts anything', async () => {
    const old = new CryptoService({ masterKey: OLD_KEY } as AppConfig);
    const source = (await store.sources.findById(ids.source))!;
    expect(() => old.decrypt(source.tokenEnc)).toThrow();
  });
});
