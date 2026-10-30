import type { JSONContent } from '@tiptap/core';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';

import type { PersistedAgentRuntimeWriteExpectation } from '../../../domain/agent-runtime-freshness';
import type { PersistedAgentRuntimeWriteEffect } from '../../../domain/agent-runtime-write-effect';
import type { LibraryItem } from '../../../domain/library-item';
import { schemaForProfile } from '../../editor-schema-profile';
import { createLocationResolver, type LocationResolver } from '../../location-link';
import { noteBlockMarkdown } from '../../note-markdown';
import { parseNoteMarkdown } from '../../note-markdown-parse';
import { makeDocId } from '../../yjs-doc-id';
import { createLibraryItemSqliteRepository } from '../../../sqlite-repo/library-item-repo';
import { useDataStore } from '../../../store/data-store';
import { loadLocationResolver, projectLocationEntities } from '../location-link-catalog';
import type { DriftingWriteStrategy } from './drifting-write-strategies';
import { deterministicAgentEntityId } from './entity-write-revision';
import { throwIfAgentAborted } from './errors';
import {
  noteBlocksOperation,
  planNoteRevision,
  type NoteMarkdownCodec,
  type NoteTextChange,
  type PlannedNoteBlock,
} from './material-note-edit';
import type { AgentToolExecutionRequest } from './types';
import {
  createYjsProseSeedState,
  deserializePreparedYjsProseCommand,
  snapshotYjsProseBlocks,
  toPortablePreparedYjsProseCommand,
  type PortablePreparedYjsProseCommand,
  type PreparedYjsProseCommand,
  type YjsProseBlock,
} from './yjs-prose-command';
import {
  createYjsProsePersistenceCoordinator,
  type PreparedYjsProsePersistenceCommand,
  type YjsProsePersistenceBase,
  type YjsProsePersistenceCoordinator,
} from './yjs-prose-persistence-coordinator';
import type { MaterialNoteCommandName } from './drifting-workspace-tool-contract';
import { materialIdByTitle } from './workbench-material-library';

/**
 * Agent writes to a material note's own Yjs document (`library-item:<id>`,
 * `note` schema). Notes sit outside the book, so there is no paragraph review
 * here: the write is reviewed as a whole and rejected through the exact Yjs
 * inverse, like any other Agent effect.
 */
export const MATERIAL_NOTE_OBSERVATION_KIND = 'material_note_prose';

const DEFAULT_FRAGMENT = 'default';

export function materialNoteDocId(itemId: string): string {
  return makeDocId('library-item', itemId);
}

function requireNote(projectId: string, itemId: string): LibraryItem & { kind: 'text' } {
  const item = useDataStore
    .getState()
    .libraryItems.find((candidate) => candidate.id === itemId && candidate.projectId === projectId);
  if (!item) throw new Error('该素材已不存在');
  if (item.kind !== 'text') throw new Error(`「${item.title}」不是笔记，不能编辑正文`);
  return item;
}

/** The note's exact current Yjs base: live editor, durable state or seed. */
export async function readMaterialNoteBase(
  projectId: string,
  itemId: string,
  coordinator: YjsProsePersistenceCoordinator = createYjsProsePersistenceCoordinator(),
): Promise<{ base: YjsProsePersistenceBase; seed: Uint8Array }> {
  const item = requireNote(projectId, itemId);
  const seed = await createYjsProseSeedState(item.bodyJson ?? '{}', 'note');
  const base = await coordinator.readBase(materialNoteDocId(itemId), seed);
  return { base, seed };
}

export function noteContentFromState(stateUpdate: Uint8Array): JSONContent {
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, stateUpdate, 'agent-runtime:material-note-read');
    return yDocToProsemirrorJSON(doc, DEFAULT_FRAGMENT) as JSONContent;
  } finally {
    doc.destroy();
  }
}

function blocksFromState(stateUpdate: Uint8Array): YjsProseBlock[] {
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, stateUpdate, 'agent-runtime:material-note-blocks');
    return snapshotYjsProseBlocks(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * The Markdown dialect the Agent reads and writes notes in. Rendering and
 * parsing share one catalog so a passage the Agent copied from read_material
 * always matches and every embed or location link survives a round trip.
 */
export async function materialNoteCodec(
  projectId: string,
  sources: { contentJson?: string; markdown?: string[] },
  nextId: () => string,
): Promise<NoteMarkdownCodec & { renderAll(nodes: readonly JSONContent[]): string }> {
  const resolver: LocationResolver =
    (await loadLocationResolver(projectId, {
      ...(sources.contentJson ? { contentJson: [sources.contentJson] } : {}),
      ...(sources.markdown ? { markdown: sources.markdown } : {}),
    })) ?? createLocationResolver({ projectId, entities: projectLocationEntities(projectId), blockIds: () => undefined });
  const titles = new Map(
    useDataStore
      .getState()
      .libraryItems.filter((item) => item.projectId === projectId)
      .map((item) => [item.id, item.title || '(untitled)']),
  );
  const embedId = materialIdByTitle(projectId);
  const options = {
    embed: (id: string) => `［素材：${titles.get(id) ?? '已删除'}］`,
    entityLink: (attrs: Readonly<Record<string, unknown>>, text: string) => {
      const href = resolver.format(attrs as never);
      return href ? `[${text}](${href})` : null;
    },
  };
  const render = (nodes: readonly JSONContent[]) => noteBlockMarkdown(nodes, options);
  return {
    render,
    renderAll: (nodes) => render(nodes).filter(Boolean).join('\n\n'),
    parse: (markdown) =>
      parseNoteMarkdown(markdown, {
        nextId,
        embedId,
        location: (href) => {
          const resolved = resolver.resolve(href);
          if (!resolved) return null;
          if (!resolved.ok) throw new Error(resolved.error);
          return resolved.attrs;
        },
      }),
  };
}

/** The note as the Agent reads it: rendered from its current Yjs base. */
export async function readMaterialNoteMarkdown(projectId: string, itemId: string): Promise<string> {
  let content: JSONContent;
  try {
    content = noteContentFromState((await readMaterialNoteBase(projectId, itemId)).base.stateUpdate);
  } catch {
    // A read still shows the note when its document cannot be loaded; any
    // write cites the Yjs base itself and fails closed on its own.
    const item = requireNote(projectId, itemId);
    if (!item.bodyJson) return '';
    content = JSON.parse(item.bodyJson) as JSONContent;
  }
  const codec = await materialNoteCodec(projectId, { contentJson: JSON.stringify(content) }, () => {
    throw new Error('Rendering a note never parses Markdown');
  });
  return codec.renderAll(content.content ?? []);
}

function convertBlocks(nodes: readonly JSONContent[]): YjsProseBlock[] {
  if (nodes.length === 0) return [];
  const doc = prosemirrorJSONToYDoc(schemaForProfile('note'), { type: 'doc', content: [...nodes] }, DEFAULT_FRAGMENT);
  try {
    return snapshotYjsProseBlocks(doc);
  } finally {
    doc.destroy();
  }
}

interface MaterialNotePayload {
  kind: 'material_note_prose';
  toolName: MaterialNoteCommandName;
  itemId: string;
  projectId: string;
  docId: string;
  command: PortablePreparedYjsProseCommand;
  summary: string;
}

interface MaterialNoteExecution {
  command: PreparedYjsProsePersistenceCommand;
  collaborator: { kind: 'agent'; sessionId: string; turnId: string; callId: string };
}

export interface DriftingMaterialNoteWriteStrategyOptions {
  coordinator?: YjsProsePersistenceCoordinator;
  now?: () => string;
}

export function createDriftingMaterialNoteWriteStrategy(
  toolName: MaterialNoteCommandName,
  options: DriftingMaterialNoteWriteStrategyOptions = {},
): DriftingWriteStrategy {
  const coordinator = options.coordinator ?? createYjsProsePersistenceCoordinator();
  const now = options.now ?? (() => new Date().toISOString());

  const commit = async (
    projectId: string,
    itemId: string,
    command: PreparedYjsProsePersistenceCommand,
    collaborator: MaterialNoteExecution['collaborator'],
    direction: 'forward' | 'inverse',
    expectedRevision: number,
  ) => {
    const committedAt = now();
    const result = await coordinator.commit({
      projectId,
      command,
      direction,
      expectedRevision,
      collaborator,
      // The body column is a projection for lists, search and export; like
      // projectNoteBody it is never journaled, the Yjs update already is.
      async persistProjection(tx, projection) {
        const updated = await createLibraryItemSqliteRepository(projectId, tx).update(itemId, {
          bodyJson: projection.contentJson,
          updatedAt: committedAt,
        });
        if (!updated) throw new Error('该笔记已不存在');
      },
    });
    const persisted = await createLibraryItemSqliteRepository(projectId).findById(itemId);
    if (persisted) {
      useDataStore.setState((state) => ({
        libraryItems: state.libraryItems.map((item) => (item.id === itemId ? persisted : item)),
      }));
    }
    return result;
  };

  return {
    async prepare(request, _context, expectation) {
      throwIfAgentAborted(request.signal);
      const projectId = request.context.route.projectId;
      if (!projectId) throw new Error(`${toolName} requires a project route`);
      const itemId = String(request.arguments.materialId ?? '');
      const note = requireNote(projectId, itemId);
      const proseExpectation = requireNoteExpectation(expectation, request, itemId);
      const { base, seed } = await readMaterialNoteBase(projectId, itemId, coordinator);
      if (
        `yjs:${base.revision}` !== proseExpectation.expectedRevision ||
        base.stateHash !== proseExpectation.expectedStateHash ||
        !bytesEqual(base.stateVector, proseExpectation.expectedStateVector)
      ) {
        throw new Error('笔记在读取之后又被修改过；先用 read_material 重新读取');
      }
      const baseBlocks = blocksFromState(base.stateUpdate);
      const content = noteContentFromState(base.stateUpdate);
      const nodes = content.content ?? [];
      if (nodes.length !== baseBlocks.length || nodes.some((node, index) => node.attrs?.id !== baseBlocks[index]!.id)) {
        throw new Error('笔记文档与它的块结构不一致');
      }
      const idBase = await deterministicAgentEntityId(request.idempotencyKey, 'material_note_edit');
      let counter = 0;
      const written =
        toolName === 'replace_material_note_body'
          ? [String(request.arguments.body ?? '')]
          : noteChanges(request.arguments.changes).map((change) => change.revisedText);
      const codec = await materialNoteCodec(
        projectId,
        { contentJson: JSON.stringify(content), markdown: written },
        () => `${idBase}-${++counter}`,
      );
      let planned: PlannedNoteBlock[];
      if (toolName === 'replace_material_note_body') {
        planned = codec.parse(String(request.arguments.body ?? '')).map((node) => ({ kind: 'new', node }));
      } else {
        planned = planNoteRevision(nodes, noteChanges(request.arguments.changes), codec).blocks;
      }
      const converted = convertBlocks(planned.flatMap((entry) => (entry.kind === 'new' ? [entry.node] : [])));
      const operation = noteBlocksOperation(baseBlocks, planned, converted);
      if (!operation) throw new Error(`笔记「${note.title}」已经是所需内容，无需修改`);
      const docId = materialNoteDocId(itemId);
      const command = await coordinator.prepare({
        docId,
        commandId: `agent-material-note:${request.idempotencyKey}`,
        expectedBase: {
          revision: base.revision,
          stateVector: base.stateVector,
          stateHash: base.stateHash,
        },
        operation,
        ...(base.sourceKind === 'seed' ? { seedStateUpdate: seed } : {}),
      });
      const payload: MaterialNotePayload = {
        kind: 'material_note_prose',
        toolName,
        itemId,
        projectId,
        docId,
        command: toPortablePreparedYjsProseCommand(command.prepared),
        summary: typeof request.arguments.changeSummary === 'string' ? request.arguments.changeSummary : '',
      };
      return {
        observedRevision: { kind: 'yjs_prose_revision', nodeId: itemId, docId, revision: `yjs:${base.revision}`, stateHash: base.stateHash },
        preimage: {
          kind: 'yjs_prose_state',
          nodeId: itemId,
          docId,
          revision: `yjs:${base.revision}`,
          stateHash: base.stateHash,
          blockIds: baseBlocks.map((block) => block.id),
        },
        forward: payload,
        inverse: payload,
        reversibility: 'exact',
        execution: {
          command,
          collaborator: { kind: 'agent', sessionId: request.sessionId, turnId: request.turnId, callId: request.callId },
        } satisfies MaterialNoteExecution,
      };
    },

    async applyForward(request, _context, prepared) {
      throwIfAgentAborted(request.signal);
      const payload = parsePayload(prepared.forward, toolName);
      const execution = prepared.execution as MaterialNoteExecution;
      if (!execution?.command) throw new Error(`${toolName} lost its prepared Yjs command`);
      const result = await commit(
        payload.projectId,
        payload.itemId,
        execution.command,
        execution.collaborator,
        'forward',
        execution.command.base.revision,
      );
      return handlerResult(payload, result.receipt.resultStateHash, result.receipt.committedRevision);
    },

    async captureEffect(_request, _context, result, prepared) {
      const payload = parsePayload(prepared.forward, toolName);
      const receipt = await coordinator.getReceipt(payload.command.commandId, 'forward');
      if (
        !receipt ||
        receipt.docId !== payload.docId ||
        (result as { stateHash?: unknown })?.stateHash !== receipt.resultStateHash
      ) {
        throw new Error('The written note command has no exact durable receipt');
      }
      return {
        kind: 'material_note_prose',
        itemId: payload.itemId,
        docId: payload.docId,
        commandId: payload.command.commandId,
        stateHash: receipt.resultStateHash,
        revision: `yjs:${receipt.committedRevision}`,
        handlerResult: result,
      };
    },

    async reconcileEnteredEffect(effect, _context, signal) {
      throwIfAgentAborted(signal);
      const payload = parsePayload(effect.forward, toolName);
      assertEffect(effect, payload);
      const receipt = await coordinator.getReceipt(payload.command.commandId, 'forward');
      if (!receipt || receipt.docId !== payload.docId) return null;
      const result = handlerResult(payload, receipt.resultStateHash, receipt.committedRevision);
      return {
        handlerResult: result,
        committedEffect: {
          kind: 'material_note_prose',
          itemId: payload.itemId,
          docId: payload.docId,
          commandId: payload.command.commandId,
          stateHash: receipt.resultStateHash,
          revision: `yjs:${receipt.committedRevision}`,
          handlerResult: result,
          reconciled: true,
        },
      };
    },

    async applyInverse(effect, _context, signal) {
      throwIfAgentAborted(signal);
      const payload = parsePayload(effect.inverse, toolName);
      assertEffect(effect, payload);
      const prepared = await deserializePreparedYjsProseCommand(payload.command);
      const forward = await coordinator.getReceipt(prepared.commandId, 'forward');
      if (!forward || forward.docId !== payload.docId) throw new Error('The note forward receipt is missing');
      const result = await commit(
        payload.projectId,
        payload.itemId,
        restoreCommand(payload.docId, prepared),
        { kind: 'agent', sessionId: effect.sessionId, turnId: effect.turnId, callId: effect.callId },
        'inverse',
        forward.committedRevision,
      );
      throwIfAgentAborted(signal);
      const rebased = result.receipt.baseRevision > forward.committedRevision;
      if (!rebased && result.receipt.resultStateHash !== prepared.durableWatermark.baseStateHash) {
        throw new Error('The note inverse did not restore the exact base');
      }
      return {
        kind: 'material_note_prose_revert',
        itemId: payload.itemId,
        docId: payload.docId,
        commandId: prepared.commandId,
        stateHash: result.receipt.resultStateHash,
        revision: `yjs:${result.receipt.committedRevision}`,
        rebased,
        reconciled: result.outcome !== 'committed',
      };
    },
  };
}

export function noteChanges(value: unknown): NoteTextChange[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('changes 至少要有一处修改');
  return value.map((entry, index) => {
    const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    if (typeof record.currentText !== 'string' || !record.currentText) {
      throw new Error(`changes[${index}].currentText 不能为空`);
    }
    return {
      currentText: record.currentText,
      revisedText: typeof record.revisedText === 'string' ? record.revisedText : '',
      allOccurrences: record.allOccurrences === true,
    };
  });
}

function restoreCommand(docId: string, prepared: PreparedYjsProseCommand): PreparedYjsProsePersistenceCommand {
  return {
    base: {
      docId,
      sourceKind: prepared.durableWatermark.sourceKind,
      revision: prepared.durableWatermark.baseRevision,
      stateVector: new Uint8Array(prepared.durableWatermark.baseStateVector),
      stateHash: prepared.durableWatermark.baseStateHash,
      // Inverse commits start from the durable forward state.
      stateUpdate: new Uint8Array(),
    },
    prepared,
  };
}

function requireNoteExpectation(
  expectation: PersistedAgentRuntimeWriteExpectation | null | undefined,
  request: AgentToolExecutionRequest,
  itemId: string,
): PersistedAgentRuntimeWriteExpectation & { expectedStateVector: Uint8Array; expectedStateHash: string } {
  if (
    !expectation ||
    expectation.projectId !== request.context.route.projectId ||
    expectation.sessionId !== request.sessionId ||
    expectation.entityKind !== MATERIAL_NOTE_OBSERVATION_KIND ||
    expectation.entityId !== itemId ||
    !expectation.expectedStateVector ||
    !expectation.expectedStateHash
  ) {
    throw new Error(`${request.name} requires a read_material read of this note`);
  }
  return expectation as PersistedAgentRuntimeWriteExpectation & {
    expectedStateVector: Uint8Array;
    expectedStateHash: string;
  };
}

function parsePayload(value: unknown, toolName: MaterialNoteCommandName): MaterialNotePayload {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { kind?: unknown }).kind !== 'material_note_prose' ||
    (value as { toolName?: unknown }).toolName !== toolName
  ) {
    throw new Error(`${toolName} lost its prepared note payload`);
  }
  return value as MaterialNotePayload;
}

function assertEffect(effect: PersistedAgentRuntimeWriteEffect, payload: MaterialNotePayload): void {
  if (effect.projectId !== payload.projectId || effect.toolName !== payload.toolName) {
    throw new Error('The note effect conflicts with its prepared payload');
  }
}

function handlerResult(payload: MaterialNotePayload, stateHash: string, revision: number) {
  return {
    ok: true,
    entityType: 'library_item',
    entityId: payload.itemId,
    stateHash,
    revision: `yjs:${revision}`,
    ...(payload.summary ? { summary: payload.summary } : {}),
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
