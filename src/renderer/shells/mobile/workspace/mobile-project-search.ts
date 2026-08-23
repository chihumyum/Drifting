import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';

export type MobileProjectSearchField = 'title' | 'name' | 'summary' | 'body';

export interface MobileProjectSearchOccurrence {
  field: MobileProjectSearchField;
  excerpt: string;
  matchStart: number;
  matchLength: number;
}

export interface MobileProjectSearchPaper {
  target: WorkspaceTarget;
  title: string;
  fields: Array<{ field: MobileProjectSearchField; text: string }>;
}

export interface MobileProjectSearchGroup {
  target: WorkspaceTarget;
  title: string;
  occurrences: MobileProjectSearchOccurrence[];
  totalMatches: number;
}

const MAX_OCCURRENCES_PER_PAPER = 30;
const EXCERPT_RADIUS = 28;

export function extractMobileSearchText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const value = node as { type?: string; text?: unknown; content?: unknown };
  if (value.type === 'text' && typeof value.text === 'string') return value.text;
  if (!Array.isArray(value.content)) return '';
  const separator = value.type === 'doc' || value.type === undefined ? '\n' : '';
  return (value.content as unknown[]).map(extractMobileSearchText).join(separator);
}

export function mobileSearchTextFromJson(json: string | null | undefined): string {
  if (!json) return '';
  try {
    return extractMobileSearchText(JSON.parse(json));
  } catch {
    return '';
  }
}

export function escapeMobileProjectSearchLike(query: string): string {
  return query.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function occurrencesInField(
  text: string,
  query: string,
  field: MobileProjectSearchField,
  cap: number,
): { occurrences: MobileProjectSearchOccurrence[]; total: number } {
  if (!text || !query) return { occurrences: [], total: 0 };
  const loweredText = text.toLocaleLowerCase();
  const loweredQuery = query.toLocaleLowerCase();
  const occurrences: MobileProjectSearchOccurrence[] = [];
  let total = 0;
  let from = 0;
  while (from <= loweredText.length - loweredQuery.length) {
    const match = loweredText.indexOf(loweredQuery, from);
    if (match < 0) break;
    total += 1;
    if (occurrences.length < cap) {
      const start = Math.max(0, match - EXCERPT_RADIUS);
      const end = Math.min(text.length, match + query.length + EXCERPT_RADIUS);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < text.length ? '…' : '';
      const excerpt = `${prefix}${text.slice(start, end)}${suffix}`.replace(/\s+/g, ' ').trim();
      const matchStart = excerpt.toLocaleLowerCase().indexOf(loweredQuery);
      if (matchStart >= 0) {
        occurrences.push({ field, excerpt, matchStart, matchLength: query.length });
      }
    }
    from = match + Math.max(1, loweredQuery.length);
  }
  return { occurrences, total };
}

export function searchMobileProjectPapers(
  query: string,
  papers: readonly MobileProjectSearchPaper[],
): MobileProjectSearchGroup[] {
  const normalized = query.trim();
  if (!normalized) return [];
  const groups: MobileProjectSearchGroup[] = [];
  for (const paper of papers) {
    const occurrences: MobileProjectSearchOccurrence[] = [];
    let totalMatches = 0;
    for (const field of paper.fields) {
      const result = occurrencesInField(
        field.text,
        normalized,
        field.field,
        Math.max(0, MAX_OCCURRENCES_PER_PAPER - occurrences.length),
      );
      occurrences.push(...result.occurrences);
      totalMatches += result.total;
    }
    if (totalMatches > 0) {
      groups.push({
        target: paper.target,
        title: paper.title,
        occurrences,
        totalMatches,
      });
    }
  }
  return groups;
}
