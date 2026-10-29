import { Children, isValidElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { Link } from 'react-router';
import remarkGfm from 'remark-gfm';
import { resolveLink, slugify } from '../lib/docs';

/** Text content of rendered children, for heading anchors. */
function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : isValidElement<{ children?: ReactNode }>(c) ? textOf(c.props.children) : ''))
    .join('');
}

const heading = (Tag: 'h1' | 'h2' | 'h3' | 'h4', className: string): Components['h1'] =>
  function Heading({ children }) {
    const id = slugify(textOf(children));
    return (
      <Tag id={id} className={`group scroll-mt-6 ${className}`}>
        {children}
        {Tag !== 'h1' && (
          <a href={`#${id}`} aria-label="Link to this section" className="ml-2 text-slate-300 no-underline opacity-0 group-hover:opacity-100 dark:text-slate-600">
            #
          </a>
        )}
      </Tag>
    );
  };

/**
 * Renders a page from docs/ with the app's styles. Raw HTML in the Markdown is never rendered (react-markdown's
 * default), which keeps it compatible with the Content-Security-Policy.
 */
export function Markdown({ markdown, file }: { markdown: string; file: string }) {
  const components: Components = {
    h1: heading('h1', 'mb-4 text-2xl font-semibold tracking-tight'),
    h2: heading('h2', 'mt-10 mb-3 border-b border-slate-200 pb-1.5 text-xl font-semibold dark:border-slate-800'),
    h3: heading('h3', 'mt-8 mb-2 text-base font-semibold'),
    h4: heading('h4', 'mt-6 mb-2 text-sm font-semibold'),
    p: ({ children }) => <p className="my-3 leading-7">{children}</p>,
    ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-6 leading-7 marker:text-slate-400">{children}</ul>,
    ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6 leading-7 marker:text-slate-400">{children}</ol>,
    blockquote: ({ children }) => <blockquote className="my-4 border-l-4 border-indigo-300 bg-slate-50 px-4 py-1 text-slate-600 dark:border-indigo-500/50 dark:bg-slate-800/40 dark:text-slate-300">{children}</blockquote>,
    hr: () => <hr className="my-8 border-slate-200 dark:border-slate-800" />,
    table: ({ children }) => (
      <div className="my-4 overflow-x-auto rounded-md ring-1 ring-slate-200 dark:ring-slate-800">
        <table className="min-w-full text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-slate-50 text-left dark:bg-slate-800/60">{children}</thead>,
    th: ({ children }) => <th className="px-3 py-2 font-semibold whitespace-nowrap">{children}</th>,
    td: ({ children }) => <td className="border-t border-slate-200 px-3 py-2 align-top dark:border-slate-800">{children}</td>,
    pre: ({ children }) => <pre className="my-4 overflow-x-auto rounded-md bg-slate-900 p-4 text-[13px] leading-6 text-slate-100 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit">{children}</pre>,
    code: ({ children }) => <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.85em] text-slate-800 dark:bg-slate-800 dark:text-slate-200">{children}</code>,
    a: ({ href = '', children }) => {
      const link = resolveLink(file, href);
      const cls = 'font-medium text-indigo-600 hover:underline dark:text-indigo-400';
      if (link.kind === 'external') return <a href={link.href} target="_blank" rel="noreferrer" className={cls}>{children}</a>;
      if (link.kind === 'doc') return <Link to={link.to} className={cls}>{children}</Link>;
      if (link.kind === 'anchor') return <a href={`#${link.hash}`} className={cls}>{children}</a>;
      // A file outside docs/ (source code); the app does not serve it.
      return <span title={href}>{children}</span>;
    },
    img: ({ alt }) => <span className="text-slate-500">[{alt}]</span>,
  };
  return (
    <div className="max-w-3xl text-[15px] text-slate-700 dark:text-slate-300 [&_strong]:font-semibold [&_strong]:text-slate-900 dark:[&_strong]:text-slate-100">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
