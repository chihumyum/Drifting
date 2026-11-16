import { and, eq } from 'drizzle-orm';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canUnbindCommentTarget,
  createPlainCommentDoc,
  NOTE_TASK_TODO_METADATA,
  resolveComposedCommentTargets,
  type Comment,
} from '../domain/comment';
import * as database from '../lib/db';
import { CommentTable, EntityRelationTable, SyncChangeSetTable, SyncMutationTable } from '../schema/drizzle';
import {
  createWorkspaceProjectionFixture,
  WORKSPACE_TEST_INPUT as INPUT,
} from '../services/workspace-projection.test-support';
import { useDataStore } from '../store/data-store';
import { useComment } from './useComment';
import { useEntityRelations } from './useEntityRelations';

const secureStorage = vi.hoisted(() => new Map<string, string>());
vi.mock('../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform')>();
  return {
    ...actual,
    platform: {
      ...actual.platform,
      app: { ...actual.platform.app, getInstallationIdentity: async () => `install-${'c'.repeat(64)}` },
      keychain: {
        get: async (key: string) => secureStorage.get(key) ?? null,
        has: async (key: string) => secureStorage.has(key),
        set: async (key: string, value: string) => {
          secureStorage.set(key, value);
          return true;
        },
        delete: async (key: string) => secureStorage.delete(key),
      },
    },
  };
});

let fixture: Awaited<ReturnType<typeof createWorkspaceProjectionFixture>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  vi.restoreAllMocks();
  secureStorage.clear();
  useDataStore.getState().setComments([]);
  useDataStore.getState().setEntityRelations([]);
  useDataStore.getState().setEntityRelationTypes([]);
});

async function setup() {
  fixture = await createWorkspaceProjectionFixture();
  vi.spyOn(database, 'initDatabase').mockResolvedValue(undefined);
  useDataStore.getState().setComments([]);
  let api!: ReturnType<typeof useComment>;
  let relations!: ReturnType<typeof useEntityRelations>;
  function Owner() {
    api = useComment(INPUT);
    relations = useEntityRelations(INPUT);
    return null;
  }
  renderToString(createElement(Owner));
  await api.loadInitial();
  await relations.loadInitial();
  return { db: fixture.db, api, relations };
}

describe('comment target composition and unbinding', () => {
  it('binds a composed comment only when its target chip remains selected', () => {
    expect(
      resolveComposedCommentTargets('note', { kind: 'node', id: 'ch-1' }, [
        { kind: 'node', id: 'ch-1' },
      ]),
    ).toEqual({
      directTarget: { targetKind: 'node', targetId: 'ch-1' },
      extraRelations: [],
    });

    // Removing the pre-filled chapter chip yields a floating (unmounted) note.
    expect(
      resolveComposedCommentTargets('note', { kind: 'node', id: 'ch-1' }, []),
    ).toEqual({
      directTarget: {},
      extraRelations: [],
    });

    // Replacing the chapter chip with another entity binds to the chosen entity only.
    expect(
      resolveComposedCommentTargets('note', { kind: 'node', id: 'ch-1' }, [
        { kind: 'node', id: 'ch-2' },
      ]),
    ).toEqual({
      directTarget: { targetKind: 'node', targetId: 'ch-2' },
      extraRelations: [],
    });

    // Keeping the chapter chip and adding an element prefers the focused chapter as directTarget.
    expect(
      resolveComposedCommentTargets('note', { kind: 'node', id: 'ch-1' }, [
        { kind: 'element', id: 'el-1' },
        { kind: 'node', id: 'ch-1' },
      ]),
    ).toEqual({
      directTarget: { targetKind: 'node', targetId: 'ch-1' },
      extraRelations: [{ kind: 'element', id: 'el-1' }],
    });

    // Creating a note from Project Home with a selected entity binds to that entity.
    expect(
      resolveComposedCommentTargets('note', { kind: null, id: null }, [
        { kind: 'node', id: 'ch-1' },
      ]),
    ).toEqual({
      directTarget: { targetKind: 'node', targetId: 'ch-1' },
      extraRelations: [],
    });

    // Dismissing the material chip when composing from a material tab leaves it unbound.
    expect(
      resolveComposedCommentTargets(
        'note',
        { kind: 'library_item', id: 'mat-1' },
        [],
        false,
      ),
    ).toEqual({
      directTarget: {},
      extraRelations: [],
    });
  });

  it('distinguishes manually detachable bindings from document-owned or converted comments', () => {
    const base: Pick<Comment, 'status' | 'targetKind' | 'targetId' | 'metadataJson'> = {
      status: 'open',
      targetKind: 'node',
      targetId: 'ch-1',
      metadataJson: null,
    };
    expect(canUnbindCommentTarget(base)).toBe(true);
    expect(canUnbindCommentTarget({ ...base, targetKind: 'library_item', targetId: 'mat-1' })).toBe(true);
    expect(canUnbindCommentTarget({ ...base, targetKind: null, targetId: null })).toBe(false);
    expect(canUnbindCommentTarget({ ...base, status: 'converted' })).toBe(false);
    expect(
      canUnbindCommentTarget({
        ...base,
        targetKind: 'library_item',
        targetId: 'mat-1',
        metadataJson: NOTE_TASK_TODO_METADATA,
      }),
    ).toBe(false);
    expect(
      canUnbindCommentTarget({
        ...base,
        metadataJson: JSON.stringify({ kind: 'todo-autoparse', blockId: 'b1', text: 'x' }),
      }),
    ).toBe(false);
  });

  it('persists target unbinding and rebinding through SQLite and the sync journal', async () => {
    const { db, api, relations } = await setup();
    const anchored = await api.createComment({
      kind: 'note',
      targetKind: 'node',
      targetId: 'chapter',
      targetBlockId: 'b-1',
      targetBlockIds: ['b-1', 'b-2'],
      anchorJson: JSON.stringify({ selectedText: 'Quoted passage' }),
      bodyJson: createPlainCommentDoc('Needs revision'),
    });
    const duplicate = await relations.addGenericAssociation('comment', anchored.id, 'node', 'chapter');
    const other = await relations.addGenericAssociation('comment', anchored.id, 'element', 'element');

    const stillAnchored = await api.setCommentTarget(anchored.id, {
      targetKind: 'element',
      targetId: 'element',
    });
    expect(stillAnchored).toEqual(anchored);

    const transferred = await api.unbindCommentTarget(anchored.id);
    expect(transferred).toMatchObject({
      id: anchored.id,
      targetKind: 'element',
      targetId: 'element',
      targetBlockId: null,
      targetBlockIdsJson: '[]',
      anchorJson: '{}',
    });
    const persistedRelations = await db
      .select({ id: EntityRelationTable.id })
      .from(EntityRelationTable)
      .where(eq(EntityRelationTable.fromId, anchored.id));
    expect(persistedRelations).toEqual([]);
    expect(
      useDataStore.getState().entityRelations.filter((relation) => relation.fromId === anchored.id),
    ).toEqual([]);

    const purges = await db
      .select({ id: SyncMutationTable.targetId, changeSetId: SyncMutationTable.changeSetId })
      .from(SyncMutationTable)
      .where(eq(SyncMutationTable.action, 'entity.purge'));
    expect(purges.map((m) => m.id).sort()).toEqual([duplicate.id, other.id].sort());
    expect(new Set(purges.map((m) => m.changeSetId)).size).toBe(1);
    const unbindMutations = await db
      .select({ action: SyncMutationTable.action })
      .from(SyncMutationTable)
      .where(and(
        eq(SyncMutationTable.changeSetId, purges[0].changeSetId),
        eq(SyncMutationTable.targetId, anchored.id),
      ));
    expect(unbindMutations.map((m) => m.action)).toContain('field.set');

    await api.unbindCommentTarget(anchored.id);
    const [rowAfterUnbind] = await db
      .select()
      .from(CommentTable)
      .where(eq(CommentTable.id, anchored.id));
    const floating = {
      targetKind: null,
      targetId: null,
      targetBlockId: null,
      targetBlockIdsJson: '[]',
      anchorJson: '{}',
      bodyJson: anchored.bodyJson,
    };
    expect(rowAfterUnbind).toMatchObject(floating);
    expect(useDataStore.getState().comments.find((c) => c.id === anchored.id)).toMatchObject(floating);

    const rebound = await api.setCommentTarget(anchored.id, {
      targetKind: 'category',
      targetId: 'category',
    });
    expect(rebound).toMatchObject({
      targetKind: 'category',
      targetId: 'category',
      targetBlockId: null,
    });

    // Document-owned checklist/autoparse TODOs ignore unbind requests safely.
    const noteTask = await api.createComment({
      kind: 'todo',
      targetKind: 'library_item',
      targetId: 'library',
      targetBlockId: 'task-1',
      targetBlockIds: ['task-1'],
      bodyJson: createPlainCommentDoc('Note checklist'),
      metadataJson: NOTE_TASK_TODO_METADATA,
    });
    const autoTodo = await api.createComment({
      kind: 'todo',
      targetKind: 'node',
      targetId: 'chapter',
      targetBlockId: 'p-1',
      bodyJson: createPlainCommentDoc('Auto TODO'),
      metadataJson: JSON.stringify({ kind: 'todo-autoparse', blockId: 'p-1', text: 'auto todo' }),
    });

    const changeSetsBefore = await db
      .select()
      .from(SyncChangeSetTable)
      .where(and(eq(SyncChangeSetTable.projectId, INPUT.projectId), eq(SyncChangeSetTable.origin, 'local')));
    await api.unbindCommentTarget(noteTask.id);
    await api.unbindCommentTarget(autoTodo.id);
    const changeSetsAfter = await db
      .select()
      .from(SyncChangeSetTable)
      .where(and(eq(SyncChangeSetTable.projectId, INPUT.projectId), eq(SyncChangeSetTable.origin, 'local')));
    expect(changeSetsAfter).toHaveLength(changeSetsBefore.length);
    await api.revertToNote(autoTodo.id);
    expect(await api.unbindCommentTarget(autoTodo.id)).toMatchObject({
      kind: 'note',
      targetKind: 'node',
      targetId: 'chapter',
      targetBlockId: 'p-1',
    });
  });
});
