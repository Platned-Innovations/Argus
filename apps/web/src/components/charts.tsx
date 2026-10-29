import { type ReactNode, useEffect, useRef, useState } from 'react';

export interface Series {
  key: string;
  label: string;
  /** CSS colour, e.g. var(--series-1). */
  color: string;
}

type Row = { x: string } & Record<string, number | string>;

const PAD = { top: 12, right: 64, bottom: 24, left: 36 };

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** "Nice" upper bound and 4 ticks for a y axis. */
function yTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_v, i) => i * step);
}

function Legend({ series }: { series: Series[] }) {
  return (
    <div className="flex flex-wrap gap-4 text-xs text-slate-600 dark:text-slate-300">
      {series.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color, height: 3 }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x + 12, 0), width - 170);
  return (
    <div className="pointer-events-none absolute z-10 w-40 rounded-md bg-white px-3 py-2 text-xs shadow-lg ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700" style={{ left, top: Math.max(0, y - 10) }}>
      {children}
    </div>
  );
}

function DataTable({ rows, series, xLabel }: { rows: Row[]; series: Series[]; xLabel: string }) {
  return (
    <details className="mt-2 text-xs text-slate-500">
      <summary className="cursor-pointer select-none">Show data table</summary>
      <div className="mt-2 max-h-56 overflow-auto">
        <table className="w-full text-left">
          <thead>
            <tr>
              <th className="py-1 pr-3 font-medium">{xLabel}</th>
              {series.map((s) => (
                <th key={s.key} className="py-1 pr-3 font-medium">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="tabular-nums text-slate-700 dark:text-slate-300">
            {rows.map((r) => (
              <tr key={r.x}>
                <td className="py-0.5 pr-3">{r.x}</td>
                {series.map((s) => (
                  <td key={s.key} className="py-0.5 pr-3">
                    {r[s.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Lines over time with a hover crosshair, a legend, end-of-line labels and a table view. */
export function LineChart({ rows, series, height = 200, xLabel = 'Date' }: { rows: Row[]; series: Series[]; height?: number; xLabel?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => Number(r[s.key]))));
  const ticks = yTicks(max);
  const top = ticks[ticks.length - 1];
  const iw = width - PAD.left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (rows.length <= 1 ? 0 : (i / (rows.length - 1)) * iw);
  const y = (v: number) => PAD.top + ih - (v / top) * ih;
  const step = Math.max(1, Math.ceil(rows.length / 6));
  const last = rows.length - 1;

  return (
    <div>
      <Legend series={series} />
      <div ref={ref} className="relative mt-2" onMouseLeave={() => setHover(null)}>
        <svg width={width} height={height} role="img" aria-label={`${series.map((s) => s.label).join(' and ')} over time`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="stroke-slate-200 dark:stroke-slate-800" strokeWidth={1} />
              <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-slate-500 text-[10px] tabular-nums">
                {t}
              </text>
            </g>
          ))}
          {rows.map((r, i) =>
            i % step === 0 || i === last ? (
              <text key={r.x} x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'} className="fill-slate-500 text-[10px]">
                {r.x.slice(5)}
              </text>
            ) : null,
          )}
          {series.map((s) => (
            <g key={s.key}>
              <polyline fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" points={rows.map((r, i) => `${x(i)},${y(Number(r[s.key]))}`).join(' ')} />
              {last >= 0 && (
                <text x={x(last) + 6} y={y(Number(rows[last][s.key]))} dy="0.32em" className="fill-slate-700 text-[10px] font-medium dark:fill-slate-200">
                  {rows[last][s.key]} {s.label.split(' ')[0].toLowerCase()}
                </text>
              )}
            </g>
          ))}
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + ih} className="stroke-slate-400" strokeWidth={1} strokeDasharray="3 3" />
              {series.map((s) => (
                <circle key={s.key} cx={x(hover)} cy={y(Number(rows[hover][s.key]))} r={4} fill={s.color} className="stroke-white dark:stroke-slate-900" strokeWidth={2} />
              ))}
            </g>
          )}
          {/* Hit area wider than the marks: the whole plot. */}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={iw}
            height={ih}
            fill="transparent"
            onMouseMove={(e) => {
              const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
              const i = Math.round(((e.clientX - rect.left) / rect.width) * last);
              setHover(Math.min(last, Math.max(0, i)));
            }}
          />
        </svg>
        {hover !== null && (
          <Tooltip x={x(hover)} y={PAD.top} width={width}>
            <div className="mb-1 font-medium text-slate-900 dark:text-slate-100">{rows[hover].x}</div>
            {series.map((s) => (
              <div key={s.key} className="flex justify-between gap-2 text-slate-600 dark:text-slate-300">
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block size-2 rounded-full" style={{ background: s.color }} />
                  {s.label}
                </span>
                <span className="tabular-nums">{rows[hover][s.key]}</span>
              </div>
            ))}
          </Tooltip>
        )}
      </div>
      <DataTable rows={rows} series={series} xLabel={xLabel} />
    </div>
  );
}

/** Grouped bars (e.g. found vs fixed per week) with per-bar hover. */
export function GroupedBarChart({ rows, series, height = 200, xLabel = 'Week' }: { rows: Row[]; series: Series[]; height?: number; xLabel?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; s: Series } | null>(null);
  const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => Number(r[s.key]))));
  const ticks = yTicks(max);
  const top = ticks[ticks.length - 1];
  const right = 12;
  const iw = width - PAD.left - right;
  const ih = height - PAD.top - PAD.bottom;
  const group = iw / Math.max(1, rows.length);
  const gap = 2;
  const bar = Math.max(2, Math.min(18, (group * 0.7 - gap * (series.length - 1)) / series.length));
  const y = (v: number) => PAD.top + ih - (v / top) * ih;
  const step = Math.max(1, Math.ceil(rows.length / 8));

  return (
    <div>
      <Legend series={series} />
      <div ref={ref} className="relative mt-2" onMouseLeave={() => setHover(null)}>
        <svg width={width} height={height} role="img" aria-label={`${series.map((s) => s.label).join(' and ')} per ${xLabel.toLowerCase()}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - right} y1={y(t)} y2={y(t)} className="stroke-slate-200 dark:stroke-slate-800" strokeWidth={1} />
              <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-slate-500 text-[10px] tabular-nums">
                {t}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const gx = PAD.left + i * group + (group - (bar * series.length + gap * (series.length - 1))) / 2;
            return (
              <g key={r.x}>
                {series.map((s, j) => {
                  const v = Number(r[s.key]);
                  const h = Math.max(v > 0 ? 2 : 0, (v / top) * ih);
                  const bx = gx + j * (bar + gap);
                  const by = PAD.top + ih - h;
                  // Rounded data end (top), square at the baseline.
                  const rr = Math.min(4, bar / 2, h);
                  const d = h ? `M${bx},${PAD.top + ih} V${by + rr} Q${bx},${by} ${bx + rr},${by} H${bx + bar - rr} Q${bx + bar},${by} ${bx + bar},${by + rr} V${PAD.top + ih} Z` : '';
                  return (
                    <g key={s.key} onMouseEnter={() => setHover({ i, s })}>
                      {d && <path d={d} fill={s.color} opacity={hover && (hover.i !== i || hover.s.key !== s.key) ? 0.55 : 1} />}
                      {/* Hit target taller than the bar. */}
                      <rect x={bx} y={PAD.top} width={bar + gap} height={ih} fill="transparent" />
                    </g>
                  );
                })}
                {i % step === 0 && (
                  <text x={PAD.left + i * group + group / 2} y={height - 6} textAnchor="middle" className="fill-slate-500 text-[10px]">
                    {r.x.slice(5)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {hover && (
          <Tooltip x={PAD.left + hover.i * group + group / 2} y={PAD.top} width={width}>
            <div className="mb-1 font-medium text-slate-900 dark:text-slate-100">
              {xLabel} of {rows[hover.i].x}
            </div>
            <div className="flex justify-between gap-2 text-slate-600 dark:text-slate-300">
              <span className="inline-flex items-center gap-1">
                <span className="inline-block size-2 rounded-full" style={{ background: hover.s.color }} />
                {hover.s.label}
              </span>
              <span className="tabular-nums">{rows[hover.i][hover.s.key]}</span>
            </div>
          </Tooltip>
        )}
      </div>
      <DataTable rows={rows} series={series} xLabel={xLabel} />
    </div>
  );
}
