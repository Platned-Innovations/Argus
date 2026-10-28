import { type Kysely, type Migration, type MigrationProvider, sql } from 'kysely';

// Migrations use snake_case identifiers explicitly. They are append-only: never edit a shipped migration.
const migrations: Record<string, Migration> = {
  '0001_init': {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('users')
        .addColumn('id', 'uuid', (c) => c.primaryKey())
        .addColumn('username', 'text', (c) => c.notNull())
        .addColumn('username_lower', 'text', (c) => c.notNull().unique())
        .addColumn('email', 'text')
        .addColumn('email_lower', 'text', (c) => c.unique())
        .addColumn('display_name', 'text', (c) => c.notNull())
        .addColumn('password_hash', 'text', (c) => c.notNull())
        .addColumn('role', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('must_change_password', 'boolean', (c) => c.notNull().defaultTo(false))
        .addColumn('mfa_enabled', 'boolean', (c) => c.notNull().defaultTo(false))
        .addColumn('mfa_secret_enc', 'text')
        .addColumn('mfa_pending_secret_enc', 'text')
        .addColumn('mfa_recovery_codes', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
        .addColumn('mfa_last_used_step', 'integer')
        .addColumn('failed_login_count', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('locked_until', 'timestamptz')
        .addColumn('last_login_at', 'timestamptz')
        .addColumn('password_changed_at', 'timestamptz')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull())
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('teams')
        .addColumn('id', 'uuid', (c) => c.primaryKey())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('name_lower', 'text', (c) => c.notNull().unique())
        .addColumn('description', 'text')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull())
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('team_members')
        .addColumn('team_id', 'uuid', (c) => c.notNull().references('teams.id').onDelete('cascade'))
        .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addPrimaryKeyConstraint('team_members_pk', ['team_id', 'user_id'])
        .execute();
      await db.schema.createIndex('team_members_user_idx').on('team_members').column('user_id').execute();

      await db.schema
        .createTable('sessions')
        .addColumn('id', 'uuid', (c) => c.primaryKey())
        .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('token_hash', 'text', (c) => c.notNull().unique())
        .addColumn('family_id', 'uuid', (c) => c.notNull())
        .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
        .addColumn('revoked_at', 'timestamptz')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull())
        .addColumn('last_used_at', 'timestamptz')
        .addColumn('user_agent', 'text')
        .addColumn('ip', 'text')
        .execute();
      await db.schema.createIndex('sessions_user_idx').on('sessions').column('user_id').execute();
      await db.schema.createIndex('sessions_family_idx').on('sessions').column('family_id').execute();
      await db.schema.createIndex('sessions_expires_idx').on('sessions').column('expires_at').execute();

      await db.schema
        .createTable('audit_logs')
        .addColumn('id', 'uuid', (c) => c.primaryKey())
        .addColumn('at', 'timestamptz', (c) => c.notNull())
        .addColumn('actor_id', 'uuid')
        .addColumn('actor_name', 'text')
        .addColumn('action', 'text', (c) => c.notNull())
        .addColumn('target_type', 'text')
        .addColumn('target_id', 'text')
        .addColumn('ip', 'text')
        .addColumn('outcome', 'text', (c) => c.notNull())
        .addColumn('details', 'jsonb')
        .execute();
      await db.schema.createIndex('audit_logs_at_idx').on('audit_logs').column('at desc').execute();
      await db.schema.createIndex('audit_logs_actor_idx').on('audit_logs').columns(['actor_id', 'at desc']).execute();
      await db.schema.createIndex('audit_logs_action_idx').on('audit_logs').columns(['action', 'at desc']).execute();
      await db.schema.createIndex('audit_logs_target_idx').on('audit_logs').columns(['target_type', 'target_id']).execute();

      await db.schema
        .createTable('settings')
        .addColumn('key', 'text', (c) => c.primaryKey())
        .addColumn('value', 'jsonb', (c) => c.notNull())
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
        .addColumn('updated_by', 'uuid')
        .execute();
    },
  },
};

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
