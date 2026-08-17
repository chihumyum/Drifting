import type { BookNode } from '../domain/book-node';
import { isChapter } from '../domain/book-node';
import { createBookNodeSqliteRepository } from '../sqlite-repo/node-repo';
import { createNodeStorylineLinkRepository } from '../sqlite-repo/node-storyline-link-repo';
import { appendAuthoredNodeStorylineProjectionInTransaction } from '../sync/journal/storyline-membership';
import { withAtomicSyncTransaction } from './sync-helpers';

export interface MoveChapterOnTimelineInput {
  orderField: 'bookOrder' | 'narrativeOrder';
  order: number;
  /**
   * undefined keeps storyline membership unchanged (the synthetic default
   * lane), null clears every membership (the unaffiliated lane), and a
   * storyline id makes that storyline primary while preserving secondary
   * memberships.
   */
  targetStorylineId?: string | null;
}

export interface ChapterTimelineMembership {
  membershipIds: string[];
  primaryStorylineId: string | null;
}

export function resolveChapterTimelineMembership(
  current: ChapterTimelineMembership,
  targetStorylineId: string | null | undefined,
): ChapterTimelineMembership {
  if (targetStorylineId === undefined) {
    return {
      membershipIds: [...new Set(current.membershipIds)],
      primaryStorylineId: current.primaryStorylineId,
    };
  }
  if (targetStorylineId === null) {
    return { membershipIds: [], primaryStorylineId: null };
  }
  const membershipIds = current.membershipIds.filter(
    (storylineId) => storylineId !== current.primaryStorylineId,
  );
  if (!membershipIds.includes(targetStorylineId)) membershipIds.push(targetStorylineId);
  return {
    membershipIds: [...new Set(membershipIds)],
    primaryStorylineId: targetStorylineId,
  };
}

export interface PersistChapterTimelineMoveInput extends MoveChapterOnTimelineInput {
  projectId: string;
  nodeId: string;
  updatedAt: string;
}

export interface PersistedChapterTimelineMove {
  node: BookNode;
  membership: ChapterTimelineMembership;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

/**
 * The only persistence command for a chapter timeline drop. Coordinate,
 * membership and primary-storyline projection share one authored transaction,
 * so a renderer can never observe a half-rerouted chapter after restart.
 */
export async function persistChapterTimelineMove(
  input: PersistChapterTimelineMoveInput,
): Promise<PersistedChapterTimelineMove> {
  if (!Number.isFinite(input.order)) {
    throw new TypeError('chapter timeline position must be finite');
  }
  return withAtomicSyncTransaction(input.projectId, async (tx, sync, changes) => {
    const nodeRepo = createBookNodeSqliteRepository(input.projectId, tx);
    const linkRepo = createNodeStorylineLinkRepository(input.projectId, tx);
    const existing = await nodeRepo.findById(input.nodeId);
    if (!existing) {
      throw new Error(`Book node ${input.nodeId} no longer exists in project ${input.projectId}.`);
    }
    if (!isChapter(existing)) {
      throw new Error('Only chapters may be moved on the chapter timeline.');
    }

    const links = await linkRepo.getStorylineLinksByNodeIds([input.nodeId]);
    const current: ChapterTimelineMembership = {
      membershipIds: links.map((link) => link.storylineId),
      primaryStorylineId: links.find((link) => link.isPrimary)?.storylineId ?? null,
    };
    const membership = resolveChapterTimelineMembership(current, input.targetStorylineId);
    const membershipChanged =
      current.primaryStorylineId !== membership.primaryStorylineId ||
      !sameMembers(current.membershipIds, membership.membershipIds);

    const node = await nodeRepo.update(input.nodeId, {
      [input.orderField]: input.order,
      updatedAt: input.updatedAt,
    });
    if (!node) {
      throw new Error(`Book node ${input.nodeId} no longer exists in project ${input.projectId}.`);
    }
    if (membershipChanged) {
      await linkRepo.setNodeStorylines(input.nodeId, membership.membershipIds, {
        primaryStorylineId: membership.primaryStorylineId,
      });
      await appendAuthoredNodeStorylineProjectionInTransaction(tx, changes, {
        projectId: input.projectId,
        nodeId: input.nodeId,
      });
    }
    await sync('node', 'update', input.nodeId, input.projectId, {
      [input.orderField]: input.order,
    });
    return { node, membership };
  });
}
