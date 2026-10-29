import { type Provider, type Repository, type ScanRun } from '@argus/data';
import { type RepositoryDto, type ScanRunDto } from '@argus/shared';

export function toRepositoryDto(r: Repository, provider: Provider): RepositoryDto {
  return {
    id: r.id,
    sourceId: r.sourceId,
    provider,
    fullName: r.fullName,
    name: r.name,
    htmlUrl: r.htmlUrl,
    defaultBranch: r.defaultBranch,
    visibility: r.visibility,
    language: r.language,
    description: r.description,
    archived: r.archived,
    removed: r.removedAt !== null,
    lastPushedAt: r.lastPushedAt?.toISOString() ?? null,
    active: r.active,
    teamId: r.teamId,
    criticality: r.criticality,
    branch: r.branch,
    schedule: { preset: r.schedule.preset, cron: r.schedule.cron ?? null },
    scanOnPush: r.scanOnPush,
    jiraProjectKey: r.jiraProjectKey,
    notifyEmails: r.notifyEmails,
    disabledScanners: r.disabledScanners,
    nextScanAt: r.nextScanAt?.toISOString() ?? null,
    lastScanAt: r.lastScanAt?.toISOString() ?? null,
    lastScanStatus: r.lastScanStatus,
    lastScanRunId: r.lastScanRunId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toScanRunDto(r: ScanRun, repoFullName: string | null, withLog = false): ScanRunDto {
  return {
    id: r.id,
    repoId: r.repoId,
    repoFullName,
    trigger: r.trigger,
    status: r.status,
    requestedBy: r.requestedBy,
    branch: r.branch,
    commitSha: r.commitSha,
    attempts: r.attempts,
    queuedAt: r.queuedAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    durationMs: r.durationMs,
    error: r.error,
    stats: r.stats,
    ...(withLog ? { log: r.log } : {}),
  };
}
