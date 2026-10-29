import { type DashboardDto, type Severity, SEVERITIES } from '@argus/shared';

/**
 * A deliberately small PDF 1.4 writer: A4 pages, the standard Helvetica fonts (no embedding), text, filled
 * rectangles and lines. Enough for a one- or two-page report, with no third-party dependency.
 */
export class PdfWriter {
  static readonly WIDTH = 595;
  static readonly HEIGHT = 842;
  private readonly pages: string[][] = [];

  constructor() {
    this.addPage();
  }

  addPage(): void {
    this.pages.push([]);
  }

  private get ops(): string[] {
    return this.pages[this.pages.length - 1];
  }

  /** `y` is measured from the top of the page, to the text baseline. */
  text(x: number, y: number, s: string, opts: { size?: number; bold?: boolean; color?: string } = {}): void {
    const size = opts.size ?? 10;
    this.ops.push(`BT ${rgb(opts.color ?? '#0f172a')} rg /${opts.bold ? 'F2' : 'F1'} ${size} Tf ${num(x)} ${num(PdfWriter.HEIGHT - y)} Td (${pdfString(s)}) Tj ET`);
  }

  /** Filled rectangle; `y` is its top edge, from the top of the page. */
  rect(x: number, y: number, w: number, h: number, color: string): void {
    this.ops.push(`${rgb(color)} rg ${num(x)} ${num(PdfWriter.HEIGHT - y - h)} ${num(w)} ${num(h)} re f`);
  }

  line(x1: number, y1: number, x2: number, y2: number, color = '#e2e8f0', width = 0.75): void {
    this.ops.push(`${rgb(color)} RG ${num(width)} w ${num(x1)} ${num(PdfWriter.HEIGHT - y1)} m ${num(x2)} ${num(PdfWriter.HEIGHT - y2)} l S`);
  }

  toBuffer(meta: { title: string; producer: string }): Buffer {
    const objects: Buffer[] = [];
    const add = (body: string | Buffer) => objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
    // 1 catalog, 2 page tree, 3-4 fonts, 5 info; then a content stream and a page object per page.
    const firstPage = 6;
    const kids = this.pages.map((_, i) => `${firstPage + i * 2 + 1} 0 R`).join(' ');
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add(`<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`);
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    add(`<< /Title (${pdfString(meta.title)}) /Producer (${pdfString(meta.producer)}) >>`);
    this.pages.forEach((ops, i) => {
      const content = Buffer.from(ops.join('\n'), 'latin1');
      add(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream', 'latin1')]));
      add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PdfWriter.WIDTH} ${PdfWriter.HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${firstPage + i * 2} 0 R >>`);
    });

    const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    const offsets: number[] = [];
    let length = parts[0].length;
    objects.forEach((body, i) => {
      offsets.push(length);
      const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
      parts.push(obj);
      length += obj.length;
    });
    const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${length}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(parts);
  }
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();

function rgb(hex: string): string {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => num(c / 255)).join(' ');
}

const REPLACEMENTS: Record<string, string> = { '—': '-', '–': '-', '…': '...', '‘': "'", '’': "'", '“': '"', '”': '"', '•': '-', ' ': ' ' };

/** A PDF literal string in WinAnsi (Latin-1 here): characters outside it become "?", and \, ( and ) are escaped. */
export function pdfString(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = REPLACEMENTS[ch] ?? ch;
    for (const x of c) {
      const code = x.codePointAt(0)!;
      if (x === '\\' || x === '(' || x === ')') out += `\\${x}`;
      else if (code < 32) out += ' ';
      else if (code > 255) out += '?';
      else out += x;
    }
  }
  return out;
}

const SEVERITY_COLOR: Record<Severity, string> = { critical: '#dc2626', high: '#f97316', medium: '#d97706', low: '#0284c7', info: '#64748b' };
const MUTED = '#64748b';
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}...` : s);

/** The posture report (the printable Reports page) as a PDF, e.g. for the monthly email. */
export function dashboardPdf(d: DashboardDto, opts: { product: string; scope: string; periodLabel: string }): Buffer {
  const pdf = new PdfWriter();
  const left = 48;
  const right = PdfWriter.WIDTH - 48;
  let y = 64;
  const ensure = (needed: number) => {
    if (y + needed > PdfWriter.HEIGHT - 48) {
      pdf.addPage();
      y = 56;
    }
  };
  const heading = (s: string) => {
    ensure(48);
    y += 26;
    pdf.text(left, y, s, { size: 12, bold: true });
    y += 8;
    pdf.line(left, y, right, y);
    y += 14;
  };
  const table = (cols: { label: string; x: number; max: number }[], rows: string[][], empty: string) => {
    ensure(30);
    for (const c of cols) pdf.text(c.x, y, c.label, { size: 8, bold: true, color: MUTED });
    y += 14;
    if (!rows.length) {
      pdf.text(left, y, empty, { size: 9, color: MUTED });
      y += 14;
      return;
    }
    for (const r of rows) {
      ensure(14);
      r.forEach((cell, i) => pdf.text(cols[i].x, y, clip(cell, cols[i].max), { size: 9 }));
      y += 14;
    }
  };

  pdf.text(left, y - 22, opts.product, { size: 9, bold: true, color: '#4f46e5' });
  pdf.text(left, y, 'Security report', { size: 20, bold: true });
  y += 18;
  pdf.text(left, y, `${opts.periodLabel} - ${opts.scope} - generated ${d.generatedAt.slice(0, 16).replace('T', ' ')} UTC`, { size: 9, color: MUTED });

  // Headline figures.
  y += 22;
  const kpis: [string, string][] = [
    ['Open findings', String(d.openTotal)],
    ['Critical / high', `${d.open.critical} / ${d.open.high}`],
    ['SLA compliance', d.sla.compliancePct === null ? 'n/a' : `${d.sla.compliancePct}%`],
    ['Overdue tickets', String(d.sla.breached)],
    ['Time to fix (critical)', d.mttrDays.critical === null ? 'n/a' : `${d.mttrDays.critical} d`],
  ];
  const boxW = (right - left - 4 * 8) / 5;
  kpis.forEach(([label, value], i) => {
    const x = left + i * (boxW + 8);
    pdf.rect(x, y, boxW, 46, '#f1f5f9');
    pdf.text(x + 8, y + 16, label, { size: 7.5, color: MUTED });
    pdf.text(x + 8, y + 36, value, { size: 15, bold: true });
  });
  y += 46;

  heading('Open findings by severity');
  const max = Math.max(1, ...SEVERITIES.map((s) => d.open[s]));
  for (const s of SEVERITIES) {
    pdf.text(left, y, s[0].toUpperCase() + s.slice(1), { size: 9 });
    const w = ((right - left - 140) * d.open[s]) / max;
    if (d.open[s]) pdf.rect(left + 70, y - 8, Math.max(w, 2), 9, SEVERITY_COLOR[s]);
    pdf.text(left + 76 + w, y, String(d.open[s]), { size: 9, color: MUTED });
    y += 15;
  }
  if (d.suppressed) {
    pdf.text(left, y, `${d.suppressed} more finding(s) are suppressed.`, { size: 8, color: MUTED });
    y += 12;
  }

  heading('Found and fixed, by week');
  table(
    [
      { label: 'WEEK OF', x: left, max: 20 },
      { label: 'FOUND', x: left + 160, max: 10 },
      { label: 'FIXED', x: left + 240, max: 10 },
    ],
    d.newVsFixed.slice(-13).map((w) => [w.week, String(w.opened), String(w.fixed)]),
    'No activity in this period.',
  );

  heading('Riskiest repositories');
  table(
    [
      { label: 'REPOSITORY', x: left, max: 52 },
      { label: 'OPEN', x: left + 300, max: 8 },
      { label: 'CRITICAL', x: left + 350, max: 8 },
      { label: 'HIGH', x: left + 410, max: 8 },
      { label: 'RISK', x: left + 460, max: 8 },
    ],
    d.topRepos.slice(0, 10).map((r) => [r.fullName, String(r.openFindings), String(r.critical), String(r.high), String(r.riskTotal)]),
    'No open findings.',
  );

  heading('Expiring certificates and credentials (next 180 days)');
  table(
    [
      { label: 'ITEM', x: left, max: 62 },
      { label: 'EXPIRES', x: left + 360, max: 12 },
      { label: 'DAYS LEFT', x: left + 440, max: 10 },
    ],
    d.expiring.slice(0, 20).map((e) => [`${e.kind === 'credential' ? 'Credential' : 'Certificate'}: ${e.title}`, e.expiresAt.slice(0, 10), String(e.daysLeft)]),
    'Nothing expires in the next 180 days.',
  );

  heading('End-of-life frameworks and runtimes');
  table(
    [
      { label: 'PRODUCT', x: left, max: 50 },
      { label: 'END OF LIFE', x: left + 300, max: 12 },
      { label: 'REPOSITORIES', x: left + 400, max: 10 },
    ],
    d.eol.slice(0, 20).map((e) => [`${e.product} ${e.cycle}`, e.eol ?? 'unknown', String(e.repos)]),
    'No end-of-life frameworks found.',
  );

  return pdf.toBuffer({ title: `${opts.product} - Security report`, producer: opts.product });
}
