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

migrations['0002_sources_repos_jobs'] = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async up(db: Kysely<any>) {
    await db.schema
      .createTable('sources')
      .addColumn('id', 'uuid', (c) => c.primaryKey())
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('provider', 'text', (c) => c.notNull())
      .addColumn('base_url', 'text')
      .addColumn('scope', 'text')
      .addColumn('username', 'text')
      .addColumn('token_enc', 'text', (c) => c.notNull())
      .addColumn('token_last4', 'text', (c) => c.notNull())
      .addColumn('webhook_secret_enc', 'text', (c) => c.notNull())
      .addColumn('auto_activate_pattern', 'text')
      .addColumn('default_team_id', 'uuid', (c) => c.references('teams.id').onDelete('set null'))
      .addColumn('status', 'text', (c) => c.notNull())
      .addColumn('last_sync_at', 'timestamptz')
      .addColumn('last_sync_error', 'text')
      .addColumn('created_at', 'timestamptz', (c) => c.notNull())
      .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('repositories')
      .addColumn('id', 'uuid', (c) => c.primaryKey())
      .addColumn('source_id', 'uuid', (c) => c.notNull().references('sources.id').onDelete('cascade'))
      .addColumn('external_id', 'text', (c) => c.notNull())
      .addColumn('full_name', 'text', (c) => c.notNull())
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('html_url', 'text')
      .addColumn('clone_url', 'text', (c) => c.notNull())
      .addColumn('default_branch', 'text')
      .addColumn('visibility', 'text', (c) => c.notNull())
      .addColumn('language', 'text')
      .addColumn('description', 'text')
      .addColumn('archived', 'boolean', (c) => c.notNull().defaultTo(false))
      .addColumn('last_pushed_at', 'timestamptz')
      .addColumn('removed_at', 'timestamptz')
      .addColumn('active', 'boolean', (c) => c.notNull().defaultTo(false))
      .addColumn('team_id', 'uuid', (c) => c.references('teams.id').onDelete('set null'))
      .addColumn('criticality', 'text', (c) => c.notNull())
      .addColumn('branch', 'text')
      .addColumn('schedule', 'jsonb', (c) => c.notNull())
      .addColumn('scan_on_push', 'boolean', (c) => c.notNull().defaultTo(true))
      .addColumn('jira_project_key', 'text')
      .addColumn('notify_emails', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
      .addColumn('next_scan_at', 'timestamptz')
      .addColumn('last_scan_at', 'timestamptz')
      .addColumn('last_scan_status', 'text')
      .addColumn('last_scan_run_id', 'uuid')
      .addColumn('created_at', 'timestamptz', (c) => c.notNull())
      .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
      .addUniqueConstraint('repositories_source_external_unique', ['source_id', 'external_id'])
      .execute();
    await db.schema.createIndex('repositories_due_idx').on('repositories').columns(['active', 'next_scan_at']).execute();
    await db.schema.createIndex('repositories_team_idx').on('repositories').column('team_id').execute();
    await db.schema.createIndex('repositories_full_name_idx').on('repositories').column('full_name').execute();

    await db.schema
      .createTable('scan_runs')
      .addColumn('id', 'uuid', (c) => c.primaryKey())
      .addColumn('repo_id', 'uuid', (c) => c.notNull().references('repositories.id').onDelete('cascade'))
      .addColumn('source_id', 'uuid', (c) => c.notNull())
      .addColumn('team_id', 'uuid')
      .addColumn('trigger', 'text', (c) => c.notNull())
      .addColumn('status', 'text', (c) => c.notNull())
      .addColumn('requested_by', 'uuid')
      .addColumn('branch', 'text')
      .addColumn('commit_sha', 'text')
      .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('queued_at', 'timestamptz', (c) => c.notNull())
      .addColumn('started_at', 'timestamptz')
      .addColumn('finished_at', 'timestamptz')
      .addColumn('duration_ms', 'integer')
      .addColumn('error', 'text')
      .addColumn('stats', 'jsonb')
      .addColumn('log', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
      .execute();
    await db.schema.createIndex('scan_runs_repo_idx').on('scan_runs').columns(['repo_id', 'queued_at desc']).execute();
    await db.schema.createIndex('scan_runs_queued_idx').on('scan_runs').column('queued_at desc').execute();
    await db.schema.createIndex('scan_runs_status_idx').on('scan_runs').column('status').execute();

    await db.schema
      .createTable('jobs')
      .addColumn('id', 'uuid', (c) => c.primaryKey())
      .addColumn('type', 'text', (c) => c.notNull())
      .addColumn('payload', 'jsonb', (c) => c.notNull())
      .addColumn('status', 'text', (c) => c.notNull())
      .addColumn('priority', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('run_at', 'timestamptz', (c) => c.notNull())
      .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('max_attempts', 'integer', (c) => c.notNull())
      .addColumn('locked_by', 'text')
      .addColumn('locked_until', 'timestamptz')
      .addColumn('last_error', 'text')
      .addColumn('dedupe_key', 'text')
      .addColumn('active_dedupe_key', 'text', (c) => c.unique())
      .addColumn('created_at', 'timestamptz', (c) => c.notNull())
      .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
      .addColumn('finished_at', 'timestamptz')
      .execute();
    await db.schema.createIndex('jobs_runnable_idx').on('jobs').columns(['status', 'type', 'run_at']).execute();
    await db.schema.createIndex('jobs_finished_idx').on('jobs').column('finished_at').execute();

    await db.schema
      .createTable('locks')
      .addColumn('name', 'text', (c) => c.primaryKey())
      .addColumn('owner', 'text', (c) => c.notNull())
      .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
      .execute();
  },
};

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
