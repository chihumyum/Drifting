import { describe, expect, it, vi } from 'vitest';

import type { BookNode } from '../../../domain/book-node';
import {
  createHomeEntity,
  createSubmissionGate,
  type HomeCreateServices,
} from './home-create';

const names = { chapter: '新章节', drift: '新构想', storyline: '新故事线', material: '无题' };

function services(): HomeCreateServices {
  return {
    createNode: vi.fn().mockResolvedValue({ id: 'node-created' }),
    createStoryline: vi.fn().mockResolvedValue({ id: 'story-created' }),
    createElement: vi.fn().mockResolvedValue({ id: 'element-created' }),
    createCategory: vi.fn().mockResolvedValue({ id: 'category-created' }),
    createTextMaterial: vi.fn().mockResolvedValue({ id: 'material-created' }),
  };
}

function totalCalls(api: HomeCreateServices) {
  return (Object.values(api) as Array<ReturnType<typeof vi.fn>>).reduce(
    (sum, fn) => sum + fn.mock.calls.length,
    0,
  );
}

describe('Project Home create command', () => {
  it('creates one chapter at the end of the book in the storyline pointed at', async () => {
    const api = services();
    const bookNodes = [
      { kind: 'chapter', bookOrder: 15 },
      { kind: 'drift', bookOrder: null },
    ] as BookNode[];

    await expect(
      createHomeEntity({
        kind: 'chapter',
        projectId: 'project-a',
        place: { storylineId: 'story-a' },
        bookNodes,
        names,
        services: api,
      }),
    ).resolves.toEqual({ entityType: 'node', id: 'node-created' });
    expect(api.createNode).toHaveBeenCalledWith({
      kind: 'chapter',
      title: '新章节',
      bookOrder: 20,
      mainStorylineId: 'story-a',
    });
    expect(totalCalls(api)).toBe(1);
  });

  it('creates an unaffiliated chapter when no storyline is chosen', async () => {
    const api = services();
    await createHomeEntity({ kind: 'chapter', projectId: 'p', place: {}, bookNodes: [], names, services: api });
    expect(api.createNode).toHaveBeenCalledWith(expect.objectContaining({ mainStorylineId: null }));
  });

  it.each([
    [undefined, null],
    ['group-a', 'group-a'],
  ])('creates one drift in its group (%s)', async (group, expected) => {
    const api = services();
    await createHomeEntity({
      kind: 'drift',
      projectId: 'project-a',
      place: { driftGroupId: group },
      bookNodes: [],
      names,
      services: api,
    });
    expect(api.createNode).toHaveBeenCalledWith({
      kind: 'drift',
      title: '新构想',
      bookOrder: null,
      mainStorylineId: null,
      driftGroupId: expected,
    });
  });

  it('creates one element in the category pointed at, outside any group', async () => {
    const api = services();
    await expect(
      createHomeEntity({
        kind: 'element',
        projectId: 'project-a',
        place: { categoryId: 'category-a' },
        bookNodes: [],
        names,
        services: api,
      }),
    ).resolves.toEqual({ entityType: 'element', id: 'element-created' });
    expect(api.createElement).toHaveBeenCalledWith({ categoryId: 'category-a', groupName: null });
  });

  it('rejects an element without a category before calling a usecase', async () => {
    const api = services();
    await expect(
      createHomeEntity({ kind: 'element', projectId: 'p', place: {}, bookNodes: [], names, services: api }),
    ).rejects.toThrow('A category is required');
    expect(totalCalls(api)).toBe(0);
  });

  it.each([
    ['storyline' as const, 'storyline', 'story-created'],
    ['category' as const, 'category', 'category-created'],
    ['material' as const, 'library_item', 'material-created'],
  ])('creates one %s straight away', async (kind, entityType, id) => {
    const api = services();
    await expect(
      createHomeEntity({ kind, projectId: 'project-a', place: {}, bookNodes: [], names, services: api }),
    ).resolves.toEqual({ entityType, id });
    expect(totalCalls(api)).toBe(1);
  });

  it('names a new storyline and a new text material with the given defaults', async () => {
    const api = services();
    await createHomeEntity({ kind: 'storyline', projectId: 'p', place: {}, bookNodes: [], names, services: api });
    await createHomeEntity({ kind: 'material', projectId: 'p', place: {}, bookNodes: [], names, services: api });
    expect(api.createStoryline).toHaveBeenCalledWith({ projectId: 'p', name: '新故事线' });
    expect(api.createTextMaterial).toHaveBeenCalledWith('无题');
  });
});

describe('Project Home create gate', () => {
  it('ignores a second create while the first is pending', async () => {
    const gate = createSubmissionGate();
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

  it('unlocks after a failure so the author can try again', async () => {
    const gate = createSubmissionGate();
    await expect(gate.run(async () => Promise.reject(new Error('write failed')))).rejects.toThrow(
      'write failed',
    );
    await expect(gate.run(async () => 'created')).resolves.toEqual({ started: true, value: 'created' });
  });
});
