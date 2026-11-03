// Writes the built-in sample (docs/sample-project.md) into a freshly claimed
// project in a handful of authored transactions. Each object goes through the
// same repositories and journal calls as the author's own action or the
// General Agent's write tool for it; only the batching differs. Chapter,
// idea, element, category and storyline prose becomes live Yjs state through
// the shared seed path (contentJson is its cache); assets arrive already in
// the native asset store with verified local blob receipts.

import { deriveProseMetricFromJson } from '@drifting/prose-metrics';

import type { BookNode } from '../../domain/book-node';
import type { BookAct } from '../../domain/book-act';
import { createPlainCommentDoc, type Comment } from '../../domain/comment';
import {
  normalizeRelationTypeDefinition,
  validateRelationAgainstType,
  type EntityRelationType,
} from '../../domain/entity-relation-type';
import { stringifyKv } from '../../domain/kv';
import type { LibraryItem } from '../../domain/library-item';
import type { MaterialFolder } from '../../domain/material-folder';
import { DEFAULT_CELL_H, DEFAULT_CELL_W, diffPlotGrid, type PlotGrid } from '../../domain/plot-grid';
import type { ProjectAsset } from '../../domain/project-asset';
import type { TimelineMarker } from '../../domain/timeline-marker';
import { createYjsProseSeedState } from '../../lib/agent/runtime/yjs-prose-command';
import type { DbClient, DbTransaction } from '../../lib/db';
import { parseNoteMarkdown } from '../../lib/note-markdown-parse';
import { EntityRelationTable, NodeStorylineLinkTable } from '../../schema/drizzle';
import { createAgentMemoryRepository } from '../../sqlite-repo/agent-memory-repo';
import { createBookActRepository } from '../../sqlite-repo/book-act-repo';
import { createCommentRepository } from '../../sqlite-repo/comment-repo';
import { createBookContentRepository } from '../../sqlite-repo/content-repo';
import { createElementCategoryRepository } from '../../sqlite-repo/element-category-repo';
import { createBookElementSqliteRepository } from '../../sqlite-repo/element-repo';
import { createEntityRelationTypeRepository } from '../../sqlite-repo/entity-relation-type-repo';
import { createLibraryItemSqliteRepository } from '../../sqlite-repo/library-item-repo';
import { createMaterialFolderRepository } from '../../sqlite-repo/material-folder-repo';
import { createBookNodeSqliteRepository } from '../../sqlite-repo/node-repo';
import { createProjectAssetSqliteRepository } from '../../sqlite-repo/project-asset-repo';
import { createProjectRepository } from '../../sqlite-repo/project-repo';
import { createStorylineRepository } from '../../sqlite-repo/storyline-repo';
import { createTimelineMarkerRepository } from '../../sqlite-repo/timeline-marker-repo';
import {
  appendAuthoredNodeStorylineProjectionInTransaction,
  appendPlannedAuthoredOrderInTransaction,
  appendProjectAssetBindMutation,
  entityIdsByNumericPlacement,
  type SyncChangeBuilder,
} from '../../sync/journal';
import { appendAuthoredProseSeedInTransaction } from '../../sync/journal/yjs-update';
import type { BookNodeAtomicTransactionRunner } from '../../usecase/book-node-write';
import { libraryMutationPayload } from '../../usecase/library-item-payload';
import {
  cloneEntityKvEntriesInTransaction,
  replaceElementAliasesInTransaction,
  replaceEntityKvEntriesInTransaction,
} from '../../usecase/normalized-kv-alias-authority';
import { applyPlotGridMutationsInTransaction } from '../../usecase/plot-grid-write';
import type { AtomicSyncWriter } from '../../usecase/sync-helpers';
import { createCommentWithSync, createElementPatchWithSync } from '../../usecase/synced-entity-commands';
import {
  anchorQuotation,
  buildProseDocument,
  createEntityLinker,
  type BookChapter,
  type BookIllustration,
  type EntityLinker,
  type ProseDocument,
} from './book';
import { PRIDE_AND_PREJUDICE, type SampleBook } from './sample-book';

/** Chapters' bookOrder and narrativeOrder: 5, 10, … like chapters made in the app. */
const CHAPTER_STRIDE = 5;
/**
 * Chapter prose is committed in change-sets of about this many Yjs bytes, so
 * a later Hosted upload never meets one oversized change-set.
 */
const CHAPTER_BATCH_BYTES = 320 * 1024;

export interface ImportedSampleAsset {
  asset: ProjectAsset;
  /** After the material transaction commits. */
  commit(): Promise<void>;
  /** When the material transaction did not commit. */
  abandon(): Promise<void>;
}

export interface WriteBookSampleInput {
  database: DbClient;
  projectId: string;
  userId: string;
  runAtomic: BookNodeAtomicTransactionRunner;
  now(): string;
  newId(): string;
  /**
   * The bundled illustrations, imported into the asset store with verified
   * receipts. Started by the caller so native file writes overlap the
   * transactions; awaited before the material transaction.
   */
  assets: Promise<ReadonlyMap<string, ImportedSampleAsset>>;
  /** Progress for diagnostics: a step name and its duration in milliseconds. */
  onStep?(step: string, milliseconds: number): void;
  /** The book to write; the built-in sample's unless another is given. */
  book?: SampleBook;
}

interface PreparedProse {
  document: ProseDocument;
  seed: Uint8Array;
}

interface PreparedChapter extends PreparedProse {
  chapter: BookChapter;
  id: string;
  wordCount: number;
  basisHash: string;
}

const chapterOrder = (number: number) => number * CHAPTER_STRIDE;

async function prepareProse(
  paragraphs: readonly (string | readonly string[])[],
  newId: () => string,
  linker?: EntityLinker,
): Promise<PreparedProse> {
  const document = buildProseDocument(paragraphs, newId, linker);
  return { document, seed: await createYjsProseSeedState(document.contentJson) };
}

async function prepareChapter(chapter: BookChapter, newId: () => string, linker: EntityLinker): Promise<PreparedChapter> {
  const prose = await prepareProse(chapter.blocks, newId, linker);
  const metric = await deriveProseMetricFromJson(prose.document.contentJson);
  return { ...prose, chapter, id: newId(), wordCount: metric.wordCount, basisHash: metric.basisHash };
}

/** The canonical node create payload (useBookNode.createNode). */
function nodeCreatePayload(node: BookNode): Record<string, unknown> {
  return {
    id: node.id,
    title: node.title,
    summary: node.summary,
    bookOrder: node.bookOrder,
    narrativeOrder: node.narrativeOrder,
    kind: node.kind,
    driftGroupId: node.driftGroupId,
    positionX: node.position.x,
    positionY: node.position.y,
    writingStatus: node.writingStatus,
    wordCount: node.wordCount,
    wordCountBasisKind: node.wordCountBasisKind,
    wordCountBasisHash: node.wordCountBasisHash,
    wordCountBasisRevision: node.wordCountBasisRevision,
    wordCountBasisServerSeq: null,
  };
}

/** A chapter or idea and its live prose (useBookNode.createNode); memberships are written by the caller. */
async function createNodeInTransaction(
  tx: DbTransaction,
  sync: AtomicSyncWriter,
  changes: SyncChangeBuilder,
  input: { node: BookNode; prose: PreparedProse },
): Promise<void> {
  const { node, prose } = input;
  await createBookNodeSqliteRepository(node.projectId, tx).create(node);
  await createBookContentRepository(tx).create({ nodeId: node.id, contentJson: prose.document.contentJson });
  await sync('node', 'create', node.id, node.projectId, nodeCreatePayload(node));
  await appendAuthoredProseSeedInTransaction(tx, changes, { entityType: 'node', entityId: node.id, stateUpdate: prose.seed });
}

/**
 * Storyline membership for new chapters, as the Agent's membership write
 * stores a graph: all link rows at once (the first storyline primary), then
 * one membership projection per chapter.
 */
async function writeMembershipsInTransaction(
  tx: DbTransaction,
  changes: SyncChangeBuilder,
  projectId: string,
  memberships: readonly { nodeId: string; storylineIds: readonly string[] }[],
): Promise<void> {
  const links = memberships.flatMap(({ nodeId, storylineIds }) =>
    storylineIds.map((storylineId, index) => ({ nodeId, storylineId, isPrimary: index === 0 })));
  if (links.length) await tx.insert(NodeStorylineLinkTable).values(links);
  for (const { nodeId } of memberships) {
    await appendAuthoredNodeStorylineProjectionInTransaction(tx, changes, { projectId, nodeId });
  }
}

interface WrittenOutline {
  elementIds: Map<string, string>;
  relationTypes: Map<string, EntityRelationType>;
  storylineIds: Map<string, string>;
}

/**
 * Project facts and memory, element categories and elements, relation types
 * and relations between elements, storylines, acts, timeline pins and ideas.
 */
async function writeOutline(
  input: WriteBookSampleInput,
  book: SampleBook,
  elementIds: ReadonlyMap<string, string>,
): Promise<WrittenOutline> {
  const { projectId, newId } = input;
  const now = input.now();
  const categories = await Promise.all(book.categories.map(async (category) => ({
    category, id: newId(), prose: await prepareProse(category.body, newId),
  })));
  const elements = await Promise.all(book.elements.map(async (element) => ({
    element, id: elementIds.get(element.key)!, prose: await prepareProse(element.body, newId),
  })));
  const storylines = await Promise.all(book.storylines.map(async (storyline) => ({
    storyline, id: newId(), prose: await prepareProse(storyline.body, newId),
  })));
  const ideas = await Promise.all(book.ideas.map(async (idea) => {
    const prose = await prepareProse(idea.body, newId);
    const metric = await deriveProseMetricFromJson(prose.document.contentJson);
    return { idea, id: newId(), prose, metric };
  }));
  const storylineIds = new Map(storylines.map(({ storyline, id }) => [storyline.key, id]));
  const relationTypes = new Map<string, EntityRelationType>(book.relationTypes.map((type) => [type.key, {
    id: newId(),
    projectId,
    ...normalizeRelationTypeDefinition({
      name: type.name,
      description: type.description,
      orientation: type.orientation,
      sourceRole: type.sourceRole,
      targetRole: type.targetRole,
      sourceKinds: [...type.sourceKinds],
      targetKinds: [...type.targetKinds],
    }),
    systemKey: null,
    locked: false,
    createdAt: now,
    updatedAt: now,
  }]));

  await input.runAtomic(projectId, async (tx, sync, changes) => {
    // Project summary and facts, as the project settings save them.
    const projects = createProjectRepository(undefined, tx);
    const project = await projects.update(projectId, { summary: book.summary, updatedAt: now });
    if (!project) throw new Error('The sample project disappeared');
    await replaceEntityKvEntriesInTransaction(tx, changes, {
      projectId, ownerKind: 'project', ownerId: projectId, namespace: 'facts', nextJson: stringifyKv([...book.facts]),
    });
    await sync('project', 'update', projectId, projectId, { name: project.name, summary: project.summary });

    // Project Memory, written by the author.
    if (book.memory) {
      const memory = await createAgentMemoryRepository(projectId, tx).create({
        id: newId(), projectId, kind: 'preference', body: book.memory, targetKind: null, targetId: null,
        targetBlockId: null, source: 'author', originRef: null, status: 'active', supersedesId: null,
        createdAt: now, updatedAt: now, deletedAt: null,
      });
      await sync('agentMemory', 'create', memory.id, projectId, {
        id: memory.id, kind: memory.kind, body: memory.body, targetKind: memory.targetKind, targetId: memory.targetId,
        targetBlockId: memory.targetBlockId, source: memory.source, originRef: memory.originRef, status: memory.status,
        supersedesId: memory.supersedesId, deletedAt: memory.deletedAt, createdAt: memory.createdAt, updatedAt: memory.updatedAt,
      });
    }

    // Element categories and elements (create_element_category / create_element).
    const categoryRepository = createElementCategoryRepository(projectId, tx);
    const categoryIds = new Map<string, string>();
    for (const { category, id, prose } of categories) {
      categoryIds.set(category.key, id);
      const value = {
        id, projectId, name: category.name, contentJson: prose.document.contentJson, elementTemplateJson: '{}',
        elementTemplateKvJson: '[]', color: category.color, layoutMode: 'auto' as const, gridX: null, gridY: null,
        createdAt: now, updatedAt: now,
      };
      await categoryRepository.create(value);
      await replaceEntityKvEntriesInTransaction(tx, changes, {
        projectId, ownerKind: 'element-category', ownerId: id, namespace: 'element-template', nextJson: '[]',
      });
      await sync('elementCategory', 'create', id, projectId, {
        id, name: value.name, elementTemplateJson: value.elementTemplateJson, color: value.color,
        layoutMode: value.layoutMode, gridX: value.gridX, gridY: value.gridY,
      });
      await appendAuthoredProseSeedInTransaction(tx, changes, { entityType: 'category', entityId: id, stateUpdate: prose.seed });
    }
    const elementRepository = createBookElementSqliteRepository(projectId, tx);
    for (const { element, id, prose } of elements) {
      const categoryId = categoryIds.get(element.category)!;
      await elementRepository.create({
        id, projectId, categoryId, name: element.name, summary: element.summary,
        contentJson: prose.document.contentJson, kvJson: '[]', aliases: [], groupName: null,
        portraitAssetId: null, createdAt: now, updatedAt: now,
      });
      await replaceEntityKvEntriesInTransaction(tx, changes, {
        projectId, ownerKind: 'element', ownerId: id, namespace: 'facts', nextJson: stringifyKv([...element.facts]),
      });
      await replaceElementAliasesInTransaction(tx, changes, { projectId, elementId: id, aliases: [...element.aliases] });
      await sync('element', 'create', id, projectId, {
        id, categoryId, name: element.name, summary: element.summary, groupName: null, portraitAssetId: null,
      });
      await appendAuthoredProseSeedInTransaction(tx, changes, { entityType: 'element', entityId: id, stateUpdate: prose.seed });
    }

    // Relation types, then relations between elements.
    const relationTypeRepository = createEntityRelationTypeRepository(projectId, tx);
    for (const type of relationTypes.values()) {
      await relationTypeRepository.create(type);
      await sync('entityRelationType', 'create', type.id, projectId, { ...type });
    }
    for (const relation of book.relations) {
      if (typeof relation.to === 'number') continue;
      await insertRelation(tx, sync, {
        projectId, id: newId(), now, type: relationTypes.get(relation.type)!,
        fromKind: 'element', fromId: elementIds.get(relation.from)!,
        toKind: 'element', toId: elementIds.get(relation.to)!,
      });
    }

    // Storylines (create_storyline), ordered once all exist.
    const storylineRepository = createStorylineRepository(projectId, tx);
    for (const [index, { storyline, id, prose }] of storylines.entries()) {
      await storylineRepository.createStoryline({
        id, projectId, name: storyline.name, color: storyline.color, summary: storyline.summary,
        orderKey: index + 1, contentJson: prose.document.contentJson, kvJson: '[]',
        nodeContentTemplateJson: '{}', createdAt: now, updatedAt: now,
      });
      await cloneEntityKvEntriesInTransaction(tx, changes, {
        source: { projectId, ownerKind: 'project', ownerId: projectId, namespace: 'storyline-template' },
        target: { projectId, ownerKind: 'storyline', ownerId: id, namespace: 'facts' },
      });
      await sync('storyline', 'create', id, projectId, {
        id, name: storyline.name, color: storyline.color, summary: storyline.summary, nodeContentTemplateJson: '{}',
      });
      await appendAuthoredProseSeedInTransaction(tx, changes, { entityType: 'storyline', entityId: id, stateUpdate: prose.seed });
    }
    await appendPlannedAuthoredOrderInTransaction(tx, changes, {
      projectId, listKind: 'storyline', scope: projectId,
      desiredEntityIds: entityIdsByNumericPlacement(
        (await storylineRepository.getStorylinesByProject()).map((entry) => ({ entityId: entry.id, projection: entry.orderKey })),
      ),
    });

    // The volumes as acts: each boundary sits just before its first chapter.
    const actRepository = createBookActRepository(projectId, tx);
    for (const volume of book.volumes) {
      const act: BookAct = {
        id: newId(), projectId, name: volume.name, color: null,
        startOrder: chapterOrder(volume.firstChapter) - CHAPTER_STRIDE / 2, driftNodeId: null, createdAt: now, updatedAt: now,
      };
      await actRepository.create(act);
      await sync('bookAct', 'create', act.id, projectId, {
        id: act.id, name: act.name, color: act.color, startOrder: act.startOrder, driftNodeId: act.driftNodeId,
        createdAt: act.createdAt, updatedAt: act.updatedAt,
      });
    }

    // Pins on the narrative timeline, which shares the chapters' coordinates.
    const markerRepository = createTimelineMarkerRepository(projectId, tx);
    for (const pin of book.timelinePins) {
      const marker: TimelineMarker = {
        id: newId(), projectId, narrativeOrder: chapterOrder(pin.beforeChapter) - CHAPTER_STRIDE / 2,
        label: pin.label, driftNodeId: null, createdAt: now, updatedAt: now,
      };
      await markerRepository.create(marker);
      await sync('timelineMarker', 'create', marker.id, projectId, {
        id: marker.id, narrativeOrder: marker.narrativeOrder, label: marker.label, driftNodeId: marker.driftNodeId,
        createdAt: marker.createdAt, updatedAt: marker.updatedAt,
      });
    }

    // Ideas (构想): drift nodes with their own prose.
    for (const { idea, id, prose, metric } of ideas) {
      await createNodeInTransaction(tx, sync, changes, {
        node: {
          id, projectId, kind: 'drift', title: idea.title, summary: idea.summary, bookOrder: null, narrativeOrder: null,
          driftGroupId: null, position: { x: 0, y: 0 }, writingStatus: 'drifting', wordCount: metric.wordCount,
          wordCountBasisKind: 'yjs', wordCountBasisHash: metric.basisHash, wordCountBasisRevision: 1,
          wordCountBasisServerSeq: null, createdAt: now, updatedAt: now,
        },
        prose,
      });
    }
  });
  return { elementIds: new Map(elementIds), relationTypes, storylineIds };
}

async function insertRelation(
  tx: DbTransaction,
  sync: AtomicSyncWriter,
  input: {
    projectId: string; id: string; now: string; type: EntityRelationType;
    fromKind: 'element' | 'node'; fromId: string; toKind: 'element' | 'node'; toId: string;
  },
): Promise<void> {
  const checked = validateRelationAgainstType(input.type, {
    fromKind: input.fromKind, fromId: input.fromId, toKind: input.toKind, toId: input.toId,
  });
  if (!checked.ok) throw new Error(checked.message);
  const row = {
    id: input.id, projectId: input.projectId, ...checked.relation, relationTypeId: input.type.id,
    createdAt: input.now, updatedAt: input.now,
  };
  await tx.insert(EntityRelationTable).values(row);
  await sync('entityRelation', 'create', row.id, input.projectId, {
    id: row.id, fromKind: row.fromKind, fromId: row.fromId, toKind: row.toKind, toId: row.toId, relationTypeId: row.relationTypeId,
  });
}

/**
 * Build every chapter's document, word count and Yjs seed in order on one
 * chain, so later chapters are prepared while earlier transactions wait on the
 * database.
 */
function prepareChapters(book: SampleBook, newId: () => string, linker: EntityLinker): Promise<PreparedChapter>[] {
  const preparations: Promise<PreparedChapter>[] = [];
  let previous: Promise<unknown> = Promise.resolve();
  for (const chapter of book.chapters) {
    const next = previous.then(() => prepareChapter(chapter, newId, linker));
    next.catch(() => undefined);
    preparations.push(next);
    previous = next.catch(() => undefined);
  }
  return preparations;
}

/** Every chapter with its storylines, in change-sets of bounded Yjs size. */
async function writeChapters(
  input: WriteBookSampleInput,
  book: SampleBook,
  outline: WrittenOutline,
  preparations: readonly Promise<PreparedChapter>[],
): Promise<Map<number, PreparedChapter>> {
  const { projectId } = input;
  const written = new Map<number, PreparedChapter>();
  const commit = async (batch: PreparedChapter[]) => {
    const now = input.now();
    await input.runAtomic(projectId, async (tx, sync, changes) => {
      for (const prepared of batch) {
        const { number } = prepared.chapter;
        const plan = book.chapterPlans[number - 1];
        await createNodeInTransaction(tx, sync, changes, {
          node: {
            id: prepared.id, projectId, kind: 'chapter', title: book.chapterTitle(number), summary: plan.summary,
            bookOrder: chapterOrder(number), narrativeOrder: chapterOrder(number), driftGroupId: null,
            position: { x: 0, y: 0 }, writingStatus: 'draft', wordCount: prepared.wordCount,
            wordCountBasisKind: 'yjs', wordCountBasisHash: prepared.basisHash, wordCountBasisRevision: 1,
            wordCountBasisServerSeq: null, createdAt: now, updatedAt: now,
          },
          prose: prepared,
        });
      }
      await writeMembershipsInTransaction(tx, changes, projectId, batch.map((prepared) => ({
        nodeId: prepared.id,
        storylineIds: book.chapterPlans[prepared.chapter.number - 1].storylines.map((key) => outline.storylineIds.get(key)!),
      })));
    });
    for (const prepared of batch) written.set(prepared.chapter.number, prepared);
  };
  let batch: PreparedChapter[] = [];
  let bytes = 0;
  for (const preparation of preparations) {
    const prepared = await preparation;
    if (batch.length && bytes + prepared.seed.byteLength > CHAPTER_BATCH_BYTES) {
      await commit(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(prepared);
    bytes += prepared.seed.byteLength;
  }
  if (batch.length) await commit(batch);
  return written;
}

/** Review work on the text: relations to chapters, comments, patches, a finished chapter, a plot grid. */
async function writeReview(
  input: WriteBookSampleInput,
  book: SampleBook,
  outline: WrittenOutline,
  chapters: Map<number, PreparedChapter>,
): Promise<void> {
  const { projectId, newId, userId } = input;
  const now = input.now();
  const chapter = (number: number) => {
    const prepared = chapters.get(number);
    if (!prepared) throw new Error(`Sample chapter ${number} was not written`);
    return prepared;
  };
  const reviewed = book.relations.some((relation) => typeof relation.to === 'number') || book.comments.length
    || book.elementPatches.length || book.finishedChapters.length || book.plotGrid;
  if (!reviewed) return;
  await input.runAtomic(projectId, async (tx, sync, changes) => {
    const inline: BookNodeAtomicTransactionRunner = (_projectId, work) => work(tx, sync, changes);
    for (const relation of book.relations) {
      if (typeof relation.to !== 'number') continue;
      await insertRelation(tx, sync, {
        projectId, id: newId(), now, type: outline.relationTypes.get(relation.type)!,
        fromKind: 'element', fromId: outline.elementIds.get(relation.from)!, toKind: 'node', toId: chapter(relation.to).id,
      });
    }

    // Comments and TODOs, anchored to a selection as the editor records it.
    const commentRepository = createCommentRepository(projectId, tx);
    for (const item of book.comments) {
      let target: Pick<Comment, 'targetKind' | 'targetId' | 'targetBlockId' | 'anchorJson' | 'targetBlockIdsJson'>;
      if (item.chapter !== undefined) {
        const prepared = chapter(item.chapter);
        const anchor = anchorQuotation(prepared.document, item.quotation!);
        target = {
          targetKind: 'node', targetId: prepared.id, targetBlockId: anchor.blockId,
          targetBlockIdsJson: JSON.stringify([anchor.blockId]),
          anchorJson: JSON.stringify({
            selectedText: anchor.text, selectionFrom: anchor.docFrom, selectionTo: anchor.docTo, createdAt: now,
            blockText: anchor.blockText, blockSelectionFrom: anchor.from, blockSelectionTo: anchor.to,
            blockSnapshots: [{ blockId: anchor.blockId, blockText: anchor.blockText }],
            textAnchor: { startBlockId: anchor.blockId, startOffset: anchor.from, endBlockId: anchor.blockId, endOffset: anchor.to, text: anchor.text },
          }),
        };
      } else {
        target = {
          targetKind: 'element', targetId: outline.elementIds.get(item.element!)!, targetBlockId: null,
          anchorJson: '{}', targetBlockIdsJson: '[]',
        };
      }
      const comment = await createCommentWithSync({
        id: newId(), projectId, kind: item.kind, ...target, authorKind: 'user', authorId: userId, authorName: null,
        bodyJson: createPlainCommentDoc(item.body), status: 'open', priority: null, source: 'manual',
        metadataJson: null, resolvedAt: null, createdAt: now, updatedAt: now,
      }, inline);
      if (item.resolved) {
        const resolved = await commentRepository.update(comment.id, { status: 'resolved', resolvedAt: now, updatedAt: now });
        if (!resolved) throw new Error('A sample comment disappeared while it was resolved');
        await sync('comment', 'update', comment.id, projectId, { status: resolved.status, resolvedAt: resolved.resolvedAt });
      }
    }

    // Element patches anchored to the passage that changes the element.
    for (const patch of book.elementPatches) {
      const prepared = chapter(patch.chapter);
      const anchor = anchorQuotation(prepared.document, patch.quotation);
      await createElementPatchWithSync({
        id: newId(), projectId, elementId: outline.elementIds.get(patch.element)!, sourceNodeId: prepared.id,
        sourceBlockId: anchor.blockId, sourceBlockText: anchor.blockText,
        textAnchorJson: JSON.stringify({ startBlockId: anchor.blockId, startOffset: anchor.from, endBlockId: anchor.blockId, endOffset: anchor.to, text: anchor.text }),
        title: patch.title, contentJson: createPlainCommentDoc(patch.body),
      }, inline);
    }

    // The writing status the chapter-end menu sets.
    const nodes = createBookNodeSqliteRepository(projectId, tx);
    for (const number of book.finishedChapters) {
      const finished = chapter(number);
      const updated = await nodes.update(finished.id, { writingStatus: 'finished', updatedAt: now });
      if (!updated) throw new Error('A finished sample chapter disappeared');
      await sync('node', 'update', finished.id, projectId, { writingStatus: 'finished' });
    }

    // A plot grid for one crowded chapter.
    const plotGrid = book.plotGrid;
    if (!plotGrid) return;
    const columns = plotGrid.columns.map((label) => ({ id: newId(), label }));
    const rows = plotGrid.rows.map((row) => ({ id: newId(), label: row.label }));
    const cells: Record<string, string> = {};
    plotGrid.rows.forEach((row, rowIndex) => row.cells.forEach((value, columnIndex) => {
      if (value) cells[`${rows[rowIndex].id}:${columns[columnIndex].id}`] = value;
    }));
    const grid: PlotGrid = { rows, cols: columns, cells, cellW: DEFAULT_CELL_W, cellH: DEFAULT_CELL_H };
    await applyPlotGridMutationsInTransaction(tx, changes, {
      projectId, nodeId: chapter(plotGrid.chapter).id, mutations: diffPlotGrid(null, grid),
    });
  });
}

/** Material notes, the illustration folder and its images, and the element portraits. */
async function writeMaterials(input: WriteBookSampleInput, book: SampleBook, outline: WrittenOutline): Promise<void> {
  const { projectId, newId } = input;
  const assets = await input.assets;
  const now = input.now();
  const asset = (illustration: BookIllustration) => {
    const imported = assets.get(illustration.name);
    if (!imported) throw new Error(`Sample illustration ${illustration.name} was not imported`);
    return imported.asset;
  };
  const materials = book.illustrations.filter((illustration) => illustration.use === 'material');
  const folder: MaterialFolder | null = materials.length && book.illustrationFolder
    ? { id: newId(), projectId, name: book.illustrationFolder, parentFolderId: null, createdAt: now, updatedAt: now }
    : null;
  const items: LibraryItem[] = book.materialNotes.map((note, index) => {
    const blockIds = newId();
    let counter = 0;
    const content = parseNoteMarkdown(note.markdown, { nextId: () => `${blockIds}-${++counter}`, embedId: () => null });
    return {
      id: newId(), projectId, title: note.title, kind: 'text', assetId: null, externalUrl: null, previewImageUrl: null,
      bodyJson: JSON.stringify({ type: 'doc', content }), notesJson: null, provenanceJson: null, orderKey: index,
      folderId: null, taskTodos: true, createdAt: now, updatedAt: now,
    };
  });
  for (const illustration of materials) {
    items.push({
      id: newId(), projectId, title: illustration.title, kind: 'image', assetId: asset(illustration).id,
      externalUrl: null, previewImageUrl: null, bodyJson: null,
      notesJson: createPlainCommentDoc(book.illustrationNotes[illustration.name] ?? ''), provenanceJson: null,
      orderKey: items.length, folderId: folder?.id ?? null, taskTodos: true, createdAt: now, updatedAt: now,
    });
  }
  const portraits = book.elements.filter((element) => element.portrait).map((element) => {
    const illustration = book.illustrations.find((entry) => entry.name === element.portrait && entry.use === 'portrait');
    if (!illustration) throw new Error(`Sample portrait ${element.portrait} is not bundled`);
    return { elementId: outline.elementIds.get(element.key)!, asset: asset(illustration) };
  });
  if (!items.length && !portraits.length) return;

  await input.runAtomic(projectId, async (tx, sync, changes) => {
    if (folder) {
      await createMaterialFolderRepository(projectId, tx).create(folder);
      await sync('materialFolder', 'create', folder.id, projectId, {
        id: folder.id, name: folder.name, parentFolderId: folder.parentFolderId, createdAt: folder.createdAt, updatedAt: folder.updatedAt,
      });
    }
    const assetRepository = createProjectAssetSqliteRepository(projectId, tx);
    const itemRepository = createLibraryItemSqliteRepository(projectId, tx);
    for (const item of items) {
      if (item.assetId) {
        const bound = [...assets.values()].find((entry) => entry.asset.id === item.assetId)!.asset;
        await assetRepository.create(bound);
        appendProjectAssetBindMutation(changes, projectId, bound, { kind: 'library-item', id: item.id });
      }
      await itemRepository.create(item);
      await sync('libraryItem', 'create', item.id, projectId, libraryMutationPayload(item));
    }
    await appendPlannedAuthoredOrderInTransaction(tx, changes, {
      projectId, listKind: 'library-item', scope: projectId, desiredEntityIds: items.map((item) => item.id),
    });
    const elementRepository = createBookElementSqliteRepository(projectId, tx);
    for (const portrait of portraits) {
      await assetRepository.create(portrait.asset);
      appendProjectAssetBindMutation(changes, projectId, portrait.asset, { kind: 'element-portrait', id: portrait.elementId });
      const element = await elementRepository.update(portrait.elementId, { portraitAssetId: portrait.asset.id, updatedAt: portrait.asset.createdAt });
      if (!element) throw new Error('A sample element disappeared before its portrait was set');
    }
  });
}

/**
 * Write the whole sample into `projectId`, which the caller has created and
 * claimed. A failure leaves partial rows for the caller to discard.
 */
export async function writeBookSample(input: WriteBookSampleInput): Promise<void> {
  const time = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    const result = await run();
    input.onStep?.(step, performance.now() - started);
    return result;
  };
  const book = input.book ?? PRIDE_AND_PREJUDICE;
  const started = performance.now();
  // Element ids come first: the chapters link the names that point at them.
  const elementIds = new Map(book.elements.map((element) => [element.key, input.newId()]));
  const linker = createEntityLinker(new Map(book.linkForms.map(({ form, element }) =>
    [form, element === null ? null : elementIds.get(element)!])), book.linkBoundaries);
  const preparations = prepareChapters(book, input.newId, linker);
  void Promise.all(preparations).then(() => input.onStep?.('chaptersPreparedAt', performance.now() - started), () => undefined);
  void input.assets.then(() => input.onStep?.('assetsReadyAt', performance.now() - started), () => undefined);
  const outline = await time('outline', () => writeOutline(input, book, elementIds));
  const chapters = await time('chapters', () => writeChapters(input, book, outline, preparations));
  await time('review', () => writeReview(input, book, outline, chapters));
  await time('materials', () => writeMaterials(input, book, outline));
}
