import { Controller, HttpCode, Inject, Logger, NotFoundException, Param, ParseUUIDPipe, Post, Req, UnauthorizedException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { type DataStore } from '@argus/data';
import { type Request } from 'express';
import { Public, SkipCsrf } from '../auth/decorators';
import { DATA_STORE } from '../core/tokens';
import { parseWebhook, verifyWebhookSignature } from '../sources/providers';
import { SourcesService } from '../sources/sources.service';
import { ScansService } from './scans.service';

declare module 'express-serve-static-core' {
  interface Request {
    rawBody?: Buffer;
  }
}

/**
 * Push notifications from GitHub / Bitbucket. Authenticated by an HMAC signature over the raw body
 * using the per-source webhook secret, not by user session.
 */
@Controller('webhooks')
@Public()
@SkipCsrf()
@SkipThrottle()
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
    const source = await this.store.sources.findById(sourceId);
    if (!source) throw new NotFoundException();
    const signature = req.get('x-hub-signature-256') ?? req.get('x-hub-signature');
    if (!req.rawBody || !verifyWebhookSignature(this.sources.decryptWebhookSecret(source), req.rawBody, signature)) {
      this.logger.warn(`Rejected webhook for source ${source.name}: invalid or missing signature`);
      throw new UnauthorizedException('Invalid webhook signature.');
    }

    const event = parseWebhook(source.provider, req.headers, req.body);
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
