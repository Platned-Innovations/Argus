import 'reflect-metadata';
import { createDataStore } from '@argus/data';
import { rotateMasterKey } from './cli/rotate-master-key';
import { AppConfig, ConfigError } from './config/app-config';

const USAGE = `Argus command-line tools

  node apps/server/dist/cli.js rotate-master-key [--dry-run]

    Re-encrypts every stored credential from ARGUS_MASTER_KEY (the current key) to ARGUS_NEW_MASTER_KEY.
    Stop Argus first; afterwards start it with ARGUS_MASTER_KEY set to the new key.
    Uses the same database settings as Argus (ARGUS_DB_TYPE, ARGUS_DB_URL, ...).
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'rotate-master-key') {
    console.log(USAGE);
    return command ? 2 : 0;
  }
  const config = AppConfig.fromEnv(process.env);
  const newKey = process.env.ARGUS_NEW_MASTER_KEY ?? '';
  if (newKey.length < 32) {
    console.error('Set ARGUS_NEW_MASTER_KEY to the new key (at least 32 characters, e.g. openssl rand -base64 48).');
    return 2;
  }
  const store = await createDataStore({ kind: config.dbType, url: config.dbUrl, dbName: config.dbName });
  try {
    await store.migrate();
    const report = await rotateMasterKey(store, config.masterKey, newKey, { dryRun: rest.includes('--dry-run') });
    console.log(
      `${report.dryRun ? '[dry run] ' : ''}Re-encrypted ${report.reencrypted} value(s); ${report.alreadyRotated} already used the new key; keyed-hash key ${report.hashKeyPreserved ? 'preserved' : 'NOT preserved'}.`,
    );
    if (report.unreadable.length) {
      console.error(`Could not decrypt ${report.unreadable.length} value(s) with either key (left unchanged):\n  ${report.unreadable.join('\n  ')}`);
      return 1;
    }
    if (!report.dryRun) console.log('Done. Start Argus with ARGUS_MASTER_KEY set to the new key, then store the new key safely and retire the old one.');
    return 0;
  } finally {
    await store.close();
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  });
