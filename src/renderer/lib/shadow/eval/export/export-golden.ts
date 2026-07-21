/**
 * Export bridge — a live project slice → a GoldenFile, so you stop hand-writing
 * golden JSON. The data-fetching is INJECTED (ExportDeps), so the whole transform
 * (kvJson→facts, ProjectRule→RuleSpec, BookElement→element, prose→blocks) is pure
 * and headless-testable; the app wires the real repos + Yjs-truth reader.
 *
 *   prose: read via getChapterContentJson (the Yjs source of truth), NOT raw
 *   node_content.contentJson (a seed-only cache that lags the editor — bug #7).
 *   facts: the element's kvJson (what the judge consults), NOT its prose body.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuleSpec } from '../../review-types';
import type { ProjectRule } from '../../../../domain/project-rule';
import type { BookElement } from '../../../../domain/book-element';
import type { BookNode } from '../../../../domain/book-node';
import { parseKv } from '../../../../domain/kv';
import { docToBlocks } from '../../../agent/serialize';
import { assembleGolden } from '../runner/assemble';
import type { GoldenFile } from '../runner/schema';

function kvToRecord(json: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of parseKv(json)) if (key.trim()) out[key] = value;
  return out;
}

export interface BuiltChapter {
  id: string;
  title: string;
  summary?: string;
  blocks: { id: string; text: string }[];
}

export interface BuildSources {
  goldenId: string;
  projectId: string;
  projectKvJson: string;
  rules: ProjectRule[];
  elements: BookElement[];
  chapters: BuiltChapter[];
}

// Pure: shape already-fetched rows into a validated GoldenFile.
export function buildGolden(s: BuildSources): GoldenFile {
  return assembleGolden({
    id: s.goldenId,
    projectId: s.projectId,
    facts: kvToRecord(s.projectKvJson),
    rules: s.rules.map((r): RuleSpec => ({ id: r.id, checklist: r.checklist })),
    elements: s.elements.map((e) => ({
      id: e.id,
      name: e.name,
      aliases: e.aliases.length ? e.aliases : undefined,
      facts: kvToRecord(e.kvJson),
      body: e.summary || undefined,
    })),
    chapters: s.chapters,
    provenance: { exportedAt: new Date().toISOString() },
  });
}

// The renderer-side data surface the export pulls from (mirrors the ShadowDeps DI
// pattern). The app injects real repos + getChapterContentJson; tests inject fixtures.
export interface ExportDeps {
  projectKvJson(): Promise<string>;
  listRules(): Promise<ProjectRule[]>;
  listElements(): Promise<BookElement[]>;
  listChapters(): Promise<BookNode[]>;
  // Yjs-truth prose for one chapter (the app wires this to
  // getChapterContentJson(nodeId, contentRow?.contentJson ?? null)).
  getChapterContentJson(nodeId: string): Promise<string>;
}

export interface ExportSelection {
  chapterIds?: string[]; // omit = all chapters
  elementIds?: string[]; // omit = all elements
}

export async function exportProjectGolden(
  goldenId: string,
  projectId: string,
  selection: ExportSelection,
  deps: ExportDeps,
): Promise<GoldenFile> {
  const rules = (await deps.listRules()).filter((r) => r.enabled);
  const elements = (await deps.listElements()).filter(
    (e) => !selection.elementIds || selection.elementIds.includes(e.id),
  );
  const nodes = (await deps.listChapters()).filter(
    (n) => !selection.chapterIds || selection.chapterIds.includes(n.id),
  );

  const chapters: BuiltChapter[] = [];
  for (const node of nodes) {
    const contentJson = await deps.getChapterContentJson(node.id);
    const blocks = docToBlocks(contentJson)
      .filter((b) => b.text.trim())
      .map((b, i) => ({ id: b.blockId ?? `${node.id}-p${i + 1}`, text: b.text }));
    chapters.push({ id: node.id, title: node.title, summary: node.summary || undefined, blocks });
  }

  return buildGolden({
    goldenId,
    projectId,
    projectKvJson: await deps.projectKvJson(),
    rules,
    elements,
    chapters,
  });
}

/** Write a golden to corpus/goldens/<id>.golden.json. */
export function writeGoldenFile(goldensDir: string, golden: GoldenFile): string {
  const path = join(goldensDir, `${golden.id}.golden.json`);
  writeFileSync(path, JSON.stringify(golden, null, 2) + '\n');
  return path;
}
