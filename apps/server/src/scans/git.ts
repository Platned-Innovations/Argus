import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Environment variables passed through to git (proxy, TLS trust store, locale, Windows essentials). */
const PASSTHROUGH = ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'GIT_SSL_CAINFO', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];

export class GitError extends Error {
  override name = 'GitError';

  constructor(
    message: string,
    readonly stderr: string,
    readonly timedOut: boolean,
  ) {
    super(message);
  }
}

/**
 * Runs git with an isolated configuration: no user/system config, no prompts, no LFS downloads,
 * only http(s) transports, and the credential passed as an HTTP header through the environment
 * (never in the URL or argv, so it does not show up in process listings or git error output).
 */
export async function runGit(args: string[], opts: { cwd?: string; home: string; authHeader?: string; timeoutMs: number }): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const k of PASSTHROUGH) if (process.env[k] !== undefined) env[k] = process.env[k];
  Object.assign(env, {
    HOME: opts.home,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    // A path that does not exist: git ignores a missing global config (os.devNull is rejected by Git for Windows).
    GIT_CONFIG_GLOBAL: join(opts.home, '.argus-no-global-gitconfig'),
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_ALLOW_PROTOCOL: 'https:http',
    ...(opts.authHeader ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: opts.authHeader } : {}),
  });
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: opts.cwd, env, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    return stdout.trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean; signal?: string };
    if (e.code === 'ENOENT') throw new GitError('git is not installed or not on PATH.', '', false);
    const stderr = (e.stderr ?? '').trim();
    const timedOut = !!e.killed && e.signal === 'SIGTERM';
    const lastLine = stderr.split(/\r?\n/).filter(Boolean).pop() ?? e.message;
    throw new GitError(timedOut ? `git ${args[0]} timed out.` : lastLine, stderr, timedOut);
  }
}
