import * as Y from 'yjs';
import { and, eq, isNull } from 'drizzle-orm';
import { createBookContentRepository } from '../sqlite-repo/content-repo';
import { createYjsRepository } from '../sqlite-repo/yjs-repo';
import { getDb } from '../lib/db';
import { getLiveYDoc } from '../lib/yjs-doc-registry';
import { proseDocId, type ProseEntityType } from '../lib/yjs-doc-id';
import { createYjsProseSeedState } from '../lib/agent/runtime/yjs-prose-command';
import { canonicalAgentRuntimeJson } from '../sqlite-repo/agent-runtime-persistence-repo';
import { flushOpenYjsDocument } from './yjs-sync.service';
import { restoreEntitySnapshotPayload } from './snapshot-restore.service';
import {
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  StorylineTable,
} from '../schema/drizzle';
import { decodeAliases } from '../domain/book-element';

export interface AgentCheckpointWorkspaceEntityState {
  projectId: string;
  entityKind: ProseEntityType;
  entityId: string;
  displayName: string;
  documentId: string;
  yjsRevision: number;
  stateVector: Uint8Array;
  stateHash: string;
  contentHash: string;
  stateBlob: Uint8Array;
  metadataJson: string;
  metadataHash: string;
}

export interface AgentUserCheckpointWorkspace {
  listProjectEntityStates(projectId: string): Promise<AgentCheckpointWorkspaceEntityState[]>;
  readEntityState(
    projectId: string,
    entityKind: ProseEntityType,
    entityId: string,
  ): Promise<AgentCheckpointWorkspaceEntityState | null>;
  restoreEntityState(state: AgentCheckpointWorkspaceEntityState): Promise<void>;
}

interface EntitySeed {
  projectId: string;
  entityKind: ProseEntityType;
  entityId: string;
  displayName: string;
  contentJson: string;
  metadata: Record<string, unknown>;
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', value as BufferSource);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function seedForEntity(
  projectId: string,
  entityKind: ProseEntityType,
  entityId: string,
): Promise<EntitySeed | null> {
  switch (entityKind) {
    case 'node': {
      const rows = await getDb()
        .select()
        .from(BookNodeTable)
        .where(
          and(
            eq(BookNodeTable.projectId, projectId),
            eq(BookNodeTable.id, entityId),
            isNull(BookNodeTable.deletedAt),
          ),
        )
        .limit(1);
      const node = rows[0];
      if (!node) return null;
      const content = await createBookContentRepository().findByNodeId(node.id);
      return {
        projectId,
        entityKind,
        entityId,
        displayName: node.title,
        contentJson: content?.contentJson ?? '{}',
        metadata: {
          title: node.title,
          summary: node.summary,
          writingStatus: node.writingStatus,
        },
      };
    }
    case 'element': {
      const rows = await getDb()
        .select()
        .from(BookElementTable)
        .where(
          and(
            eq(BookElementTable.projectId, projectId),
            eq(BookElementTable.id, entityId),
            isNull(BookElementTable.deletedAt),
          ),
        )
        .limit(1);
      const entity = rows[0];
      if (!entity) return null;
      return {
        projectId,
        entityKind,
        entityId,
        displayName: entity.name,
        contentJson: entity.contentJson ?? '{}',
        metadata: {
          name: entity.name,
          summary: entity.summary,
          aliases: decodeAliases(entity.aliasesJson),
          groupName: entity.groupName,
          kvJson: entity.kvJson,
        },
      };
    }
    case 'storyline': {
      const rows = await getDb()
        .select()
        .from(StorylineTable)
        .where(
          and(
            eq(StorylineTable.projectId, projectId),
            eq(StorylineTable.id, entityId),
            isNull(StorylineTable.deletedAt),
          ),
        )
        .limit(1);
      const entity = rows[0];
      if (!entity) return null;
      return {
        projectId,
        entityKind,
        entityId,
        displayName: entity.name,
        contentJson: entity.contentJson,
        metadata: {
          name: entity.name,
          summary: entity.summary,
          kvJson: entity.kvJson,
        },
      };
    }
    case 'category': {
      const rows = await getDb()
        .select()
        .from(ElementCategoryTable)
        .where(
          and(
            eq(ElementCategoryTable.projectId, projectId),
            eq(ElementCategoryTable.id, entityId),
            isNull(ElementCategoryTable.deletedAt),
          ),
        )
        .limit(1);
      const entity = rows[0];
      if (!entity) return null;
      return {
        projectId,
        entityKind,
        entityId,
        displayName: entity.name,
        contentJson: entity.contentJson ?? '{}',
        metadata: {
          name: entity.name,
          elementTemplateKvJson: entity.elementTemplateKvJson,
        },
      };
    }
  }
}

async function materializeState(seed: EntitySeed): Promise<AgentCheckpointWorkspaceEntityState> {
  const documentId = proseDocId(seed.entityKind, seed.entityId);
  const yjs = createYjsRepository();
  const live = getLiveYDoc(documentId);
  let doc: Y.Doc;
  let owned = false;

  if (live) {
    // The live editor's async SQLite queue is part of the checkpoint boundary.
    await flushOpenYjsDocument(documentId);
    doc = live;
  } else {
    doc = new Y.Doc();
    owned = true;
    if (await yjs.hasDocState(documentId)) {
      const snapshot = await yjs.getSnapshot(documentId);
      if (snapshot) Y.applyUpdate(doc, snapshot.stateBlob, 'checkpoint-load');
      for (const update of await yjs.listUpdates(documentId)) {
        Y.applyUpdate(doc, update.updateBlob, 'checkpoint-load');
      }
    } else {
      Y.applyUpdate(
        doc,
        await createYjsProseSeedState(seed.contentJson),
        'checkpoint-seed',
      );
    }
  }

  try {
    const { yDocToProsemirrorJSON } = await import('y-prosemirror');
    const stateBlob = Y.encodeStateAsUpdate(doc);
    const stateVector = Y.encodeStateVector(doc);
    const metadataJson = canonicalAgentRuntimeJson(seed.metadata);
    const contentJson = canonicalAgentRuntimeJson(
      yDocToProsemirrorJSON(doc, 'default'),
    );
    return {
      projectId: seed.projectId,
      entityKind: seed.entityKind,
      entityId: seed.entityId,
      displayName: seed.displayName,
      documentId,
      yjsRevision: await yjs.getRevision(documentId),
      stateVector,
      stateHash: await sha256Bytes(stateBlob),
      contentHash: await sha256Text(contentJson),
      stateBlob,
      metadataJson,
      metadataHash: await sha256Text(metadataJson),
    };
  } finally {
    if (owned) doc.destroy();
  }
}

export function createProductAgentUserCheckpointWorkspace(): AgentUserCheckpointWorkspace {
  return {
    async listProjectEntityStates(projectId) {
      const [nodes, elements, storylines, categories] = await Promise.all([
        getDb()
          .select({ id: BookNodeTable.id })
          .from(BookNodeTable)
          .where(
            and(
              eq(BookNodeTable.projectId, projectId),
              isNull(BookNodeTable.deletedAt),
            ),
          ),
        getDb()
          .select({ id: BookElementTable.id })
          .from(BookElementTable)
          .where(
            and(
              eq(BookElementTable.projectId, projectId),
              isNull(BookElementTable.deletedAt),
            ),
          ),
        getDb()
          .select({ id: StorylineTable.id })
          .from(StorylineTable)
          .where(
            and(
              eq(StorylineTable.projectId, projectId),
              isNull(StorylineTable.deletedAt),
            ),
          ),
        getDb()
          .select({ id: ElementCategoryTable.id })
          .from(ElementCategoryTable)
          .where(
            and(
              eq(ElementCategoryTable.projectId, projectId),
              isNull(ElementCategoryTable.deletedAt),
            ),
          ),
      ]);
      const identities: Array<[ProseEntityType, string]> = [
        ...nodes.map((entity): [ProseEntityType, string] => ['node', entity.id]),
        ...elements.map((entity): [ProseEntityType, string] => ['element', entity.id]),
        ...storylines.map((entity): [ProseEntityType, string] => ['storyline', entity.id]),
        ...categories.map((entity): [ProseEntityType, string] => ['category', entity.id]),
      ].sort(([leftKind, leftId], [rightKind, rightId]) =>
        leftKind.localeCompare(rightKind, 'en') || leftId.localeCompare(rightId, 'en'),
      );
      const states: AgentCheckpointWorkspaceEntityState[] = [];
      for (const [kind, id] of identities) {
        const seed = await seedForEntity(projectId, kind, id);
        if (!seed) continue;
        states.push(await materializeState(seed));
      }
      return states;
    },

    async readEntityState(projectId, entityKind, entityId) {
      const seed = await seedForEntity(projectId, entityKind, entityId);
      return seed ? materializeState(seed) : null;
    },

    async restoreEntityState(state) {
      await restoreEntitySnapshotPayload({
        id: `agent-user-checkpoint:${state.stateHash}`,
        projectId: state.projectId,
        entityKind: state.entityKind,
        entityId: state.entityId,
        stateBlob: state.stateBlob,
        contentJson: null,
        metaJson: state.metadataJson,
        createdAt: new Date().toISOString(),
      });
    },
  };
}

export const __agentUserCheckpointWorkspaceTest = {
  sha256Bytes,
  sha256Text,
};
