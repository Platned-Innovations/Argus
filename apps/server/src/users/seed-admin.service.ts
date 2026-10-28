import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { type DataStore, DuplicateKeyError } from '@argus/data';
import { PasswordService } from '../auth/password.service';
import { AppConfig } from '../config/app-config';
import { AuditService } from '../core/audit.service';
import { DATA_STORE } from '../core/tokens';

export const DEFAULT_ADMIN_USERNAME = 'admin';

/** Creates the default system administrator the first time Argus starts against an empty database. */
@Injectable()
export class SeedAdminService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Bootstrap');

  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if ((await this.store.users.count()) > 0) return;

    const generated = !this.config.adminPassword;
    const password = this.config.adminPassword ?? (await this.passwords.generateTemporary());
    try {
      const admin = await this.store.users.create({
        username: DEFAULT_ADMIN_USERNAME,
        email: null,
        displayName: 'System Administrator',
        role: 'admin',
        teamIds: [],
        passwordHash: await this.passwords.hash(password),
        mustChangePassword: true,
      });
      await this.audit.record({ action: 'system.admin_seeded', target: { type: 'user', id: admin.id }, details: { passwordSource: generated ? 'generated' : 'env' } });
    } catch (err) {
      // Another instance seeded concurrently.
      if (err instanceof DuplicateKeyError) return;
      throw err;
    }

    if (generated) {
      // Single line so it stays readable in JSON logs (docker logs, App Service log stream).
      this.logger.warn(
        `DEFAULT ADMIN CREATED - username: ${DEFAULT_ADMIN_USERNAME} | temporary password: ${password} | shown only once; you must change it at first sign-in`,
      );
    } else {
      this.logger.warn(`Created default administrator "${DEFAULT_ADMIN_USERNAME}" with the password from ARGUS_ADMIN_PASSWORD. It must be changed at first sign-in.`);
    }
  }
}
