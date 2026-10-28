import { Inject, Injectable, Logger } from '@nestjs/common';
import { type AuditOutcome, type DataStore } from '@argus/data';
import { DATA_STORE } from './tokens';

export interface AuditActor {
  id: string;
  username: string;
}

export interface AuditRecord {
  action: string;
  actor?: AuditActor | null;
  target?: { type: string; id: string } | null;
  outcome?: AuditOutcome;
  details?: Record<string, unknown> | null;
  ip?: string | null;
}

/** Append-only audit trail for security-relevant actions. Never put secrets in details. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(DATA_STORE) private readonly store: DataStore) {}

  async record(r: AuditRecord): Promise<void> {
    try {
      await this.store.audit.append({
        action: r.action,
        actorId: r.actor?.id ?? null,
        actorName: r.actor?.username ?? null,
        targetType: r.target?.type ?? null,
        targetId: r.target?.id ?? null,
        outcome: r.outcome ?? 'success',
        details: r.details ?? null,
        ip: r.ip ?? null,
      });
    } catch (err) {
      // Auditing must not take down the primary action, but a failure here is always worth an error log.
      this.logger.error({ err, action: r.action }, 'Failed to write audit entry');
    }
  }
}
