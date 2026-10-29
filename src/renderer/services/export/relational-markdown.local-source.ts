import { asc, eq, inArray, sql } from 'drizzle-orm';

import { getDb } from '../../lib/db';
import { proseDocId } from '../../lib/yjs-doc-id';
import {
  BookElementTable,
  BookActTable,
  DriftGroupTable,
  MaterialFolderTable,
  BookNodeTable,
  CommentTable,
  ElementCategoryTable,
  EntityRelationTable,
  EntityRelationTypeTable,
  LibraryItemTable,
  NodeContentTable,
  NodeStorylineLinkTable,
  ProjectTable,
  ProjectAssetTable,
  StorylineTable,
  YjsDocumentRevisionTable,
  yjsSnapshots,
  yjsUpdates,
} from '../../schema/drizzle';

export type LocalExportProject = typeof ProjectTable.$inferSelect;
export type LocalExportNode = typeof BookNodeTable.$inferSelect;
export type LocalExportNodeContent = typeof NodeContentTable.$inferSelect;
export type LocalExportElement = typeof BookElementTable.$inferSelect;
export type LocalExportCategory = typeof ElementCategoryTable.$inferSelect;
export type LocalExportStoryline = typeof StorylineTable.$inferSelect;
export type LocalExportComment = typeof CommentTable.$inferSelect;
export type LocalExportLibraryItem = typeof LibraryItemTable.$inferSelect;
export type LocalExportRelation = typeof EntityRelationTable.$inferSelect;
export type LocalExportRelationType = typeof EntityRelationTypeTable.$inferSelect;
export type LocalExportStorylineLink = typeof NodeStorylineLinkTable.$inferSelect;

export type LocalExportAsset = typeof ProjectAssetTable.$inferSelect;

export interface LocalExportGraph {
  assets: LocalExportAsset[];
  acts: (typeof BookActTable.$inferSelect)[];
  driftGroups: (typeof DriftGroupTable.$inferSelect)[];
  materialFolders: (typeof MaterialFolderTable.$inferSelect)[];
  nodes: LocalExportNode[];
  nodeContents: LocalExportNodeContent[];
  elements: LocalExportElement[];
  elementCategories: LocalExportCategory[];
  storylines: LocalExportStoryline[];
  comments: LocalExportComment[];
  libraryItems: LocalExportLibraryItem[];
  entityRelations: LocalExportRelation[];
  entityRelationTypes: LocalExportRelationType[];
  nodeStorylineLinks: LocalExportStorylineLink[];
}

export interface LocalExportBook {
  project: LocalExportProject;
  graph: LocalExportGraph;
}

export interface LocalExportProseState {
  snapshot: Uint8Array | null;
  updates: Uint8Array[];
}

export interface LocalRelationalMarkdownSource {
  books: LocalExportBook[];
  proseByDocId: Map<string, LocalExportProseState>;
  /**
   * Incremental captures only: the persisted Yjs version of every document
   * with state. A document listed here but absent from `proseByDocId` was
   * unchanged, and the renderer reuses the prose it hydrated at that version.
   */
  proseVersions?: Map<string, string>;
}

export interface LocalRelationalMarkdownCaptureOptions {
  /** Yjs versions whose prose the caller still holds; their bytes are not read again. */
  knownProseVersions?: ReadonlyMap<string, string>;
}

/** A recreated or restored document restarts its revision, so the time is part of the version. */
export function persistedProseVersion(revision: number, updatedAt: string): string {
  return `${revision}:${updatedAt}`;
}

function normalizeBlob(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return new Uint8Array(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
  }
  if (Array.isArray(input)) return Uint8Array.from(input);
  if (input && typeof input === 'object') {
    const maybeBuffer = input as { type?: string; data?: number[] };
    if (maybeBuffer.type === 'Buffer' && Array.isArray(maybeBuffer.data)) {
      return Uint8Array.from(maybeBuffer.data);
    }
  }
  throw new Error('Unsupported blob format while reading local Yjs export state');
}

function groupByProject<T extends { projectId: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.projectId) ?? [];
    bucket.push(row);
    grouped.set(row.projectId, bucket);
  }
  return grouped;
}

/**
 * Capture one transactionally consistent view of the current local library.
 *
 * The caller owns the open-editor durability barrier. Keeping that flush
 * outside this read transaction avoids waiting on a Yjs write queue while the
 * transaction scheduler is holding the database, while this function makes
 * the structured rows and persisted Yjs state share one SQLite point in time.
 */
export async function readLocalRelationalMarkdownSource(
  projectId?: string,
  options: LocalRelationalMarkdownCaptureOptions = {},
): Promise<LocalRelationalMarkdownSource> {
  const known = projectId ? options.knownProseVersions : undefined;
  return getDb().transaction(async (tx) => {
    // Keep the reads sequential. Native SQLite transactions have one owning
    // connection; concurrent proxy calls would add no useful parallelism.
    const projects = await tx
      .select()
      .from(ProjectTable)
      .where(projectId ? eq(ProjectTable.id, projectId) : undefined)
      .orderBy(asc(ProjectTable.name), asc(ProjectTable.id));
    const acts = await tx.select().from(BookActTable).where(projectId ? eq(BookActTable.projectId, projectId) : undefined).orderBy(asc(BookActTable.id));
    const driftGroups = await tx.select().from(DriftGroupTable).where(projectId ? eq(DriftGroupTable.projectId, projectId) : undefined).orderBy(asc(DriftGroupTable.id));
    const materialFolders = await tx.select().from(MaterialFolderTable).where(projectId ? eq(MaterialFolderTable.projectId, projectId) : undefined).orderBy(asc(MaterialFolderTable.id));
    const assets = await tx.select().from(ProjectAssetTable).where(projectId ? eq(ProjectAssetTable.projectId, projectId) : undefined).orderBy(asc(ProjectAssetTable.id));
    const nodes = await tx.select().from(BookNodeTable).where(projectId ? eq(BookNodeTable.projectId, projectId) : undefined).orderBy(asc(BookNodeTable.id));
    const nodeIds = nodes.map(node => node.id);
    const nodeScope = (column: typeof NodeContentTable.nodeId | typeof NodeStorylineLinkTable.nodeId) =>
      projectId ? (nodeIds.length ? inArray(column, nodeIds) : sql`0`) : undefined;
    const elements = await tx.select().from(BookElementTable).where(projectId ? eq(BookElementTable.projectId, projectId) : undefined).orderBy(asc(BookElementTable.id));
    const categories = await tx
      .select()
      .from(ElementCategoryTable)
      .where(projectId ? eq(ElementCategoryTable.projectId, projectId) : undefined)
      .orderBy(asc(ElementCategoryTable.id));
    const storylines = await tx.select().from(StorylineTable).where(projectId ? eq(StorylineTable.projectId, projectId) : undefined).orderBy(asc(StorylineTable.id));
    const comments = await tx.select().from(CommentTable).where(projectId ? eq(CommentTable.projectId, projectId) : undefined).orderBy(asc(CommentTable.id));
    const libraryItems = await tx
      .select()
      .from(LibraryItemTable)
      .where(projectId ? eq(LibraryItemTable.projectId, projectId) : undefined)
      .orderBy(asc(LibraryItemTable.id));
    const relations = await tx
      .select()
      .from(EntityRelationTable)
      .where(projectId ? eq(EntityRelationTable.projectId, projectId) : undefined)
      .orderBy(asc(EntityRelationTable.id));
    const relationTypes = await tx
      .select()
      .from(EntityRelationTypeTable)
      .where(projectId ? eq(EntityRelationTypeTable.projectId, projectId) : undefined)
      .orderBy(asc(EntityRelationTypeTable.id));
    const storylineLinks = await tx
      .select()
      .from(NodeStorylineLinkTable)
      .where(nodeScope(NodeStorylineLinkTable.nodeId))
      .orderBy(
        asc(NodeStorylineLinkTable.nodeId),
        asc(NodeStorylineLinkTable.storylineId),
      );
    const docIds = [...nodes.map(row => proseDocId('node', row.id)),
      ...elements.map(row => proseDocId('element', row.id)),
      ...categories.map(row => proseDocId('category', row.id)),
      ...storylines.map(row => proseDocId('storyline', row.id))];
    // An incremental capture reads Yjs bytes, and the contentJson seed that
    // stands in for a document without state, only where the version moved.
    let proseVersions: Map<string, string> | undefined;
    let proseDocIds = docIds;
    let contentNodeIds = nodeIds;
    if (known) {
      // The projection renders live entities only; trashed ones need no prose.
      const liveDocIds = [...nodes.filter(row => !row.deletedAt).map(row => proseDocId('node', row.id)),
        ...elements.filter(row => !row.deletedAt).map(row => proseDocId('element', row.id)),
        ...categories.filter(row => !row.deletedAt).map(row => proseDocId('category', row.id)),
        ...storylines.filter(row => !row.deletedAt).map(row => proseDocId('storyline', row.id))];
      const revisions = liveDocIds.length
        ? await tx.select().from(YjsDocumentRevisionTable).where(inArray(YjsDocumentRevisionTable.docId, liveDocIds))
        : [];
      proseVersions = new Map(revisions
        .filter(row => row.revision > 0)
        .map(row => [row.docId, persistedProseVersion(row.revision, row.updatedAt)]));
      proseDocIds = liveDocIds.filter(docId => {
        const version = proseVersions!.get(docId);
        return version === undefined || known.get(docId) !== version;
      });
      const changed = new Set(proseDocIds);
      contentNodeIds = nodeIds.filter(id => changed.has(proseDocId('node', id)));
    }
    const nodeContents = await tx
      .select()
      .from(NodeContentTable)
      .where(known
        ? (contentNodeIds.length ? inArray(NodeContentTable.nodeId, contentNodeIds) : sql`0`)
        : nodeScope(NodeContentTable.nodeId))
      .orderBy(asc(NodeContentTable.nodeId));
    const proseScope = (column: typeof yjsSnapshots.docId | typeof yjsUpdates.docId) =>
      projectId ? (proseDocIds.length ? inArray(column, proseDocIds) : sql`0`) : undefined;
    const snapshotRows = await tx.select().from(yjsSnapshots)
      .where(proseScope(yjsSnapshots.docId))
      .orderBy(asc(yjsSnapshots.docId));
    const updateRows = await tx.select().from(yjsUpdates)
      .where(proseScope(yjsUpdates.docId))
      .orderBy(asc(yjsUpdates.id));

    const assetsByProject = groupByProject(assets);
    const nodesByProject = groupByProject(nodes);
    const elementsByProject = groupByProject(elements);
    const categoriesByProject = groupByProject(categories);
    const storylinesByProject = groupByProject(storylines);
    const commentsByProject = groupByProject(comments);
    const libraryByProject = groupByProject(libraryItems);
    const relationsByProject = groupByProject(relations);
    const relationTypesByProject = groupByProject(relationTypes);
    const nodeProjectById = new Map(nodes.map((node) => [node.id, node.projectId]));
    const nodeContentsByProject = new Map<string, LocalExportNodeContent[]>();
    for (const content of nodeContents) {
      const projectId = nodeProjectById.get(content.nodeId);
      if (!projectId) continue;
      const bucket = nodeContentsByProject.get(projectId) ?? [];
      bucket.push(content);
      nodeContentsByProject.set(projectId, bucket);
    }
    const storylineLinksByProject = new Map<string, LocalExportStorylineLink[]>();
    for (const link of storylineLinks) {
      const projectId = nodeProjectById.get(link.nodeId);
      if (!projectId) continue;
      const bucket = storylineLinksByProject.get(projectId) ?? [];
      bucket.push(link);
      storylineLinksByProject.set(projectId, bucket);
    }

    const books: LocalExportBook[] = projects.map((project) => ({
      project,
      graph: {
        assets: assetsByProject.get(project.id) ?? [],
        acts: acts.filter(act => act.projectId === project.id),
        driftGroups: driftGroups.filter(group => group.projectId === project.id),
        materialFolders: materialFolders.filter(folder => folder.projectId === project.id),
        nodes: nodesByProject.get(project.id) ?? [],
        nodeContents: nodeContentsByProject.get(project.id) ?? [],
        elements: elementsByProject.get(project.id) ?? [],
        elementCategories: categoriesByProject.get(project.id) ?? [],
        storylines: storylinesByProject.get(project.id) ?? [],
        comments: commentsByProject.get(project.id) ?? [],
        libraryItems: libraryByProject.get(project.id) ?? [],
        entityRelations: relationsByProject.get(project.id) ?? [],
        entityRelationTypes: relationTypesByProject.get(project.id) ?? [],
        nodeStorylineLinks: storylineLinksByProject.get(project.id) ?? [],
      },
    }));

    const relevantDocIds = new Set<string>();
    for (const { graph } of books) {
      for (const node of graph.nodes) relevantDocIds.add(proseDocId('node', node.id));
      for (const element of graph.elements) relevantDocIds.add(proseDocId('element', element.id));
      for (const category of graph.elementCategories) {
        relevantDocIds.add(proseDocId('category', category.id));
      }
      for (const storyline of graph.storylines) {
        relevantDocIds.add(proseDocId('storyline', storyline.id));
      }
    }

    const proseByDocId = new Map<string, LocalExportProseState>();
    for (const row of snapshotRows) {
      if (!relevantDocIds.has(row.docId)) continue;
      proseByDocId.set(row.docId, {
        snapshot: normalizeBlob(row.stateBlob),
        updates: [],
      });
    }
    for (const row of updateRows) {
      if (!relevantDocIds.has(row.docId)) continue;
      const state = proseByDocId.get(row.docId) ?? { snapshot: null, updates: [] };
      state.updates.push(normalizeBlob(row.updateBlob));
      proseByDocId.set(row.docId, state);
    }

    return { books, proseByDocId, ...(proseVersions ? { proseVersions } : {}) };
  });
}
