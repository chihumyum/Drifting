import { asc } from 'drizzle-orm';

import { getDb } from '../../lib/db';
import { proseDocId } from '../../lib/yjs-doc-id';
import {
  BookElementTable,
  BookNodeTable,
  CommentTable,
  ElementCategoryTable,
  EntityRelationTable,
  EntityRelationTypeTable,
  LibraryItemTable,
  NodeContentTable,
  NodeStorylineLinkTable,
  ProjectTable,
  StorylineTable,
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

export interface LocalExportGraph {
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
export async function readLocalRelationalMarkdownSource(): Promise<LocalRelationalMarkdownSource> {
  return getDb().transaction(async (tx) => {
    // Keep the reads sequential. Native SQLite transactions have one owning
    // connection; concurrent proxy calls would add no useful parallelism.
    const projects = await tx
      .select()
      .from(ProjectTable)
      .orderBy(asc(ProjectTable.name), asc(ProjectTable.id));
    const nodes = await tx.select().from(BookNodeTable).orderBy(asc(BookNodeTable.id));
    const nodeContents = await tx
      .select()
      .from(NodeContentTable)
      .orderBy(asc(NodeContentTable.nodeId));
    const elements = await tx.select().from(BookElementTable).orderBy(asc(BookElementTable.id));
    const categories = await tx
      .select()
      .from(ElementCategoryTable)
      .orderBy(asc(ElementCategoryTable.id));
    const storylines = await tx.select().from(StorylineTable).orderBy(asc(StorylineTable.id));
    const comments = await tx.select().from(CommentTable).orderBy(asc(CommentTable.id));
    const libraryItems = await tx
      .select()
      .from(LibraryItemTable)
      .orderBy(asc(LibraryItemTable.id));
    const relations = await tx
      .select()
      .from(EntityRelationTable)
      .orderBy(asc(EntityRelationTable.id));
    const relationTypes = await tx
      .select()
      .from(EntityRelationTypeTable)
      .orderBy(asc(EntityRelationTypeTable.id));
    const storylineLinks = await tx
      .select()
      .from(NodeStorylineLinkTable)
      .orderBy(
        asc(NodeStorylineLinkTable.nodeId),
        asc(NodeStorylineLinkTable.storylineId),
      );
    const snapshotRows = await tx.select().from(yjsSnapshots).orderBy(asc(yjsSnapshots.docId));
    const updateRows = await tx.select().from(yjsUpdates).orderBy(asc(yjsUpdates.id));

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

    return { books, proseByDocId };
  });
}
