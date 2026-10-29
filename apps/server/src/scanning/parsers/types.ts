import { type Ecosystem } from '@argus/shared';

export interface ParsedDependency {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  direct: boolean;
  dev: boolean;
  license: string | null;
  /** Repository-relative path of the file the dependency was read from. */
  manifestPath: string;
  /** True when the version was derived from a range because no lockfile pins it. */
  unpinned?: boolean;
}
