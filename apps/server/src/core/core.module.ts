import { type DynamicModule, Global, Inject, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDataStore, type DataStore } from '@argus/data';
import { AppConfig } from '../config/app-config';
import { AuditService } from './audit.service';
import { CryptoService } from './crypto.service';
import { DomainEvents } from './domain-events';
import { SettingsService } from './settings.service';
import { DATA_STORE } from './tokens';

@Injectable()
class DataStoreLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DATA_STORE) private readonly store: DataStore) {}

  async onApplicationShutdown(): Promise<void> {
    await this.store.close();
  }
}

/** Process-wide singletons: configuration, data store, crypto, audit and settings. */
@Global()
@Module({})
export class CoreModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: CoreModule,
      providers: [
        { provide: AppConfig, useValue: config },
        {
          provide: DATA_STORE,
          useFactory: async () => {
            const logger = new Logger('DataStore');
            const store = await createDataStore({ kind: config.dbType, url: config.dbUrl, dbName: config.dbName });
            await store.migrate();
            logger.log(`Connected to ${config.dbType}; schema is up to date`);
            return store;
          },
        },
        DataStoreLifecycle,
        CryptoService,
        AuditService,
        SettingsService,
        DomainEvents,
      ],
      exports: [AppConfig, DATA_STORE, CryptoService, AuditService, SettingsService, DomainEvents],
    };
  }
}
