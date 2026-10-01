import type { AgentContextEvidenceDocument } from './runtime/context-evidence-retrieval';
import { proseReadVersion } from './prose-read-view';

/** Literal matching never invokes the discovery ranker or Unicode normalization. */
export async function searchExactProse(
  documents: readonly AgentContextEvidenceDocument[],
  query: string,
  args: { limit: number; cursor?: number; version?: string; caseSensitive?: boolean },
) {
  const ordered = [...documents].sort((a, b) =>
    (a.ordinal ?? Number.MAX_SAFE_INTEGER) - (b.ordinal ?? Number.MAX_SAFE_INTEGER) ||
    a.evidenceId.localeCompare(b.evidenceId, 'en'));
  const version = await proseReadVersion(JSON.stringify({ query,
    caseSensitive: args.caseSensitive !== false,
    documents: ordered.map(doc => [doc.evidenceId, doc.title, doc.fields.map(field => [field.block, field.text])]),
  }));
  const cursor = args.cursor ?? 0;
  if ((cursor > 0 && !args.version) || (args.version !== undefined && args.version !== version)) {
    throw new Error('Search content or options changed; restart exact search without cursor/version');
  }
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), args.caseSensitive === false ? 'giu' : 'gu');
  const matches = [];
  let total = 0;
  for (const doc of ordered) {
    for (const field of doc.fields) {
      if (field.kind !== 'prose' || !query) continue;
      for (const hit of field.text.matchAll(pattern)) {
        const ordinal = total++;
        if (ordinal < cursor || matches.length >= args.limit) continue;
        const start = hit.index;
        const before = Array.from(field.text.slice(0, start));
        const after = Array.from(field.text.slice(start + hit[0].length));
        matches.push({ kind: doc.kind, title: doc.title,
          ...(field.block ? { block: field.block, line: (field.block - 1) * 2 + 1 } : {}),
          // Offsets refer to plain text within this editor block, in code points.
          textStart: before.length, textEnd: before.length + Array.from(hit[0]).length,
          snippet: `${before.length > 120 ? '…' : ''}${before.slice(-120).join('')}${hit[0]}${after.slice(0, 120).join('')}${after.length > 120 ? '…' : ''}`,
        });
      }
    }
  }
  const nextCursor = cursor + matches.length;
  return { matches, total, version, truncated: nextCursor < total,
    ...(nextCursor < total ? { nextCursor } : {}), matchMode: 'exact' as const };
}
