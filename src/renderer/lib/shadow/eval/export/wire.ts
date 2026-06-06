/**
 * App-side wiring for the export bridge. Builds ExportDeps from the real renderer
 * repos + the Yjs-truth prose reader, and downloads the produced golden as a file
 * (Blob + anchor — no fs, no new IPC). Drop the downloaded `<id>.golden.json` into
 * `corpus/goldens/` and a suite can point at it.
 *
 * RUNS IN THE RENDERER ONLY (getDb-backed). Never imported by the headless eval
 * tests — it's the in-app caller. Type-checked against the real repo signatures.
 */
import { createProjectRuleRepository } from '../../../../sqlite-repo/project-rule-repo';
import { createBookElementSqliteRepository } from '../../../../sqlite-repo/element-repo';
import { createBookNodeSqliteRepository } from '../../../../sqlite-repo/node-repo';
import { createBookContentRepository } from '../../../../sqlite-repo/content-repo';
import { getChapterContentJson } from '../../../agent/chapter-prose';
import { exportProjectGolden, type ExportDeps, type ExportSelection } from './export-golden';
import type { GoldenFile } from '../runner/schema';

export function buildExportDeps(projectId: string, projectKvJson: string): ExportDeps {
  const rules = createProjectRuleRepository();
  const elements = createBookElementSqliteRepository(projectId);
  const nodes = createBookNodeSqliteRepository(projectId);
  const content = createBookContentRepository();
  return {
    projectKvJson: async () => projectKvJson,
    listRules: () => rules.listByProject(projectId),
    listElements: () => elements.findAll(),
    listChapters: () => nodes.findAll(),
    getChapterContentJson: async (nodeId) => {
      const row = await content.findByNodeId(nodeId);
      return getChapterContentJson(nodeId, row?.contentJson ?? null);
    },
  };
}

/**
 * Produce a golden from the live project and download it as `<id>.golden.json`.
 * Wire a dev button to this with the active project's id + kvJson; pass a selection
 * to narrow chapters/elements (omit = whole project).
 */
export async function downloadProjectGolden(
  goldenId: string,
  projectId: string,
  projectKvJson: string,
  selection: ExportSelection = {},
): Promise<GoldenFile> {
  const golden = await exportProjectGolden(
    goldenId,
    projectId,
    selection,
    buildExportDeps(projectId, projectKvJson),
  );
  const blob = new Blob([JSON.stringify(golden, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${goldenId}.golden.json`;
  a.click();
  URL.revokeObjectURL(url);
  return golden;
}
