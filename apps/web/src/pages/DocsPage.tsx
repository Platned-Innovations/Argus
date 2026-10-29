import { BookOpen, Braces, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useLocation, useParams } from 'react-router';
import { ApiReference } from '../components/ApiReference';
import { Markdown } from '../components/Markdown';
import { EmptyState, Input } from '../components/ui';
import { docsNav, getDoc, searchDocs } from '../lib/docs';
import { cn } from '../lib/utils';

const navLink = ({ isActive }: { isActive: boolean }) =>
  cn(
    'block rounded-md px-2 py-1 text-sm',
    isActive ? 'bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100',
  );

function DocsNav({ onNavigate }: { onNavigate(): void }) {
  const [query, setQuery] = useState('');
  const hits = useMemo(() => searchDocs(query), [query]);
  return (
    <nav aria-label="Documentation" className="space-y-5">
      <div className="relative">
        <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
        <Input placeholder="Search the docs" className="pl-9" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the docs" />
      </div>
      {query.trim() ? (
        <ul className="space-y-1">
          {hits.length ? (
            hits.map((h) => (
              <li key={h.slug}>
                <Link to={`/docs${h.slug ? `/${h.slug}` : ''}`} onClick={() => (setQuery(''), onNavigate())} className="block rounded-md px-2 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800">
                  <div className="text-sm font-medium">{h.title}</div>
                  <div className="line-clamp-2 text-xs text-slate-500 dark:text-slate-400">{h.snippet}</div>
                </Link>
              </li>
            ))
          ) : (
            <li className="px-2 text-sm text-slate-500">No pages match.</li>
          )}
        </ul>
      ) : (
        <>
          {docsNav().map((section) => (
            <div key={section.title}>
              <div className="mb-1 px-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">{section.title}</div>
              <ul className="space-y-0.5">
                {section.items.map((it) => (
                  <li key={it.slug}>
                    <NavLink to={`/docs${it.slug ? `/${it.slug}` : ''}`} end onClick={onNavigate} className={navLink}>
                      {it.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div>
            <div className="mb-1 px-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">API</div>
            <NavLink to="/docs/api" onClick={onNavigate} className={navLink}>
              <span className="inline-flex items-center gap-1.5">
                <Braces className="size-3.5" /> API reference
              </span>
            </NavLink>
          </div>
        </>
      )}
    </nav>
  );
}

/** In-app documentation: the guides from docs/ (bundled at build time) and a reference of the live REST API. */
export function DocsPage() {
  const slug = useParams()['*'] ?? '';
  const { hash } = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const isApi = slug === 'api';
  const doc = isApi ? null : getDoc(slug);

  // Scroll to the heading in the URL fragment, or to the top on a new page.
  useEffect(() => {
    const id = decodeURIComponent(hash.slice(1));
    const target = id ? document.getElementById(id) : null;
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [slug, hash]);

  return (
    <div className="lg:flex lg:gap-10">
      <aside className="mb-6 lg:sticky lg:top-8 lg:mb-0 lg:max-h-[calc(100vh-4rem)] lg:w-60 lg:shrink-0 lg:overflow-y-auto">
        <button onClick={() => setNavOpen((o) => !o)} aria-expanded={navOpen} className="mb-3 flex items-center gap-2 text-sm font-medium lg:hidden">
          <BookOpen className="size-4" /> {navOpen ? 'Hide contents' : 'Contents'}
        </button>
        <div className={cn(navOpen ? 'block' : 'hidden', 'lg:block')}>
          <DocsNav onNavigate={() => setNavOpen(false)} />
        </div>
      </aside>
      <article className="min-w-0 flex-1">
        {isApi ? (
          <ApiReference />
        ) : doc ? (
          <Markdown key={doc.file} markdown={doc.markdown} file={doc.file} />
        ) : (
          <EmptyState icon={<BookOpen className="size-5" />} title="Page not found" description="This documentation page does not exist. Pick one from the contents." />
        )}
      </article>
    </div>
  );
}
