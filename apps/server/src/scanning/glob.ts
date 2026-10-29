/**
 * Minimal glob matching for repository paths (always "/"-separated, relative to the repository root):
 * `**` any number of directories, `*` anything except "/", `?` one character. A pattern without "/"
 * matches the file name anywhere (gitignore-style), and a trailing "/" matches a directory and everything in it.
 */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim().replace(/^\.\//, '').replace(/^\//, '');
  if (p.endsWith('/')) p += '**';
  const anywhere = !p.includes('/');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${anywhere ? '(?:.*/)?' : ''}${re}$`, 'i');
}

export function compileGlobs(patterns: string[]): (path: string) => boolean {
  const res = patterns.filter(Boolean).map(globToRegExp);
  return (path) => res.some((re) => re.test(path));
}
