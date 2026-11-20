import { describe, expect, it } from 'vitest';
import {
  UNAFFILIATED_STORYLINE_OPTION,
  canCommitImport,
  resolveImportStorylineId,
} from './import-dialog-model';

describe('import dialog storyline and commit rules', () => {
  it('resolves to null (unaffiliated) when a project has no storylines', () => {
    expect(resolveImportStorylineId(undefined, [])).toBeNull();
    expect(resolveImportStorylineId(null, [])).toBeNull();
    expect(resolveImportStorylineId('deleted-storyline', [])).toBeNull();
    expect(UNAFFILIATED_STORYLINE_OPTION).toBe('');
  });

  it('defaults untouched selection to the first storyline while respecting explicit unaffiliated', () => {
    const storylines = [{ id: 'sl-1' }, { id: 'sl-2' }];
    expect(resolveImportStorylineId(undefined, storylines)).toBe('sl-1');
    expect(resolveImportStorylineId(null, storylines)).toBeNull();
    expect(resolveImportStorylineId('sl-2', storylines)).toBe('sl-2');
  });

  it('falls back to the first remaining storyline when the previously chosen storyline is gone', () => {
    expect(resolveImportStorylineId('sl-removed', [{ id: 'sl-2' }])).toBe('sl-2');
    expect(resolveImportStorylineId('sl-removed', [])).toBeNull();
  });

  it('allows committing chapter imports without any storyline', () => {
    expect(
      canCommitImport({
        projectId: 'proj-1',
        userId: 'user-1',
        target: 'chapter',
        categoryId: null,
        items: [{ status: 'ready' }],
      }),
    ).toBe(true);
  });

  it('still requires a category for element imports and ready items for all targets', () => {
    expect(
      canCommitImport({
        projectId: 'proj-1',
        userId: 'user-1',
        target: 'element',
        categoryId: null,
        items: [{ status: 'ready' }],
      }),
    ).toBe(false);

    expect(
      canCommitImport({
        projectId: 'proj-1',
        userId: 'user-1',
        target: 'element',
        categoryId: 'cat-1',
        items: [{ status: 'ready' }],
      }),
    ).toBe(true);

    expect(
      canCommitImport({
        projectId: 'proj-1',
        userId: 'user-1',
        target: 'chapter',
        categoryId: null,
        items: [{ status: 'parsing' }],
      }),
    ).toBe(false);

    expect(
      canCommitImport({
        projectId: undefined,
        userId: 'user-1',
        target: 'chapter',
        categoryId: null,
        items: [{ status: 'ready' }],
      }),
    ).toBe(false);
  });
});
