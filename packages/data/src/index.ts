import { type DataStore, type DataStoreKind } from './store';
import { createMongoStore } from './mongo/store';
import { createPostgresStore } from './postgres/store';

export * from './models';
export * from './scanning-models';
export * from './findings-models';
export * from './tickets-models';
export * from './store';
export * from './errors';

export interface DataStoreOptions {
  kind: DataStoreKind;
  url: string;
  /** MongoDB database name; defaults to the one in the connection string, then "argus". */
  dbName?: string;
}

export async function createDataStore(options: DataStoreOptions): Promise<DataStore> {
  return options.kind === 'postgres' ? createPostgresStore(options.url) : createMongoStore(options.url, options.dbName);
}
