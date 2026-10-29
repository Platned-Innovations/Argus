import { Injectable, Logger } from '@nestjs/common';
import { type Repository, type ScanRun, type Ticket } from '@argus/data';
import { type EmergingThreatDto } from '@argus/shared';

/** A new advisory that matched repositories between scans. */
export interface EmergingThreat extends EmergingThreatDto {
  repoIds: string[];
  teamIds: (string | null)[];
}

/** Events published by one module and handled by others, so modules do not depend on each other directly. */
export interface DomainEventMap {
  /** A scan finished and its findings were reconciled. */
  'scan.completed': { repo: Repository; run: ScanRun };
  /** A scan failed on its final attempt. */
  'scan.failed': { repo: Repository; run: ScanRun; error: string };
  /** Findings changed outside a scan (e.g. a suppression was added or removed). */
  'findings.changed': { repoIds: string[] };
  'ticket.created': { ticket: Ticket };
  'ticket.reopened': { ticket: Ticket };
  'ticket.sla_breached': { ticket: Ticket };
  /** Continuous re-matching opened findings for newly published advisories. */
  'intel.emerging_threats': { threats: EmergingThreat[] };
  /** The leader scheduler ticked (at most once per interval across all workers). */
  'scheduler.tick': { now: Date };
}

type Handler<K extends keyof DomainEventMap> = (payload: DomainEventMap[K]) => Promise<void> | void;

@Injectable()
export class DomainEvents {
  private readonly logger = new Logger('DomainEvents');
  private readonly handlers = new Map<keyof DomainEventMap, Handler<never>[]>();

  on<K extends keyof DomainEventMap>(event: K, handler: Handler<K>): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler as Handler<never>]);
  }

  /**
   * Runs every handler in registration order and waits for them. A failing handler is logged and does not
   * stop the others or the publisher.
   */
  async emit<K extends keyof DomainEventMap>(event: K, payload: DomainEventMap[K]): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        await (handler as Handler<K>)(payload);
      } catch (err) {
        this.logger.error({ err, event }, `Handler for ${event} failed`);
      }
    }
  }
}
