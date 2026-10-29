import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Search } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { Badge, CenteredSpinner, ErrorAlert, Input } from './ui';

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  format?: string;
  anyOf?: Schema[];
  oneOf?: Schema[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
};
interface Parameter {
  name: string;
  in: 'path' | 'query';
  required?: boolean;
  schema?: Schema;
}
interface Operation {
  tags?: string[];
  description?: string;
  parameters?: Parameter[];
  requestBody?: { content?: { 'application/json'?: { schema?: Schema } } };
  security?: Record<string, string[]>[];
  'x-argus-permissions'?: string[];
}
interface OpenApiDoc {
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, Operation>>;
}

const METHOD_TONE: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'slate'> = { get: 'blue', post: 'green', put: 'amber', patch: 'amber', delete: 'red' };

/** A short, readable type: "string (email)", "array of string", "'low' | 'high'". */
function typeLabel(s: Schema | undefined): string {
  if (!s) return 'any';
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  const alt = s.anyOf ?? s.oneOf;
  if (alt) return alt.map(typeLabel).join(' or ');
  const t = Array.isArray(s.type) ? s.type.join(' or ') : (s.type ?? 'object');
  if (t === 'array') return `array of ${typeLabel(s.items)}`;
  return s.format ? `${t} (${s.format})` : t;
}

function constraints(s: Schema): string {
  const out: string[] = [];
  if (s.minimum !== undefined) out.push(`min ${s.minimum}`);
  if (s.maximum !== undefined) out.push(`max ${s.maximum}`);
  if (s.maxLength !== undefined) out.push(`up to ${s.maxLength} chars`);
  if (s.default !== undefined) out.push(`default ${JSON.stringify(s.default)}`);
  return out.join(', ');
}

function Fields({ rows }: { rows: { name: string; required: boolean; schema?: Schema; where?: string }[] }) {
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.where ?? ''}${r.name}`} className="border-t border-slate-200 first:border-t-0 dark:border-slate-800">
            <td className="py-1.5 pr-3 align-top font-mono text-[13px] whitespace-nowrap">
              {r.name}
              {r.required && <span className="ml-0.5 text-red-600">*</span>}
            </td>
            <td className="py-1.5 pr-3 align-top text-slate-600 dark:text-slate-300">
              <span className="font-mono text-[12px]">{typeLabel(r.schema)}</span>
              {r.where && <span className="ml-2 text-xs text-slate-400">in {r.where}</span>}
            </td>
            <td className="py-1.5 align-top text-xs text-slate-500">{[r.schema?.description, r.schema && constraints(r.schema)].filter(Boolean).join(' · ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Endpoint({ method, path, op }: { method: string; path: string; op: Operation }) {
  const [open, setOpen] = useState(false);
  const body = op.requestBody?.content?.['application/json']?.schema;
  const bodyRows = Object.entries(body?.properties ?? {}).map(([name, schema]) => ({ name, schema, required: body?.required?.includes(name) ?? false }));
  const params = op.parameters ?? [];
  const isPublic = Array.isArray(op.security) && op.security.length === 0;
  return (
    <li className="border-t border-slate-200 first:border-t-0 dark:border-slate-800">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50">
        <ChevronRight className={cn('size-4 shrink-0 text-slate-400 transition-transform', open && 'rotate-90')} />
        <span className="w-16 shrink-0">
          <Badge tone={METHOD_TONE[method] ?? 'slate'}>{method.toUpperCase()}</Badge>
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{path}</span>
        {isPublic ? <span className="text-xs text-slate-400">Public</span> : op['x-argus-permissions']?.length ? <span className="hidden text-xs text-slate-500 sm:inline">{op['x-argus-permissions'].join(', ')}</span> : null}
      </button>
      {open && (
        <div className="space-y-3 px-4 pb-4 pl-11 text-sm">
          {op.description && <p className="text-slate-600 dark:text-slate-300">{op.description}</p>}
          {params.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">Parameters</h4>
              <Fields rows={params.map((p) => ({ name: p.name, required: !!p.required, schema: p.schema, where: p.in }))} />
            </div>
          )}
          {body && (
            <div>
              <h4 className="mb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">JSON body</h4>
              {bodyRows.length ? <Fields rows={bodyRows} /> : <p className="font-mono text-[12px] text-slate-500">{typeLabel(body)}</p>}
            </div>
          )}
          {!params.length && !body && !op.description && <p className="text-slate-500">No parameters.</p>}
        </div>
      )}
    </li>
  );
}

/** Readable view of /api/v1/openapi.json, generated from the running server. */
export function ApiReference() {
  const [filter, setFilter] = useState('');
  const query = useQuery({ queryKey: ['openapi'], queryFn: () => api<OpenApiDoc>('/openapi.json'), staleTime: Infinity });
  if (query.isLoading) return <CenteredSpinner />;
  if (!query.data) return <ErrorAlert error={query.error} />;
  const doc = query.data;
  const f = filter.trim().toLowerCase();
  const groups = new Map<string, { method: string; path: string; op: Operation }[]>();
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (f && !`${method} ${path} ${op.description ?? ''} ${(op['x-argus-permissions'] ?? []).join(' ')}`.toLowerCase().includes(f)) continue;
      const tag = op.tags?.[0] ?? 'other';
      (groups.get(tag) ?? groups.set(tag, []).get(tag)!).push({ method, path, op });
    }
  }
  const total = [...groups.values()].reduce((n, g) => n + g.length, 0);
  return (
    <div className="max-w-4xl">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">API reference</h1>
      <p className="mb-2 text-[15px] leading-7 text-slate-600 dark:text-slate-300">{doc.info.description}</p>
      <p className="mb-6 text-sm text-slate-500">
        {doc.info.title} {doc.info.version}. Generated from the running server; download the{' '}
        <a href="/api/v1/openapi.json" className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
          OpenAPI 3.1 document
        </a>{' '}
        to use it in Postman or other tools. Fields marked <span className="text-red-600">*</span> are required.
      </p>
      <div className="relative mb-4 max-w-sm">
        <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
        <Input placeholder="Filter endpoints, e.g. tickets or users:manage" className="pl-9" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter endpoints" />
      </div>
      {!total && <p className="text-sm text-slate-500">No endpoints match.</p>}
      <div className="space-y-6">
        {[...groups.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([tag, ops]) => (
            <section key={tag}>
              <h2 className="mb-2 text-sm font-semibold capitalize">{tag.replace(/-/g, ' ')}</h2>
              <ul className="overflow-hidden rounded-md bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
                {ops.map((o) => (
                  <Endpoint key={`${o.method} ${o.path}`} {...o} />
                ))}
              </ul>
            </section>
          ))}
      </div>
    </div>
  );
}
