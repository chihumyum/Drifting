import { and, asc, eq, isNull } from 'drizzle-orm';

import type {
  AgentRuntimeStorylineMembershipLinkSnapshot,
  AgentRuntimeStorylineMembershipSnapshotValue,
} from '../../../domain/agent-runtime-entity-write-receipt';
import type { AgentMemory } from '../../../domain/agent-memory';
import type { DbExecutor } from '../../../lib/db';
import {
  BookNodeTable,
  NodeStorylineLinkTable,
  StorylineTable,
} from '../../../schema/drizzle';
import { hashEntityWriteValue } from './entity-write-revision';

function sortMembershipLinks(
  links: readonly AgentRuntimeStorylineMembershipLinkSnapshot[],
): AgentRuntimeStorylineMembershipLinkSnapshot[] {
  return links
    .map((link) => ({ ...link }))
    .sort(
      (left, right) =>
        left.nodeId.localeCompare(right.nodeId, 'en') ||
        left.storylineId.localeCompare(right.storylineId, 'en') ||
        Number(right.isPrimary) - Number(left.isPrimary),
    );
}

export async function storylineMembershipRevision(
  links: readonly AgentRuntimeStorylineMembershipLinkSnapshot[],
): Promise<string> {
  return hashEntityWriteValue({
    kind: 'storyline_membership_graph',
    links: sortMembershipLinks(links),
  });
}

/**
 * Load the complete active chapter/storyline membership graph through the
 * supplied executor. Both observation and guarded mutation call this exact
 * function, which keeps the read hash and transactional CAS in lockstep.
 */
export async function loadStorylineMembershipSnapshot(
  db: DbExecutor,
  projectId: string,
  authoredStorylineId: string,
): Promise<AgentRuntimeStorylineMembershipSnapshotValue> {
  const storyline = await db
    .select({ id: StorylineTable.id })
    .from(StorylineTable)
    .where(
      and(
        eq(StorylineTable.id, authoredStorylineId),
        eq(StorylineTable.projectId, projectId),
        isNull(StorylineTable.deletedAt),
      ),
    )
    .limit(1);
  if (!storyline[0]) {
    throw new Error('The storyline membership target no longer exists');
  }

  const rows = await db
    .select({
      nodeId: NodeStorylineLinkTable.nodeId,
      storylineId: NodeStorylineLinkTable.storylineId,
      isPrimary: NodeStorylineLinkTable.isPrimary,
    })
    .from(NodeStorylineLinkTable)
    .innerJoin(
      BookNodeTable,
      eq(BookNodeTable.id, NodeStorylineLinkTable.nodeId),
    )
    .innerJoin(
      StorylineTable,
      eq(StorylineTable.id, NodeStorylineLinkTable.storylineId),
    )
    .where(
      and(
        eq(BookNodeTable.projectId, projectId),
        eq(BookNodeTable.kind, 'chapter'),
        isNull(BookNodeTable.deletedAt),
        eq(StorylineTable.projectId, projectId),
        isNull(StorylineTable.deletedAt),
      ),
    )
    .orderBy(
      asc(NodeStorylineLinkTable.nodeId),
      asc(NodeStorylineLinkTable.storylineId),
    );
  const links = sortMembershipLinks(
    rows.map((row) => ({
      nodeId: row.nodeId,
      storylineId: row.storylineId,
      isPrimary: row.isPrimary,
    })),
  );
  return {
    id: authoredStorylineId,
    projectId,
    links,
    updatedAt: await storylineMembershipRevision(links),
  };
}

function memoryRevisionValue(memory: AgentMemory) {
  return {
    id: memory.id,
    projectId: memory.projectId,
    kind: memory.kind,
    body: memory.body,
    targetKind: memory.targetKind,
    targetId: memory.targetId,
    targetBlockId: memory.targetBlockId,
    source: memory.source,
    originRef: memory.originRef,
    status: memory.status,
    supersedesId: memory.supersedesId,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    deletedAt: memory.deletedAt,
  };
}

/** Hash every row, including dismissed/soft-deleted provenance rows. */
export async function agentMemorySetRevision(
  memories: readonly AgentMemory[],
): Promise<string> {
  return hashEntityWriteValue({
    kind: 'agent_memory_set',
    memories: memories
      .map(memoryRevisionValue)
      .sort((left, right) => left.id.localeCompare(right.id, 'en')),
  });
}
