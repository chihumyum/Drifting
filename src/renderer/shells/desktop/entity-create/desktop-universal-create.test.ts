import { describe, expect, it, vi } from 'vitest';

import type { BookNode } from '../../../domain/book-node';
import { initialCreateTabDraft } from '../../../store/ui-store';
import {
  createUniversalEntity,
  createUniversalSubmissionGate,
  type UniversalCreateServices,
} from './desktop-universal-create';

function services(): UniversalCreateServices {
  return {
    createNode: vi.fn().mockResolvedValue({ id: 'node-created' }),
    createStoryline: vi.fn().mockResolvedValue({ id: 'story-created' }),
    createElement: vi.fn().mockResolvedValue({ id: 'element-created' }),
    createCategory: vi.fn().mockResolvedValue({ id: 'category-created' }),
  };
}

describe('desktop universal create command', () => {
  it('creates one chapter with the selected storyline and next book order', async () => {
    const api = services();
    const draft = { ...initialCreateTabDraft(), storylineId: 'story-a' };
    const bookNodes = [
      { kind: 'chapter', bookOrder: 15 },
      { kind: 'drift', bookOrder: null },
    ] as BookNode[];

    await expect(
      createUniversalEntity({
        kind: 'chapter',
        projectId: 'project-a',
        draft,
        bookNodes,
        services: api,
      }),
    ).resolves.toEqual({ entityType: 'node', id: 'node-created' });
    expect(api.createNode).toHaveBeenCalledOnce();
    expect(api.createNode).toHaveBeenCalledWith({
      kind: 'chapter',
      title: 'New Chapter',
      bookOrder: 20,
      mainStorylineId: 'story-a',
    });
    expect(api.createStoryline).not.toHaveBeenCalled();
    expect(api.createElement).not.toHaveBeenCalled();
    expect(api.createCategory).not.toHaveBeenCalled();
  });

  it.each([
    [null, null],
    ['group-a', 'group-a'],
  ])('creates one drift with its optional group (%s)', async (draftGroup, expectedGroup) => {
    const api = services();
    const draft = { ...initialCreateTabDraft(), driftGroupId: draftGroup };

    await createUniversalEntity({
      kind: 'drift',
      projectId: 'project-a',
      draft,
      bookNodes: [],
      services: api,
    });

    expect(api.createNode).toHaveBeenCalledOnce();
    expect(api.createNode).toHaveBeenCalledWith({
      kind: 'drift',
      title: 'New Drift',
      bookOrder: null,
      mainStorylineId: null,
      driftGroupId: expectedGroup,
    });
  });

  it.each([
    [null, null],
    ['Cast', 'Cast'],
  ])('creates one element in the required category and optional group (%s)', async (group, expected) => {
    const api = services();
    const draft = {
      ...initialCreateTabDraft(),
      categoryId: 'category-a',
      elementGroupName: group,
    };

    await expect(
      createUniversalEntity({
        kind: 'element',
        projectId: 'project-a',
        draft,
        bookNodes: [],
        services: api,
      }),
    ).resolves.toEqual({ entityType: 'element', id: 'element-created' });
    expect(api.createElement).toHaveBeenCalledOnce();
    expect(api.createElement).toHaveBeenCalledWith({
      categoryId: 'category-a',
      groupName: expected,
    });
  });

  it('rejects element creation without a category before calling a usecase', async () => {
    const api = services();

    await expect(
      createUniversalEntity({
        kind: 'element',
        projectId: 'project-a',
        draft: initialCreateTabDraft(),
        bookNodes: [],
        services: api,
      }),
    ).rejects.toThrow('A category is required');
    expect(api.createElement).not.toHaveBeenCalled();
  });

  it.each([
    ['storyline' as const, 'storyline', 'story-created'],
    ['category' as const, 'category', 'category-created'],
  ])('creates one %s immediately', async (kind, entityType, id) => {
    const api = services();

    await expect(
      createUniversalEntity({
        kind,
        projectId: 'project-a',
        draft: initialCreateTabDraft(),
        bookNodes: [],
        services: api,
      }),
    ).resolves.toEqual({ entityType, id });
    const totalCalls =
      vi.mocked(api.createNode).mock.calls.length +
      vi.mocked(api.createStoryline).mock.calls.length +
      vi.mocked(api.createElement).mock.calls.length +
      vi.mocked(api.createCategory).mock.calls.length;
    expect(totalCalls).toBe(1);
  });
});

describe('desktop universal create submission gate', () => {
  it('ignores a second submission while the first is pending', async () => {
    const gate = createUniversalSubmissionGate();
    let resolveFirst!: (value: string) => void;
    const task = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const first = gate.run(task);
    await expect(gate.run(task)).resolves.toEqual({ started: false });
    expect(task).toHaveBeenCalledOnce();
    resolveFirst('created');
    await expect(first).resolves.toEqual({ started: true, value: 'created' });
  });

  it('unlocks after failure so the same draft can retry', async () => {
    const gate = createUniversalSubmissionGate();
    await expect(gate.run(async () => Promise.reject(new Error('write failed')))).rejects.toThrow(
      'write failed',
    );
    await expect(gate.run(async () => 'created')).resolves.toEqual({
      started: true,
      value: 'created',
    });
  });
});
