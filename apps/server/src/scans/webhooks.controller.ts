import { BadRequestException, Controller, HttpCode, Inject, Logger, Param, ParseUUIDPipe, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { type DataStore } from '@argus/data';
import { type Request } from 'express';
import { Public, SkipCsrf } from '../auth/decorators';
import { DATA_STORE } from '../core/tokens';
import { parseWebhook, verifyWebhookSignature } from '../sources/providers';
import { SourcesService } from '../sources/sources.service';
import { ScansService } from './scans.service';

/** Largest webhook body read. Push payloads are well below it (providers trim the commit list). */
export const WEBHOOK_BODY_LIMIT = '10mb';
/** Webhooks per minute from one address: enough for busy organisations, and a cap on unsigned floods. */
export const WEBHOOK_RATE_LIMIT = { default: { limit: 120, ttl: 60_000 } };

/**
 * Push notifications from GitHub / Bitbucket. Authenticated by an HMAC signature over the raw body
 * using the per-source webhook secret, not by user session.
 */
@Controller('webhooks')
@Public()
@SkipCsrf()
@Throttle(WEBHOOK_RATE_LIMIT)
export class WebhooksController {
  private readonly logger = new Logger('Webhooks');

  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly sources: SourcesService,
    private readonly scans: ScansService,
  ) {}

  @Post(':sourceId')
  @HttpCode(202)
  async receive(@Param('sourceId', ParseUUIDPipe) sourceId: string, @Req() req: Request) {
    // The body is still raw bytes here: nothing is parsed before the signature is verified. An unknown source gets
    // the same answer as a bad signature, so the endpoint does not reveal which source ids exist.
    const raw: unknown = req.body;
    const source = await this.store.sources.findById(sourceId);
    const signature = req.get('x-hub-signature-256') ?? req.get('x-hub-signature');
    if (!source || !Buffer.isBuffer(raw) || !raw.length || !verifyWebhookSignature(this.sources.decryptWebhookSecret(source), raw, signature)) {
      this.logger.warn(`Rejected webhook for ${source ? `source ${source.name}` : `unknown source ${sourceId}`}: invalid or missing signature`);
      throw new UnauthorizedException('Invalid webhook signature.');
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BadRequestException('The webhook body is not valid JSON.');
    }

    const event = parseWebhook(source.provider, req.headers, body);
    if (event.kind === 'ping') return { status: 'ok', message: 'pong' };
    if (event.kind === 'ignored') return { status: 'ignored', reason: event.reason };

    const repo = await this.store.repositories.findByExternalId(source.id, event.externalId);
    if (!repo || repo.removedAt) return { status: 'ignored', reason: 'repository not known to Argus (try syncing the source)' };
    if (!repo.active) return { status: 'ignored', reason: 'repository is not active' };
    if (!repo.scanOnPush) return { status: 'ignored', reason: 'scan on push is disabled for this repository' };
    const branch = repo.branch ?? repo.defaultBranch;
    if (branch && !event.branches.includes(branch)) return { status: 'ignored', reason: `push was not to ${branch}` };

    const { run, created } = await this.scans.enqueue(repo, 'push', null);
    return { status: created ? 'queued' : 'already_queued', runId: run?.id ?? null };
  }
}
