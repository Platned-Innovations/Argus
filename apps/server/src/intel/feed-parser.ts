import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

export interface FeedEntry {
  guid: string;
  title: string;
  link: string | null;
  publishedAt: Date | null;
  /** Plain text (HTML removed), capped. */
  summary: string;
}

const MAX_SUMMARY = 4000;
const MAX_ENTRIES = 200;

// Feeds are untrusted: any DOCTYPE is removed before parsing (see parseFeed), so only XML's predefined entities are decoded.
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: true, htmlEntities: false, trimValues: true, parseTagValue: false });

type Node = Record<string, unknown> | string | undefined;

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

function text(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return text(o['#text'] ?? o['__cdata'] ?? '');
  }
  return '';
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

/** Converts feed HTML to plain text: drops scripts, styles and tags, decodes common entities, collapses whitespace. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (m, n: string) => NAMED[n.toLowerCase()] ?? m)
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function date(v: unknown): Date | null {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function safeLink(v: string | null): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function entry(guid: string, title: string, link: string | null, published: Date | null, body: string): FeedEntry | null {
  const t = htmlToText(title).slice(0, 500);
  if (!t) return null;
  const l = safeLink(link);
  const id = guid || l || t;
  return { guid: createHash('sha256').update(id).digest('hex'), title: t, link: l, publishedAt: published, summary: htmlToText(body).slice(0, MAX_SUMMARY) };
}

/** Parses RSS 2.0, RSS 1.0 (RDF) and Atom feeds. Throws if the document is not a recognised feed. */
export function parseFeed(body: string): FeedEntry[] {
  // Dropping the DOCTYPE means no custom or external entities can be declared (no "billion laughs" expansion).
  const doc = xml.parse(body.replace(/<!DOCTYPE(?:[^[>]|\[[\s\S]*?\])*>/gi, '')) as Record<string, Node>;
  const out: FeedEntry[] = [];
  const rss = doc.rss as Record<string, Node> | undefined;
  const rdf = doc['rdf:RDF'] as Record<string, Node> | undefined;
  const atom = doc.feed as Record<string, Node> | undefined;

  if (rss || rdf) {
    const items = rss ? asArray((rss.channel as Record<string, Node> | undefined)?.item) : asArray(rdf?.item);
    for (const raw of items as Record<string, unknown>[]) {
      const body = text(raw['content:encoded']) || text(raw.description);
      const e = entry(text(raw.guid), text(raw.title), text(raw.link) || null, date(raw.pubDate ?? raw['dc:date']), body);
      if (e) out.push(e);
    }
  } else if (atom) {
    for (const raw of asArray(atom.entry) as Record<string, unknown>[]) {
      const links = asArray(raw.link as Record<string, string> | Record<string, string>[]);
      const link = (links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0])?.['@_href'] ?? null;
      const e = entry(text(raw.id), text(raw.title), link, date(raw.published ?? raw.updated), text(raw.content) || text(raw.summary));
      if (e) out.push(e);
    }
  } else {
    throw new Error('Not an RSS or Atom feed.');
  }
  return out.slice(0, MAX_ENTRIES);
}
