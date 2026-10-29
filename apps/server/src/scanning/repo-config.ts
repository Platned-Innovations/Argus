import { SCANNERS, type ScannerName } from '@argus/shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const REPO_CONFIG_FILES = ['.argus.yml', '.argus.yaml'];

const schema = z
  .object({
    ignore: z.object({ paths: z.array(z.string().min(1).max(500)).max(200).default([]) }).partial().default({}),
    scanners: z.partialRecord(z.enum(SCANNERS), z.boolean()).default({}),
    suppress: z
      .array(
        z.object({
          scanner: z.enum(SCANNERS).optional(),
          rule: z.string().min(1).max(200).optional(),
          path: z.string().min(1).max(500).optional(),
          package: z.string().min(1).max(214).optional(),
          reason: z.string().min(3).max(1000),
          expires: z.coerce.date().optional(),
        }),
      )
      .max(500)
      .default([]),
  })
  .strict();

export interface RepoScanConfig {
  ignorePaths: string[];
  scanners: Partial<Record<ScannerName, boolean>>;
  suppress: { scanner?: ScannerName; rule?: string; path?: string; package?: string; reason: string; expires?: Date }[];
  /** Validation problems, reported in the scan log; an invalid file is ignored as a whole. */
  errors: string[];
}

export const EMPTY_REPO_CONFIG: RepoScanConfig = { ignorePaths: [], scanners: {}, suppress: [], errors: [] };

/**
 * `.argus.yml` lets repository owners tune scanning next to their code:
 *
 *   ignore:
 *     paths: ["test/fixtures/**", "docs/"]
 *   scanners:
 *     licenses: false
 *   suppress:
 *     - rule: GHSA-xxxx-xxxx-xxxx
 *       package: lodash
 *       reason: Not reachable; tracked in PAY-123
 *       expires: 2027-01-31
 */
export function parseRepoConfig(text: string): RepoScanConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text, { maxAliasCount: 50 }) ?? {};
  } catch (err) {
    return { ...EMPTY_REPO_CONFIG, errors: [`.argus.yml is not valid YAML: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ...EMPTY_REPO_CONFIG, errors: parsed.error.issues.map((i) => `.argus.yml ${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  const v = parsed.data;
  return {
    ignorePaths: v.ignore.paths ?? [],
    scanners: v.scanners,
    suppress: v.suppress.filter((s) => s.scanner || s.rule || s.path || s.package),
    errors: v.suppress.some((s) => !(s.scanner || s.rule || s.path || s.package)) ? ['.argus.yml: suppress entries need at least one of scanner, rule, path or package; those entries were ignored.'] : [],
  };
}
