import { describe, expect, it, vi } from 'vitest';
import { evaluateRules } from './review-evaluator';
import {
  configureShadowRuntime,
  cancelShadowJob,
  enqueueShadowJob,
  runShadowJob,
  subscribeShadowJobEvents,
} from './runtime';
import type { ReviewContext, RuleSpec, ShadowDeps } from './review-types';

const context: ReviewContext = {
  projectId: 'project-1',
  chapterId: 'chapter-1',
  title: '第一章',
  summary: '',
  blocks: [
    { id: 'block-1', text: '阿青缓慢地走进雨里。' },
    { id: 'block-2', text: '这里出现禁词。' },
  ],
  appears: ['阿青'],
  rulesKv: {},
};

describe('renderer Shadow runtime', () => {
  it('keeps deterministic and semantic evaluator behavior', async () => {
    const rules: RuleSpec[] = [
      {
        id: 'rule-1',
        checklist: [
          {
            id: 'banned',
            assertion: '不要出现禁词',
            type: 'banned-words',
            params: { words: ['禁词'] },
          },
          { id: 'semantic', assertion: '保持第三人称', type: 'semantic' },
        ],
      },
    ];
    const semantic = vi
      .fn()
      .mockResolvedValue([[{ blockIds: ['block-1'], reason: '出现了第一人称', confidence: 0.9 }]]);

    const findings = await evaluateRules(rules, context, semantic);

    expect(semantic).toHaveBeenCalledOnce();
    expect(findings).toEqual([
      expect.objectContaining({ itemId: 'banned', blockId: 'block-2' }),
      expect.objectContaining({ itemId: 'semantic', blockId: 'block-1' }),
    ]);
  });

  it('runs gather, resolve, check, emit and decide in order', async () => {
    const calls: string[] = [];
    const finding = {
      ruleId: 'rule-1',
      itemId: 'banned',
      blockId: 'block-2',
      blockIds: ['block-2'],
      message: '出现禁用词：禁词',
      confidence: 1,
    };
    const deps: ShadowDeps = {
      readChapterSnapshot: async () => {
        calls.push('gather');
        return context;
      },
      readRules: async () => {
        calls.push('resolve');
        return [
          {
            id: 'rule-1',
            checklist: [
              {
                id: 'banned',
                assertion: '不要出现禁词',
                type: 'banned-words',
                params: { words: ['禁词'] },
              },
            ],
          },
        ];
      },
      evaluateSemanticBatch: async () => [],
      commitReview: async (_chapterId, actual, status) => {
        expect(actual).toEqual([finding]);
        expect(status).toBe('draft');
        calls.push('commit');
      },
    };

    const result = await runShadowJob(
      { projectId: context.projectId, chapterId: context.chapterId },
      deps,
    );

    expect(calls).toEqual(['gather', 'resolve', 'commit']);
    expect(result).toEqual({ chapterId: 'chapter-1', decision: 'draft', findingCount: 1 });
  });

  it('does not mutate after cancellation during semantic evaluation', async () => {
    const controller = new AbortController();
    const commitReview = vi.fn();
    const deps: ShadowDeps = {
      readChapterSnapshot: async () => context,
      readRules: async () => [
        {
          id: 'rule-1',
          checklist: [{ id: 'semantic', assertion: '保持第三人称', type: 'semantic' }],
        },
      ],
      evaluateSemanticBatch: async () => {
        controller.abort();
        return [[]];
      },
      commitReview,
    };

    await expect(
      runShadowJob(
        { projectId: context.projectId, chapterId: context.chapterId },
        deps,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(commitReview).not.toHaveBeenCalled();
  });

  it('finishes the atomic commit when cancellation arrives after the commit boundary', async () => {
    const controller = new AbortController();
    const committed: string[] = [];
    const deps: ShadowDeps = {
      readChapterSnapshot: async () => context,
      readRules: async () => [],
      evaluateSemanticBatch: async () => [],
      commitReview: async (_chapterId, findings, status) => {
        controller.abort();
        committed.push(`${findings.length}:${status}`);
      },
    };

    await expect(
      runShadowJob(
        { projectId: context.projectId, chapterId: context.chapterId },
        deps,
        controller.signal,
      ),
    ).resolves.toEqual({ chapterId: 'chapter-1', decision: 'finished', findingCount: 0 });
    expect(committed).toEqual(['0:finished']);
  });

  it('rejects a runtime stop after the commit boundary and emits completion', async () => {
    let releaseCommit: (() => void) | undefined;
    let commitStarted: (() => void) | undefined;
    let completed: (() => void) | undefined;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const atCommit = new Promise<void>((resolve) => {
      commitStarted = resolve;
    });
    const done = new Promise<void>((resolve) => {
      completed = resolve;
    });
    const events: string[] = [];
    configureShadowRuntime({
      readChapterSnapshot: async () => context,
      readRules: async () => [],
      evaluateSemanticBatch: async () => [],
      commitReview: async () => {
        commitStarted?.();
        await commitGate;
      },
    });
    const off = subscribeShadowJobEvents((event) => {
      events.push(event.state);
      if (event.state === 'completed') completed?.();
    });

    enqueueShadowJob({ projectId: context.projectId, chapterId: 'chapter-late-cancel' });
    await atCommit;
    expect(cancelShadowJob('chapter-late-cancel')).toBe(false);
    releaseCommit?.();
    await done;
    off();

    expect(events).toEqual(['started', 'completed']);
  });

  it('accepts cancellation before the commit boundary and never mutates', async () => {
    let releaseGather: (() => void) | undefined;
    let gatherStarted: (() => void) | undefined;
    let failed: (() => void) | undefined;
    const gatherGate = new Promise<void>((resolve) => {
      releaseGather = resolve;
    });
    const atGather = new Promise<void>((resolve) => {
      gatherStarted = resolve;
    });
    const done = new Promise<void>((resolve) => {
      failed = resolve;
    });
    const commitReview = vi.fn();
    configureShadowRuntime({
      readChapterSnapshot: async () => {
        gatherStarted?.();
        await gatherGate;
        return context;
      },
      readRules: async () => [],
      evaluateSemanticBatch: async () => [],
      commitReview,
    });
    const off = subscribeShadowJobEvents((event) => {
      if (event.state === 'failed') failed?.();
    });

    enqueueShadowJob({ projectId: context.projectId, chapterId: 'chapter-early-cancel' });
    await atGather;
    expect(cancelShadowJob('chapter-early-cancel')).toBe(true);
    releaseGather?.();
    await done;
    off();

    expect(commitReview).not.toHaveBeenCalled();
  });

  it('coalesces duplicate queue entries and emits ordered lifecycle events', async () => {
    const gathered: string[] = [];
    const events: string[] = [];
    let completed = 0;
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    configureShadowRuntime({
      readChapterSnapshot: async (chapterId) => {
        gathered.push(chapterId);
        return { ...context, chapterId };
      },
      readRules: async () => [],
      evaluateSemanticBatch: async () => [],
      commitReview: async () => undefined,
    });
    const off = subscribeShadowJobEvents((event) => {
      events.push(`${event.chapterId}:${event.state}`);
      if (event.state === 'completed' && ++completed === 2) resolveDone?.();
    });

    enqueueShadowJob({ projectId: 'project-1', chapterId: 'chapter-a' });
    enqueueShadowJob({ projectId: 'project-1', chapterId: 'chapter-a' });
    enqueueShadowJob({ projectId: 'project-1', chapterId: 'chapter-b' });
    await done;
    off();

    expect(gathered).toEqual(['chapter-a', 'chapter-b']);
    expect(events).toEqual([
      'chapter-a:started',
      'chapter-a:completed',
      'chapter-b:started',
      'chapter-b:completed',
    ]);
  });
});
