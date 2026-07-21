/**
 * Assemble a GoldenFile from already-shaped parts and VALIDATE it (zGolden.parse),
 * so an export that wouldn't load fails at export time, not eval time. This is the
 * pure target shape; the app-side fetcher (export/export-golden.ts) feeds it.
 */
import type { RuleSpec } from '../../review-types';
import { zGolden, type GoldenFile } from './schema';

export interface AssembleInput {
  id: string;
  projectId: string;
  facts: Record<string, string>;
  rules: RuleSpec[];
  elements: {
    id: string;
    name: string;
    aliases?: string[];
    facts: Record<string, string>;
    body?: string;
  }[];
  chapters: {
    id: string;
    title: string;
    summary?: string;
    blocks: { id: string; text: string }[];
    appears?: string[];
  }[];
  provenance?: Record<string, unknown>;
}

export function assembleGolden(input: AssembleInput): GoldenFile {
  const golden = {
    $schema: 'golden/v1',
    id: input.id,
    provenance: { source: 'exported-from-app', ...input.provenance },
    project: {
      projectId: input.projectId,
      facts: input.facts,
      elements: input.elements,
      rules: input.rules,
      chapters: input.chapters,
    },
  };
  return zGolden.parse(golden);
}
