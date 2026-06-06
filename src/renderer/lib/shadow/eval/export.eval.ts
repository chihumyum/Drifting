/**
 * Export bridge round-trip (headless, no key). Injects FIXTURE deps standing in for
 * the repos + Yjs reader, exports a GoldenFile, loads it back, and runs the eval on
 * it — proving the exported shape (kvJson→facts, ProjectRule→RuleSpec, prose→blocks)
 * is fully eval-runnable. The app wires the same ExportDeps to real repos.
 */
import { vi, describe, test, expect } from 'vitest';

vi.mock('../../ai/client/build-default-client', () => ({
  buildDefaultLLMClient: async () => {
    throw new Error('buildDefaultLLMClient must not be called in eval (pass a client)');
  },
}));

import { exportProjectGolden, type ExportDeps } from './export/export-golden';
import { goldenToProject } from './runner/load-golden';
import { caseToMutation } from './runner/operators';
import { runEval } from './score';
import { mockCleanClient } from './review';
import type { ProjectRule } from '../../../domain/project-rule';
import type { BookElement } from '../../../domain/book-element';
import type { BookNode } from '../../../domain/book-node';

// A minimal TipTap doc JSON with stable block ids, as getChapterContentJson returns.
function doc(blocks: { id: string; text: string }[]): string {
  return JSON.stringify({
    type: 'doc',
    content: blocks.map((b) => ({
      type: 'paragraph',
      attrs: { id: b.id },
      content: [{ type: 'text', text: b.text }],
    })),
  });
}

const PROSE: Record<string, string> = {
  ch1: doc([
    { id: 'b1-1', text: '奥伦用左手握住青鳞剑，寒铁的凉意顺着掌心爬上来。' },
    { id: 'b1-2', text: '他听见门外有脚步声，却看不清来人是谁。' },
  ]),
};

const fixtureDeps: ExportDeps = {
  projectKvJson: async () =>
    JSON.stringify([
      { key: '人称视角', value: '第三人称限知（仅奥伦视角）' },
      { key: '时代背景', value: '架空冷兵器，无现代器物' },
    ]),
  listRules: async () => [
    {
      id: 'rule-banned',
      enabled: true,
      checklist: [
        { id: 'bn1', type: 'banned-words', assertion: '禁止现代网络用语', params: { words: ['OK'] } },
      ],
    } as unknown as ProjectRule,
  ],
  listElements: async () => [
    {
      id: 'el-grey',
      name: '奥伦',
      aliases: ['奥伦·维尔'],
      summary: '退役剑士',
      kvJson: JSON.stringify([{ key: '惯用手', value: '左手' }]),
    } as unknown as BookElement,
  ],
  listChapters: async () => [
    { id: 'ch1', title: '第一章·夜访', summary: '奥伦夜里值守。' } as unknown as BookNode,
  ],
  getChapterContentJson: async (nodeId) => PROSE[nodeId] ?? doc([]),
};

describe('export bridge — live project slice → golden (round-trip)', () => {
  test('export → load → eval is runnable (mechanical, no key)', async () => {
    const golden = await exportProjectGolden('exported', 'proj-1', {}, fixtureDeps);

    // The exported shape loads + matches the source rows.
    const project = goldenToProject(golden);
    expect(project.facts['人称视角']).toContain('限知');
    expect(project.elements[0].facts['惯用手']).toBe('左手');
    expect(project.elements[0].aliases).toContain('奥伦·维尔');
    expect(project.rules[0].id).toBe('rule-banned');
    expect(project.chapters[0].blocks.map((b) => b.id)).toEqual(['b1-1', 'b1-2']);
    expect(project.chapters[0].blocks[0].text).toContain('左手握住青鳞剑');

    // And it actually runs the eval: inject a banned word → caught (mechanical).
    const mutation = caseToMutation({
      id: 'm-banned',
      op: 'injectBannedWord',
      params: { chapterId: 'ch1', blockId: 'b1-2', word: 'OK', ruleId: 'rule-banned' },
      expect: [{ chapterId: 'ch1', ruleId: 'rule-banned', shouldFlag: true }],
    });
    const res = await runEval(project, [mutation], mockCleanClient());
    expect(res.tally.TP).toBe(1);
    expect(res.tally.FP).toBe(0);
  });
});
