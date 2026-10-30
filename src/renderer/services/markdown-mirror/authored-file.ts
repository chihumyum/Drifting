/**
 * Authored files of the project Markdown folder (docs/markdown-mirror.md):
 * a small frontmatter with the fields an author may change, then the prose.
 * The body uses the Agent's schema-safe Markdown, so parsing what Drifting
 * wrote returns exactly the blocks it was rendered from.
 */
import type { WritingStatus } from '../../domain/book-node';

export const ID_KEY = 'drifting-id';
const STATUS_KEY = '写作状态';
const SUMMARY_KEY = '摘要';
const ALIASES_KEY = 'aliases';

const STATUS_LABELS: Record<WritingStatus, string> = {
  draft: '草稿',
  finished: '已完成',
  discarded: '已搁置',
  drifting: '漂浮中',
  resting: '休眠',
};

/** Fields the author may change from the file. */
export interface AuthoredFields {
  status: WritingStatus;
  summary: string;
}

export interface AuthoredFileInput {
  id: string;
  title: string;
  fields: AuthoredFields;
  /** Frontmatter entries Drifting does not own, written back verbatim. */
  extra: string;
  body: string;
}

export type ParsedAuthoredFile =
  | {
      ok: true;
      /** Absent when the author removed the frontmatter. */
      id: string | null;
      fields: Partial<AuthoredFields>;
      extra: string;
      body: string;
    }
  | { ok: false; reason: 'frontmatter' };

export function renderAuthoredFile(input: AuthoredFileInput): string {
  const lines = [
    '---',
    `${ID_KEY}: ${input.id}`,
    `${STATUS_KEY}: ${STATUS_LABELS[input.fields.status] ?? input.fields.status}`,
    `${SUMMARY_KEY}: ${JSON.stringify(input.fields.summary)}`,
    `${ALIASES_KEY}: ${JSON.stringify([input.title])}`,
    ...(input.extra ? [input.extra.replace(/\n+$/u, '')] : []),
    '---',
    '',
  ];
  return `${lines.join('\n')}\n${input.body}${input.body.endsWith('\n') ? '' : '\n'}`;
}

/** The Drifting status for a frontmatter value: its label or its stored value. */
export function parseStatus(value: string): WritingStatus | null {
  const trimmed = value.trim();
  for (const [status, label] of Object.entries(STATUS_LABELS) as [WritingStatus, string][]) {
    if (trimmed === label || trimmed === status) return status;
  }
  return null;
}

export function parseAuthoredFile(raw: string): ParsedAuthoredFile {
  const text = raw.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  if (!text.startsWith('---\n')) {
    return { ok: true, id: null, fields: {}, extra: '', body: paragraphsFromLines(text) };
  }
  const lines = text.split('\n');
  const close = lines.findIndex((line, index) => index > 0 && (line === '---' || line === '...'));
  if (close < 0) return { ok: false, reason: 'frontmatter' };
  const entries = frontmatterEntries(lines.slice(1, close));
  if (!entries) return { ok: false, reason: 'frontmatter' };
  let id: string | null = null;
  const fields: Partial<AuthoredFields> = {};
  const extra: string[] = [];
  for (const entry of entries) {
    switch (entry.key) {
      case ID_KEY: {
        const value = scalar(entry);
        if (value === null) return { ok: false, reason: 'frontmatter' };
        id = value.trim() || null;
        break;
      }
      case STATUS_KEY: {
        const value = scalar(entry);
        if (value === null) return { ok: false, reason: 'frontmatter' };
        const status = parseStatus(value);
        if (status) fields.status = status;
        break;
      }
      case SUMMARY_KEY: {
        const value = scalar(entry);
        if (value === null) return { ok: false, reason: 'frontmatter' };
        fields.summary = value;
        break;
      }
      case ALIASES_KEY:
        // Derived from the title for link resolution in Obsidian.
        break;
      default:
        extra.push(entry.raw);
    }
  }
  let bodyStart = close + 1;
  if (lines[bodyStart] === '') bodyStart += 1;
  return {
    ok: true,
    id,
    fields,
    extra: extra.join('\n'),
    body: paragraphsFromLines(lines.slice(bodyStart).join('\n')),
  };
}

/**
 * A single line break separates paragraphs, as authors type in plain
 * editors. Drifting writes each block on one line with blank lines between,
 * so this changes nothing it wrote. Fenced code keeps its lines.
 */
export function paragraphsFromLines(body: string): string {
  const lines = body.split('\n');
  const output: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1] ?? null;
    if (fence) {
      output.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) fence = marker;
    const previous = output[output.length - 1];
    if (previous !== undefined && previous.trim() !== '' && line.trim() !== '') output.push('');
    output.push(line);
  }
  return output.join('\n').replace(/^\n+|\n+$/gu, '');
}

interface FrontmatterEntry {
  key: string;
  /** Text after `key:` on the first line. */
  inline: string;
  /** Continuation lines (indented or list items). */
  block: string[];
  raw: string;
}

function frontmatterEntries(lines: string[]): FrontmatterEntry[] | null {
  const entries: FrontmatterEntry[] = [];
  for (const line of lines) {
    if (/^\s*(#.*)?$/u.test(line) && entries.length === 0) continue;
    const top = /^([^\s#:'"][^:]*?|"[^"]*"|'[^']*'):(?:\s(.*))?$/u.exec(line);
    if (top && !/^\s/u.test(line) && !line.startsWith('- ')) {
      const key = top[1]!.replace(/^(["'])(.*)\1$/u, '$2').trim();
      entries.push({ key, inline: (top[2] ?? '').trim(), block: [], raw: line });
      continue;
    }
    const last = entries[entries.length - 1];
    if (!last) return null;
    last.block.push(line);
    last.raw += `\n${line}`;
  }
  return entries;
}

/** A YAML scalar value, or null when it is not one. */
function scalar(entry: FrontmatterEntry): string | null {
  const { inline, block } = entry;
  const blockLines = block.filter((line, index) => line.trim() !== '' || index < block.length - 1);
  if (/^[|>][+-]?\d*$/u.test(inline)) {
    const indent = Math.min(
      ...blockLines.filter((line) => line.trim()).map((line) => /^\s*/u.exec(line)![0].length),
    );
    const content = blockLines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0));
    const folded = inline.startsWith('>')
      ? content.join('\n').replace(/([^\n])\n(?=[^\n])/gu, '$1 ')
      : content.join('\n');
    const keep = inline.includes('+');
    const strip = inline.includes('-');
    const trimmed = folded.replace(/\n+$/u, '');
    return strip ? trimmed : keep ? `${folded}\n` : trimmed ? `${trimmed}\n` : '';
  }
  if (blockLines.some((line) => /^\s*-\s/u.test(line))) return null;
  const text = [inline, ...blockLines.map((line) => line.trim())].filter(Boolean).join(' ');
  if (text.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/u.test(text)) return null;
    return text.slice(1, -1).replace(/''/gu, "'");
  }
  if (text.startsWith('[') || text.startsWith('{')) return null;
  return text.replace(/\s+#.*$/u, '').trim();
}
