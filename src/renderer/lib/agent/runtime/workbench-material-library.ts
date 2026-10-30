import { createPlainCommentDoc, extractTextFromCommentBody } from '../../../domain/comment';
import type { LibraryItem, LibraryItemKind, LibraryTextItem } from '../../../domain/library-item';
import { isDescendantFolder, materialFolderPath, type MaterialFolder } from '../../../domain/material-folder';
import type { DbExecutor, DbTransaction } from '../../../lib/db';
import { noteToMarkdown } from '../../note-markdown';
import { parseNoteMarkdown } from '../../note-markdown-parse';
import { createCommentRepository } from '../../../sqlite-repo/comment-repo';
import { createLibraryItemSqliteRepository } from '../../../sqlite-repo/library-item-repo';
import { createMaterialFolderRepository } from '../../../sqlite-repo/material-folder-repo';
import { useDataStore } from '../../../store/data-store';
import { appendPlannedAuthoredOrderInTransaction } from '../../../sync/journal';
import { entityIdsByNumericPlacement } from '../../../sync/journal/order-authority';
import { libraryMutationPayload } from '../../../usecase/library-item-payload';
import { deleteLibraryItemInTransaction } from '../../../usecase/library-item-deletion';
import type { AtomicSyncWriter } from '../../../usecase/sync-helpers';
import { deterministicAgentEntityId } from './entity-write-revision';
import {
  WorkbenchNoChangeError,
  optionalText,
  requiredText,
  sameAuthoredName,
  type WorkbenchApplyInput,
  type WorkbenchCommand,
  type WorkbenchScope,
} from './drifting-workbench-types';

/**
 * The material library as one scope: its folder tree and each material's
 * title, folder and description. Note bodies are Yjs documents with their own
 * revision (drifting-material-note-write-strategy.ts), so an author typing in
 * a note never invalidates an Agent filing materials.
 */
export interface MaterialLibraryFolder {
  id: string;
  name: string;
  parentFolderId: string | null;
  createdAt: string;
}

export interface MaterialLibraryEntry {
  id: string;
  kind: LibraryItemKind;
  title: string;
  folderId: string | null;
  notesJson: string | null;
}

export interface MaterialLibraryState {
  folders: MaterialLibraryFolder[];
  items: MaterialLibraryEntry[];
}

/** A deleted folder comes back under a new id: sync never revives a purged one. */
interface RestoredFolderExtra {
  deletedFolderId: string;
  restoredFolderId: string;
}

/** A note created by the Agent; its body seeds the document on first open. */
interface CreatedNoteExtra {
  createdNote: LibraryTextItem;
}

const byId = <T extends { id: string }>(left: T, right: T) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

async function loadLibrary(db: DbExecutor, projectId: string): Promise<MaterialLibraryState> {
  const folders = await createMaterialFolderRepository(projectId, db).findAll();
  const items = await createLibraryItemSqliteRepository(projectId, db).findAll();
  return {
    folders: folders
      .map((folder) => ({
        id: folder.id,
        name: folder.name,
        parentFolderId: folder.parentFolderId,
        createdAt: folder.createdAt,
      }))
      .sort(byId),
    items: items
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        folderId: item.folderId,
        notesJson: item.notesJson,
      }))
      .sort(byId),
  };
}

function asFolders(state: MaterialLibraryState, projectId: string): MaterialFolder[] {
  return state.folders.map((folder) => ({ ...folder, projectId, updatedAt: folder.createdAt }));
}

/** "A/B" for a folder; '' for the root. */
export function materialFolderLabel(state: MaterialLibraryState, projectId: string, folderId: string | null): string {
  return materialFolderPath(asFolders(state, projectId), folderId)
    .map((folder) => folder.name)
    .join('/');
}

function normalizeFolderPath(value: string): string {
  return value
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/');
}

/** Folder id for an author path; null for the root ('' or '/'). */
function resolveFolder(state: MaterialLibraryState, projectId: string, value: unknown, field: string): string | null {
  if (typeof value !== 'string') throw new Error(`${field} 必须是文件夹路径`);
  const path = normalizeFolderPath(value);
  if (!path) return null;
  const direct = state.folders.find((folder) => folder.id === path);
  if (direct) return direct.id;
  const matches = state.folders.filter((folder) => sameAuthoredName(materialFolderLabel(state, projectId, folder.id), path));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) throw new Error(`素材文件夹「${path}」不唯一`);
  throw new Error(`没有名为「${path}」的素材文件夹；用 list_materials 查看现有文件夹`);
}

function resolveMaterial(state: MaterialLibraryState, value: unknown): MaterialLibraryEntry {
  const reference = requiredText(value, 'material');
  const direct = state.items.find((item) => item.id === reference);
  if (direct) return direct;
  const matches = state.items.filter((item) => sameAuthoredName(item.title, reference));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`有 ${matches.length} 个素材都叫「${reference}」；先给它们改成不同的标题`);
  }
  throw new Error(`没有标题为「${reference}」的素材；用 list_materials 查看标题`);
}

function assertSiblingNameFree(
  state: MaterialLibraryState,
  name: string,
  parentFolderId: string | null,
  exceptId?: string,
): void {
  if (
    state.folders.some(
      (folder) => folder.id !== exceptId && folder.parentFolderId === parentFolderId && sameAuthoredName(folder.name, name),
    )
  ) {
    throw new Error(`同一位置已有名为「${name}」的文件夹`);
  }
}

function folderName(value: unknown): string {
  const name = requiredText(value, 'name');
  if (name.includes('/')) throw new Error('文件夹名称不能包含 “/”');
  return name;
}

function descriptionJson(value: string): string | null {
  return value.trim() ? createPlainCommentDoc(value) : null;
}

function syncWriter(input: WorkbenchApplyInput<unknown>): AtomicSyncWriter {
  return async (entityType, mutationType, entityId, projectId, payload, parentId) => {
    input.journal.appendDomainMutation(input.changes, {
      entityType,
      mutationType,
      entityId,
      projectId,
      ...(payload ? { payload } : {}),
      ...(parentId ? { parentId } : {}),
    });
  };
}

async function applyLibrary(tx: DbExecutor, input: WorkbenchApplyInput<MaterialLibraryState>): Promise<void> {
  const { projectId, from, to, at } = input;
  const folderRepo = createMaterialFolderRepository(projectId, tx);
  const itemRepo = createLibraryItemSqliteRepository(projectId, tx);
  const sync = syncWriter(input as WorkbenchApplyInput<unknown>);
  const fromFolders = new Map(from.folders.map((folder) => [folder.id, folder]));
  const toFolders = new Map(to.folders.map((folder) => [folder.id, folder]));
  const fromItems = new Map(from.items.map((item) => [item.id, item]));
  const toItems = new Map(to.items.map((item) => [item.id, item]));

  // A command adds at most one folder, under a parent that already exists, so
  // creating folders before moving anything keeps every parent link valid.
  for (const folder of to.folders) {
    if (fromFolders.has(folder.id)) continue;
    const row: MaterialFolder = { ...folder, projectId, updatedAt: at };
    await folderRepo.create(row);
    await sync('materialFolder', 'create', folder.id, projectId, {
      id: folder.id,
      name: folder.name,
      parentFolderId: folder.parentFolderId,
      createdAt: folder.createdAt,
      updatedAt: at,
    });
  }
  for (const folder of to.folders) {
    const before = fromFolders.get(folder.id);
    if (!before) continue;
    const patch: { name?: string; parentFolderId?: string | null } = {};
    if (before.name !== folder.name) patch.name = folder.name;
    if (before.parentFolderId !== folder.parentFolderId) patch.parentFolderId = folder.parentFolderId;
    if (Object.keys(patch).length === 0) continue;
    await folderRepo.update(folder.id, { ...patch, updatedAt: at });
    await sync('materialFolder', 'update', folder.id, projectId, { ...patch, updatedAt: at });
  }

  const created = (input.extra as Partial<CreatedNoteExtra> | null)?.createdNote ?? null;
  for (const item of to.items) {
    if (fromItems.has(item.id)) continue;
    if (!created || created.id !== item.id || input.direction !== 'forward') {
      throw new Error('只有新建笔记可以向素材库添加素材');
    }
    const row: LibraryTextItem = { ...created, createdAt: at, updatedAt: at };
    const persisted = await itemRepo.create(row);
    await sync('libraryItem', 'create', persisted.id, projectId, libraryMutationPayload(persisted));
    const existing = await itemRepo.findAll();
    await appendPlannedAuthoredOrderInTransaction(tx, input.changes, {
      projectId,
      listKind: 'library-item',
      scope: projectId,
      desiredEntityIds: entityIdsByNumericPlacement(
        existing.map((entry) => ({ entityId: entry.id, projection: entry.orderKey })),
      ),
    });
  }
  for (const item of to.items) {
    const before = fromItems.get(item.id);
    if (!before) continue;
    const patch: { title?: string; folderId?: string | null; notesJson?: string | null } = {};
    if (before.title !== item.title) patch.title = item.title;
    if (before.folderId !== item.folderId) patch.folderId = item.folderId;
    if (before.notesJson !== item.notesJson) patch.notesJson = item.notesJson;
    if (Object.keys(patch).length === 0) continue;
    const persisted = await itemRepo.update(item.id, { ...patch, updatedAt: at });
    if (!persisted) throw new Error(`素材 ${item.id} 已不存在`);
    await sync('libraryItem', 'update', item.id, projectId, { ...patch, updatedAt: at });
  }
  for (const item of from.items) {
    if (toItems.has(item.id)) continue;
    if (!created || created.id !== item.id || input.direction !== 'inverse') {
      throw new Error('Agent 不会删除素材');
    }
    const row = await itemRepo.findById(item.id);
    if (!row) continue;
    await deleteLibraryItemInTransaction(tx as DbTransaction, sync, input.changes, projectId, row);
  }
  for (const folder of from.folders) {
    if (toFolders.has(folder.id)) continue;
    await folderRepo.delete(folder.id);
    await sync('materialFolder', 'delete', folder.id, projectId);
  }
}

async function projectLibrary(projectId: string): Promise<void> {
  const [folders, items] = await Promise.all([
    createMaterialFolderRepository(projectId).findAll(),
    createLibraryItemSqliteRepository(projectId).findAll(),
  ]);
  const state = useDataStore.getState();
  state.setMaterialFolders(folders);
  state.setLibraryItems(items as LibraryItem[]);
}

export const MATERIAL_LIBRARY_SCOPE: WorkbenchScope<MaterialLibraryState> = {
  kind: 'material_library',
  readTool: 'list_materials',
  readArguments: () => ({}),
  load: (db, projectId) => loadLibrary(db, projectId),
  apply: applyLibrary,
  project: (projectId) => projectLibrary(projectId),
};

const projectScope = (projectId: string) => projectId;

function withFolder(state: MaterialLibraryState, folder: MaterialLibraryFolder): MaterialLibraryState {
  return { ...state, folders: [...state.folders.filter((entry) => entry.id !== folder.id), folder].sort(byId) };
}

function withItem(state: MaterialLibraryState, item: MaterialLibraryEntry): MaterialLibraryState {
  return { ...state, items: [...state.items.filter((entry) => entry.id !== item.id), item].sort(byId) };
}

function folderDisplay(path: string): string {
  return path ? `「${path}」` : '根目录';
}

const createMaterialFolder: WorkbenchCommand<MaterialLibraryState> = {
  name: 'create_material_folder',
  scope: MATERIAL_LIBRARY_SCOPE,
  scopeId: projectScope,
  resolve(state, args, projectId) {
    const name = folderName(args.name);
    const parentFolderId = args.parent === undefined ? null : resolveFolder(state, projectId, args.parent, 'parent');
    assertSiblingNameFree(state, name, parentFolderId);
    const parentPath = materialFolderLabel(state, projectId, parentFolderId);
    const path = parentPath ? `${parentPath}/${name}` : name;
    return {
      arguments: { name, parentFolderId },
      path: `/materials/${path}/`,
      changeSummary: `新建素材文件夹「${path}」`,
    };
  },
  async plan(state, args, context) {
    const name = folderName(args.name);
    const parentFolderId = (args.parentFolderId as string | null | undefined) ?? null;
    if (parentFolderId !== null && !state.folders.some((folder) => folder.id === parentFolderId)) {
      throw new Error('上级文件夹已不存在');
    }
    assertSiblingNameFree(state, name, parentFolderId);
    const id = await deterministicAgentEntityId(context.idempotencyKey, 'material_folder');
    return { next: withFolder(state, { id, name, parentFolderId, createdAt: context.at }) };
  },
};

const updateMaterialFolder: WorkbenchCommand<MaterialLibraryState> = {
  name: 'update_material_folder',
  scope: MATERIAL_LIBRARY_SCOPE,
  scopeId: projectScope,
  resolve(state, args, projectId) {
    const folderId = resolveFolder(state, projectId, args.folder, 'folder');
    if (folderId === null) throw new Error('根目录不能改名或移动');
    const folder = state.folders.find((entry) => entry.id === folderId)!;
    const name = args.name === undefined ? folder.name : folderName(args.name);
    const parentFolderId =
      args.parent === undefined ? folder.parentFolderId : resolveFolder(state, projectId, args.parent, 'parent');
    if (parentFolderId !== null && isDescendantFolder(asFolders(state, projectId), parentFolderId, folderId)) {
      throw new Error('不能把文件夹移到它自己或它的子文件夹里');
    }
    if (name === folder.name && parentFolderId === folder.parentFolderId) {
      throw new WorkbenchNoChangeError(`素材文件夹「${materialFolderLabel(state, projectId, folderId)}」`);
    }
    assertSiblingNameFree(state, name, parentFolderId, folderId);
    const before = materialFolderLabel(state, projectId, folderId);
    const parentPath = materialFolderLabel(state, projectId, parentFolderId);
    const after = parentPath ? `${parentPath}/${name}` : name;
    return {
      arguments: { folderId, name, parentFolderId },
      path: `/materials/${after}/`,
      changeSummary: before === after ? `更新素材文件夹「${after}」` : `素材文件夹「${before}」改为「${after}」`,
    };
  },
  async plan(state, args, context) {
    const folderId = requiredText(args.folderId, 'folderId');
    const folder = state.folders.find((entry) => entry.id === folderId);
    if (!folder) throw new Error('该素材文件夹已不存在');
    const name = folderName(args.name);
    const parentFolderId = (args.parentFolderId as string | null | undefined) ?? null;
    if (parentFolderId !== null) {
      if (!state.folders.some((entry) => entry.id === parentFolderId)) throw new Error('目标上级文件夹已不存在');
      if (isDescendantFolder(asFolders(state, context.projectId), parentFolderId, folderId)) {
        throw new Error('不能把文件夹移到它自己或它的子文件夹里');
      }
    }
    if (name === folder.name && parentFolderId === folder.parentFolderId) {
      throw new WorkbenchNoChangeError(`素材文件夹「${folder.name}」`);
    }
    assertSiblingNameFree(state, name, parentFolderId, folderId);
    return { next: withFolder(state, { ...folder, name, parentFolderId }) };
  },
};

const deleteMaterialFolder: WorkbenchCommand<MaterialLibraryState> = {
  name: 'delete_material_folder',
  scope: MATERIAL_LIBRARY_SCOPE,
  scopeId: projectScope,
  resolve(state, args, projectId) {
    const folderId = resolveFolder(state, projectId, args.folder, 'folder');
    if (folderId === null) throw new Error('根目录不能删除');
    const path = materialFolderLabel(state, projectId, folderId);
    const parent = state.folders.find((entry) => entry.id === folderId)!.parentFolderId;
    return {
      arguments: { folderId },
      path: `/materials/${path}/`,
      changeSummary: `删除素材文件夹「${path}」，其中的子文件夹和素材移到${folderDisplay(materialFolderLabel(state, projectId, parent))}`,
    };
  },
  async plan(state, args, context) {
    const folderId = requiredText(args.folderId, 'folderId');
    const folder = state.folders.find((entry) => entry.id === folderId);
    if (!folder) throw new Error('该素材文件夹已不存在');
    const parent = folder.parentFolderId;
    return {
      next: {
        folders: state.folders
          .filter((entry) => entry.id !== folderId)
          .map((entry) => (entry.parentFolderId === folderId ? { ...entry, parentFolderId: parent } : entry)),
        items: state.items.map((item) => (item.folderId === folderId ? { ...item, folderId: parent } : item)),
      },
      extra: {
        deletedFolderId: folderId,
        restoredFolderId: await deterministicAgentEntityId(context.idempotencyKey, 'material_folder_restore'),
      } satisfies RestoredFolderExtra,
    };
  },
  inverseImage(before, extra) {
    const { deletedFolderId, restoredFolderId } = extra as RestoredFolderExtra;
    const remap = (id: string | null) => (id === deletedFolderId ? restoredFolderId : id);
    return {
      folders: before.folders
        .map((entry) => ({ ...entry, id: remap(entry.id)!, parentFolderId: remap(entry.parentFolderId) }))
        .sort(byId),
      items: before.items.map((item) => ({ ...item, folderId: remap(item.folderId) })),
    };
  },
};

const updateMaterial: WorkbenchCommand<MaterialLibraryState> = {
  name: 'update_material',
  scope: MATERIAL_LIBRARY_SCOPE,
  scopeId: projectScope,
  resolve(state, args, projectId) {
    const item = resolveMaterial(state, args.material);
    const title = args.title === undefined ? item.title : requiredText(args.title, 'title');
    const folderId = args.folder === undefined ? item.folderId : resolveFolder(state, projectId, args.folder, 'folder');
    const description = optionalText(args.description);
    const notesJson = description === undefined ? item.notesJson : descriptionJson(description);
    if (title === item.title && folderId === item.folderId && notesJson === item.notesJson) {
      throw new WorkbenchNoChangeError(`素材「${item.title}」`);
    }
    const parts: string[] = [];
    if (title !== item.title) parts.push(`改名为「${title}」`);
    if (folderId !== item.folderId) parts.push(`移到${folderDisplay(materialFolderLabel(state, projectId, folderId))}`);
    if (notesJson !== item.notesJson) parts.push(notesJson ? '更新说明' : '清空说明');
    return {
      arguments: { materialId: item.id, title, folderId, notesJson },
      path: `/materials/${title}`,
      changeSummary: `素材「${item.title}」${parts.join('，')}`,
    };
  },
  async plan(state, args) {
    const item = state.items.find((entry) => entry.id === args.materialId);
    if (!item) throw new Error('该素材已不存在');
    const folderId = (args.folderId as string | null | undefined) ?? null;
    if (folderId !== null && !state.folders.some((folder) => folder.id === folderId)) {
      throw new Error('目标文件夹已不存在');
    }
    const next = {
      ...item,
      title: requiredText(args.title, 'title'),
      folderId,
      notesJson: (args.notesJson as string | null | undefined) ?? null,
    };
    if (next.title === item.title && next.folderId === item.folderId && next.notesJson === item.notesJson) {
      throw new WorkbenchNoChangeError(`素材「${item.title}」`);
    }
    return { next: withItem(state, next) };
  },
};

/** Material notes the Agent can embed by title, for the Markdown parser. */
export function materialIdByTitle(projectId: string): (title: string) => string | null {
  const items = useDataStore.getState().libraryItems.filter((item) => item.projectId === projectId);
  return (title) => {
    const matches = items.filter((item) => sameAuthoredName(item.title, title));
    return matches.length === 1 ? matches[0]!.id : null;
  };
}

const createMaterialNote: WorkbenchCommand<MaterialLibraryState> = {
  name: 'create_material_note',
  scope: MATERIAL_LIBRARY_SCOPE,
  scopeId: projectScope,
  resolve(state, args, projectId) {
    const title = requiredText(args.title, 'title');
    const folderId = args.folder === undefined ? null : resolveFolder(state, projectId, args.folder, 'folder');
    const folderPath = materialFolderLabel(state, projectId, folderId);
    return {
      arguments: { title, folderId, body: typeof args.body === 'string' ? args.body : '' },
      path: `/materials/${title}`,
      changeSummary: `在${folderDisplay(folderPath)}新建笔记「${title}」`,
    };
  },
  async plan(state, args, context) {
    const title = requiredText(args.title, 'title');
    const folderId = (args.folderId as string | null | undefined) ?? null;
    if (folderId !== null && !state.folders.some((folder) => folder.id === folderId)) {
      throw new Error('目标文件夹已不存在');
    }
    const id = await deterministicAgentEntityId(context.idempotencyKey, 'material_note');
    let counter = 0;
    const blockIdBase = await deterministicAgentEntityId(context.idempotencyKey, 'material_note_blocks');
    const content = parseNoteMarkdown(String(args.body ?? ''), {
      nextId: () => `${blockIdBase}-${++counter}`,
      embedId: materialIdByTitle(context.projectId),
    });
    const items = useDataStore.getState().libraryItems.filter((item) => item.projectId === context.projectId);
    const orderKeys = items.map((item) => item.orderKey).filter((key) => Number.isFinite(key));
    const createdNote: LibraryTextItem = {
      id,
      projectId: context.projectId,
      kind: 'text',
      title,
      notesJson: null,
      provenanceJson: null,
      orderKey: orderKeys.length > 0 ? Math.min(...orderKeys) - 1 : 0,
      folderId,
      taskTodos: true,
      assetId: null,
      externalUrl: null,
      previewImageUrl: null,
      bodyJson: JSON.stringify({ type: 'doc', content }),
      createdAt: context.at,
      updatedAt: context.at,
    };
    return {
      next: withItem(state, { id, kind: 'text', title, folderId, notesJson: null }),
      extra: { createdNote } satisfies CreatedNoteExtra,
    };
  },
  async assertInverseSafe(tx, projectId, extra) {
    const created = (extra as Partial<CreatedNoteExtra> | null)?.createdNote;
    if (!created) throw new Error('新建笔记的撤销记录不完整');
    const row = await createLibraryItemSqliteRepository(projectId, tx).findById(created.id);
    if (!row) return;
    if (row.kind !== 'text' || noteToMarkdown(row.bodyJson) !== noteToMarkdown(created.bodyJson)) {
      throw new Error('这篇笔记创建后已被修改，不能直接撤销；请手动处理');
    }
    const comments = (await createCommentRepository(projectId, tx).findAll()).filter(
      (comment) => comment.targetKind === 'library_item' && comment.targetId === created.id,
    );
    if (comments.length > 0) {
      const sample = extractTextFromCommentBody(comments[0]!.bodyJson).slice(0, 24);
      throw new Error(`这篇笔记已有批注或待办（如「${sample}」），不能直接撤销`);
    }
  },
};

export const MATERIAL_LIBRARY_COMMANDS = [
  createMaterialNote,
  updateMaterial,
  createMaterialFolder,
  updateMaterialFolder,
  deleteMaterialFolder,
] as const;
