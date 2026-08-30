/**
 * Voice context pack — the project's proper nouns, compressed into recognition
 * context for speech transcription. Generic ASR reliably mangles invented
 * fiction names (homophones); the project canon is the disambiguator no
 * outside dictation tool has. Priority when clipping: elements (name +
 * aliases) > storylines > chapter titles > drift titles.
 */

import { allElementNames, type BookElement, type BookElementCategory } from '../../domain/book-element';
import type { BookNode } from '../../domain/book-node';
import type { Storyline } from '../../domain/storyline';
import { useDataStore } from '../../store/data-store';

/**
 * qwen3-asr accepts ~10k tokens of context; Chinese runs ≈1 token per
 * character, so this default leaves generous headroom.
 */
const DEFAULT_MAX_CHARS = 6000;

export interface VoiceContextPackInput {
  projectId: string;
  projectName: string;
  elements: readonly BookElement[];
  categories: readonly BookElementCategory[];
  storylines: readonly Storyline[];
  bookNodes: readonly BookNode[];
}

function joinClipped(header: string, entries: string[], budget: { remaining: number }): string {
  if (entries.length === 0 || budget.remaining <= header.length) return '';
  const kept: string[] = [];
  let used = header.length;
  for (const entry of entries) {
    const cost = entry.length + 1;
    if (used + cost > budget.remaining) break;
    kept.push(entry);
    used += cost;
  }
  if (kept.length === 0) return '';
  budget.remaining -= used;
  return `${header}${kept.join('、')}`;
}

export function buildVoiceContextPack(
  input: VoiceContextPackInput,
  options?: { maxChars?: number },
): string {
  const budget = { remaining: options?.maxChars ?? DEFAULT_MAX_CHARS };
  const categoryName = new Map(
    input.categories
      .filter((category) => category.projectId === input.projectId)
      .map((category) => [category.id, category.name] as const),
  );

  const elementEntries = input.elements
    .filter((element) => element.projectId === input.projectId)
    .map((element) => {
      const names = allElementNames(element);
      if (names.length === 0) return '';
      const category = element.categoryId ? categoryName.get(element.categoryId) : undefined;
      const alias = names.length > 1 ? `（又称：${names.slice(1).join('、')}）` : '';
      return `${category ? `[${category}] ` : ''}${names[0]}${alias}`;
    })
    .filter(Boolean);

  const storylineEntries = input.storylines
    .filter((storyline) => storyline.projectId === input.projectId)
    .map((storyline) => storyline.name.trim())
    .filter(Boolean);

  const projectNodes = input.bookNodes.filter((node) => node.projectId === input.projectId);
  const chapterEntries = projectNodes
    .filter((node) => node.kind === 'chapter')
    .map((node) => node.title.trim())
    .filter(Boolean);
  const driftEntries = projectNodes
    .filter((node) => node.kind === 'drift')
    .map((node) => node.title.trim())
    .filter(Boolean);

  const intro = `这是长篇写作项目《${input.projectName}》的口述录音。请按下列专有名词的准确写法转写，保留作者的口语表达。`;
  budget.remaining -= intro.length;

  const sections = [
    joinClipped('\n项目元素：', elementEntries, budget),
    joinClipped('\n故事线：', storylineEntries, budget),
    joinClipped('\n章节：', chapterEntries, budget),
    joinClipped('\n灵感：', driftEntries, budget),
  ].filter(Boolean);

  return `${intro}${sections.join('')}`;
}

/** Snapshot the live workspace projection into a context pack. */
export function buildVoiceContextPackFromStores(input: {
  projectId: string;
  projectName: string;
}): string {
  const data = useDataStore.getState();
  return buildVoiceContextPack({
    projectId: input.projectId,
    projectName: input.projectName,
    elements: data.bookElements,
    categories: data.bookElementCategories,
    storylines: data.storylines,
    bookNodes: data.bookNodes,
  });
}
