/**
 * Prose searchers for the eval tool stub. Two backends behind the same shape:
 *   · keyword  — substring match over the project's prose. Mirrors PRODUCTION
 *                search_prose ([tool-handlers.ts] `text.toLowerCase().indexOf(q)`,
 *                no FTS, no semantics) so the eval judge has exactly what prod has.
 *   · semantic — LLM-as-retriever stand-in for embedding RAG (no embedding key here):
 *                hand the model the query + numbered prose, get back the semantically
 *                relevant block ids — finds IMPLIED evidence that keyword can't (e.g. a
 *                "X acts through a proxy" passage that never names X).
 */
import type { LLMClient } from '../../ai/client/llm-client';
import type { EvalChapter, EvalProject, ProseMatch, ProseSearcher } from './model';

/** Observe one semantic retrieval: the judge's query, the model's RAW reply, and
 *  the parsed picks. Lets the eval LOG what RAG actually surfaced so a bad result
 *  ("did the retriever even find the implied-evidence paragraphs?") is visible. */
export interface SemanticPickLog {
  query: string;
  raw: string;
  picks: ProseMatch[];
}

function snippet(text: string, around?: string): string {
  if (around) {
    const i = text.toLowerCase().indexOf(around.toLowerCase());
    if (i >= 0) {
      const s = Math.max(0, i - 20);
      return (s > 0 ? '…' : '') + text.slice(s, i + around.length + 40) + (i + around.length + 40 < text.length ? '…' : '');
    }
  }
  return text.length > 80 ? text.slice(0, 80) + '…' : text;
}

/** Keyword substring search — mirrors production search_prose exactly. */
export function keywordProseSearcher(project: EvalProject): ProseSearcher {
  return async (query, limit) => {
    const q = query.trim().toLowerCase();
    const out: ProseMatch[] = [];
    if (!q) return out;
    for (const e of project.elements) {
      const body = e.body ?? '';
      if (body.toLowerCase().includes(q)) {
        out.push({ kind: 'element', title: e.name, snippet: snippet(body, q) });
        if (out.length >= limit) return out;
      }
    }
    for (const c of project.chapters) {
      for (let i = 0; i < c.blocks.length; i++) {
        if (c.blocks[i]!.text.toLowerCase().includes(q)) {
          out.push({ kind: c.id, title: c.title, block: i + 1, snippet: snippet(c.blocks[i]!.text, q) });
          break; // one hit per chapter, like prod (agent reads the node for the rest)
        }
      }
      if (out.length >= limit) return out;
    }
    return out;
  };
}

/**
 * LLM-as-retriever — semantic stand-in for embedding RAG. Scoped to the chapter under
 * review (where a single-chapter canon-vs-prose contradiction lives); a real RAG would
 * be project-wide over an embedding index. Returns the model's relevant-block picks.
 */
export function semanticProseSearcher(
  client: LLMClient,
  chapter: EvalChapter,
  onPick?: (log: SemanticPickLog) => void,
): ProseSearcher {
  return async (query, limit) => {
    const blocks = chapter.blocks;
    if (!query.trim() || blocks.length === 0) return [];
    const numbered = blocks.map((b, i) => `[${i + 1}] ${b.text}`).join('\n');
    const resp = await client.complete({
      // non-deepseek id ⇒ provider substitutes its configured default (same as the judge)
      model: 'gemini-3.5-flash',
      system:
        '你是语义检索器。给你一个查询和按段编号的正文，挑出与查询【语义】最相关的段——即使段里没有出现查询的字面词也要选(例如查询是某人的行事方式，描写他人替他行动的段也算相关)。只返回真正相关的段编号，按相关度排序；都不相关就返回空。只输出 JSON 数组，如 [3,20,27]，不要任何解释或多余文字。',
      messages: [
        {
          role: 'user',
          content: `查询：${query}\n\n正文（按段编号）：\n${numbered}\n\n返回相关段编号的 JSON 数组：`,
        },
      ],
      metadata: { feature: 'eval-semantic-search' },
    });
    const text = resp.text ?? '';
    const ids = [...new Set((text.match(/\d+/g) ?? []).map(Number))]
      .filter((n) => n >= 1 && n <= blocks.length)
      .slice(0, limit);
    const picks = ids.map((n) => ({
      kind: chapter.id,
      title: chapter.title,
      block: n,
      snippet: snippet(blocks[n - 1]!.text),
    }));
    onPick?.({ query, raw: text, picks });
    return picks;
  };
}
