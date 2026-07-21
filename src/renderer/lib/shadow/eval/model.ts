/**
 * In-memory project model for the headless shadow eval.
 *
 * The eval's "project copy" is a plain JS object — deep-cloning it is cheap, so
 * each case gets a fresh, isolated variant with NO database clone and NO side
 * effects. A golden project (authored in the app) is exported to this shape; the
 * eval clones it, mutates the clone, and runs the REAL evaluator chain over it.
 *
 * Canon (element facts) is served through a model-backed `runTool`, NOT inlined
 * into the prompt — so the judge must CONSULT it the same way it does in
 * production. That makes the eval exercise the real consultation path (and a
 * dependency change is only caught if the judge actually reads the entity).
 */
import type { ReviewContext, RuleSpec } from '../review-types';
import type { ToolRunOutcome } from '../../ai/shadow-rules';
import type { SemanticEvalContext } from '../../ai/shadow-rules';

export interface EvalElement {
  id: string;
  name: string;
  aliases?: string[];
  facts: Record<string, string>;
  body?: string;
}

export interface EvalChapter {
  id: string;
  title: string;
  summary?: string;
  blocks: { id: string; text: string }[];
  // Element names the chapter is meant to reference. Defaults to a prose scan.
  appears?: string[];
}

export interface EvalProject {
  projectId: string;
  facts: Record<string, string>; // whole-book canon → ReviewContext.rulesKv
  chapters: EvalChapter[];
  elements: EvalElement[];
  rules: RuleSpec[]; // compiled rules (same shape shadow_read_rules returns)
}

/** Deep clone — the "project copy" each mutation runs against, fully isolated. */
export function cloneProject(p: EvalProject): EvalProject {
  return structuredClone(p);
}

/** Element names whose name/alias literally appears in the chapter prose. */
function deriveAppears(chapter: EvalChapter, elements: EvalElement[]): string[] {
  if (chapter.appears) return chapter.appears;
  const text = chapter.blocks.map((b) => b.text).join('\n');
  return elements
    .filter((e) => [e.name, ...(e.aliases ?? [])].some((n) => n && text.includes(n)))
    .map((e) => e.name);
}

/** Build the platform-neutral ReviewContext the real evaluator consumes. */
export function toReviewContext(project: EvalProject, chapter: EvalChapter): ReviewContext {
  return {
    projectId: project.projectId,
    chapterId: chapter.id,
    title: chapter.title,
    summary: chapter.summary ?? '',
    blocks: chapter.blocks.map((b) => ({ id: b.id, text: b.text })),
    appears: deriveAppears(chapter, project.elements),
    rulesKv: project.facts,
  };
}

/** The warm-start context handed to the FC judge (book facts + who's on stage).
 *  Element-SPECIFIC facts are NOT inlined here — the judge fetches them via the
 *  model runTool, so consultation is exercised. */
export function semanticContextFor(
  project: EvalProject,
  chapter: EvalChapter,
): SemanticEvalContext {
  const appears = new Set(deriveAppears(chapter, project.elements));
  return {
    facts: project.facts,
    identity: { title: chapter.title, kind: 'chapter' },
    sceneEntities: project.elements
      .filter((e) => appears.has(e.name))
      .map((e) => ({ name: e.name, summary: e.body })),
  };
}

function renderElement(e: EvalElement): string {
  const facts = Object.entries(e.facts)
    .map(([k, v]) => `- ${k}：${v}`)
    .join('\n');
  return [`${e.name}`, e.body ? e.body : '', facts ? `设定/事实：\n${facts}` : '']
    .filter(Boolean)
    .join('\n');
}

// One prose-search hit (mirrors production search_prose's match shape).
export interface ProseMatch {
  kind: string;
  title: string;
  block?: number;
  snippet: string;
}
export type ProseSearcher = (query: string, limit: number) => Promise<ProseMatch[]>;

/**
 * A model-backed read-tool, mirroring makeShadowRunTool's read surface so the
 * judge consults canon from the (mutated) model exactly as it would in prod.
 * Resolves element/chapter by name; everything else returns a helpful refusal.
 *
 * `searchProse` (optional) backs the search_prose tool — pass keywordProseSearcher
 * to mirror production, or semanticProseSearcher to test RAG. Omit → search_prose is
 * denied (the original behaviour, where the judge had no working prose search).
 */
export function makeModelRunTool(project: EvalProject, searchProse?: ProseSearcher) {
  const elByName = new Map<string, EvalElement>();
  for (const e of project.elements) {
    elByName.set(e.name, e);
    for (const a of e.aliases ?? []) elByName.set(a, e);
  }
  const chByTitle = new Map(project.chapters.map((c) => [c.title, c] as const));

  return async (name: string, args: Record<string, unknown>): Promise<ToolRunOutcome> => {
    const ref = String(
      args.element ??
        args.node ??
        args.chapter ??
        args.entity ??
        args.elementId ??
        args.nodeId ??
        '',
    ).trim();
    switch (name) {
      case 'read_element':
      case 'get_element_patches': {
        const e = elByName.get(ref);
        return e
          ? { content: renderElement(e), status: 'ok' }
          : { content: `（eval：无设定「${ref}」）`, status: 'denied', note: '未知设定' };
      }
      case 'read_node': {
        const kind = String(args.kind ?? 'node');
        if (kind === 'element') {
          const e = elByName.get(ref);
          if (e) return { content: renderElement(e), status: 'ok' };
        }
        const c = chByTitle.get(ref);
        return c
          ? {
              content: `${c.title}\n${c.blocks.map((b, i) => `[${i + 1}] ${b.text}`).join('\n')}`,
              status: 'ok',
            }
          : { content: `（eval：无节点「${ref}」）`, status: 'denied', note: '未知节点' };
      }
      case 'list_elements':
        return { content: project.elements.map((e) => e.name).join('、'), status: 'ok' };
      case 'search_prose': {
        if (!searchProse)
          return { content: '（eval：该工具在评测桩中不可用）', status: 'denied', note: '不可用' };
        const query = String(args.query ?? args.q ?? '').trim();
        const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
        const matches = await searchProse(query, limit);
        if (!matches.length)
          return { content: `（search_prose「${query}」：无匹配）`, status: 'ok' };
        return {
          content: matches
            .map((m) => `[${m.kind}] ${m.title}${m.block ? ` 第${m.block}段` : ''}：${m.snippet}`)
            .join('\n'),
          status: 'ok',
        };
      }
      default:
        return { content: '（eval：该工具在评测桩中不可用）', status: 'denied', note: '不可用' };
    }
  };
}
