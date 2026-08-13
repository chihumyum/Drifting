/**
 * The portable prose-metric contract shared by client and
 * private service. Callers derive ProseMirror JSON from their exact local or
 * server Yjs state before using this package.
 */

export type ProseMetricBasisKind = 'seed' | 'yjs';

export interface ProseMetric {
  wordCount: number;
  basisHash: string;
}

const PROSE_METRIC_BASIS_HASH = /^sha256:[0-9a-f]{64}$/u;

export function isProseMetricBasisHash(value: unknown): value is string {
  return typeof value === 'string' && PROSE_METRIC_BASIS_HASH.test(value);
}

interface ProseMirrorNode {
  type?: string;
  text?: string;
  content?: ProseMirrorNode[];
  [key: string]: unknown;
}

const CJK_IDEOGRAPH = /[\u3400-\u4DBF\u4E00-\u9FFF]/gu;
const CJK_STRIPPABLE = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uFF00-\uFFEF]/gu;

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const cjkCount = trimmed.match(CJK_IDEOGRAPH)?.length ?? 0;
  const latinCount = trimmed
    .replace(CJK_STRIPPABLE, ' ')
    .split(/\s+/)
    .reduce((count, token) => (/[A-Za-z0-9]/.test(token) ? count + 1 : count), 0);
  return cjkCount + latinCount;
}

export function extractProseText(node: ProseMirrorNode): string {
  let output = '';
  if (node.type === 'text' && typeof node.text === 'string') output += node.text;
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      output += extractProseText(child);
      // Preserve Drifting's established behavior: each PM child boundary
      // separates Latin tokens while CJK punctuation remains count-neutral.
      output += ' ';
    }
  }
  return output;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function hashProseDocument(document: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable for prose metrics.');
  const bytes = new TextEncoder().encode(canonicalJson(document));
  const digest = await subtle.digest('SHA-256', bytes);
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

export async function deriveProseMetric(document: unknown): Promise<ProseMetric> {
  const node = document && typeof document === 'object' ? (document as ProseMirrorNode) : {};
  return {
    wordCount: countWords(extractProseText(node)),
    basisHash: await hashProseDocument(document),
  };
}

export async function deriveProseMetricFromJson(
  contentJson: string | null | undefined,
): Promise<ProseMetric> {
  const document = contentJson ? JSON.parse(contentJson) : { type: 'doc', content: [] };
  return deriveProseMetric(document);
}

export function countWordsInPmJson(contentJson: string | null | undefined): number {
  if (!contentJson) return 0;
  try {
    return countWords(extractProseText(JSON.parse(contentJson) as ProseMirrorNode));
  } catch {
    return 0;
  }
}
