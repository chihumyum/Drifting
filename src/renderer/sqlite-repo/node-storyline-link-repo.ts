import { getDb, type DbExecutor } from '../lib/db';
import { BookNodeTable, NodeStorylineLinkTable, StorylineTable } from '../schema/drizzle';
import { eq, asc, and, inArray } from 'drizzle-orm';
import type { Storyline } from '../domain/storyline';

export interface NodeStorylineLinkRepository {
  addNodeToStoryline(
    nodeId: string,
    storylineId: string,
    options?: { isPrimary?: boolean },
  ): Promise<void>;
  removeNodeFromStoryline(nodeId: string, storylineId: string): Promise<void>;
  getStorylinesByNode(nodeId: string): Promise<Storyline[]>;
  getStorylinesByNodeIds(nodeIds: string[]): Promise<Record<string, Storyline[]>>;
  getNodeIdsByStoryline(storylineId: string): Promise<string[]>;
  setNodeStorylines(
    nodeId: string,
    storylineIds: string[],
    options?: { primaryStorylineId?: string | null },
  ): Promise<void>;
  // Make `storylineId` the primary for `nodeId`. If `storylineId` is null,
  // demote any current primary (no replacement). The link row for the new
  // primary is created if missing. Atomically demotes the previous primary,
  // so the partial unique index never sees two true rows.
  setPrimaryStoryline(nodeId: string, storylineId: string | null): Promise<void>;
}

function toStoryline(record: typeof StorylineTable.$inferSelect): Storyline {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    color: record.color,
    summary: record.summary,
    orderKey: record.orderKey,
    contentJson: record.contentJson,
    kvJson: record.kvJson ?? '[]',
    nodeContentTemplateJson: record.nodeContentTemplateJson ?? '{}',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createNodeStorylineLinkRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): NodeStorylineLinkRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const ensureStorylineInProject = async (storylineId: string): Promise<void> => {
    const rows = await dbProvider()
      .select({ id: StorylineTable.id })
      .from(StorylineTable)
      .where(and(eq(StorylineTable.projectId, projectId), eq(StorylineTable.id, storylineId)))
      .limit(1);
    if (!rows[0]) {
      throw new Error(`Storyline ${storylineId} not found in project ${projectId}`);
    }
  };

  const ensureNodeInProject = async (nodeId: string): Promise<void> => {
    const rows = await dbProvider()
      .select({ id: BookNodeTable.id })
      .from(BookNodeTable)
      .where(and(eq(BookNodeTable.projectId, projectId), eq(BookNodeTable.id, nodeId)))
      .limit(1);
    if (!rows[0]) {
      throw new Error(`Node ${nodeId} not found in project ${projectId}`);
    }
  };

  // Invariant: a node that belongs to ≥1 storyline always has exactly one
  // primary. If a mutation leaves it with memberships but no primary, promote
  // the membership whose storyline has the lowest orderKey (deterministic
  // tiebreak by id). This is the structural backstop that keeps a chapter from
  // ever being "member but no primary" — a state that renders grouped under a
  // lane with no color stripe and simultaneously lingers in the 未归属 bucket.
  // Must run inside the same transaction as the mutation that could violate it.
  const ensurePrimaryInvariant = async (tx: DbExecutor, nodeId: string): Promise<void> => {
    const primaryRows = await tx
      .select({ storylineId: NodeStorylineLinkTable.storylineId })
      .from(NodeStorylineLinkTable)
      .where(
        and(
          eq(NodeStorylineLinkTable.nodeId, nodeId),
          eq(NodeStorylineLinkTable.isPrimary, true),
        ),
      )
      .limit(1);
    if (primaryRows[0]) return; // already has a primary
    const candidate = await tx
      .select({ storylineId: NodeStorylineLinkTable.storylineId })
      .from(NodeStorylineLinkTable)
      .innerJoin(StorylineTable, eq(StorylineTable.id, NodeStorylineLinkTable.storylineId))
      .where(eq(NodeStorylineLinkTable.nodeId, nodeId))
      .orderBy(asc(StorylineTable.orderKey), asc(StorylineTable.id))
      .limit(1);
    if (!candidate[0]) return; // no memberships → legitimately no primary (未归属)
    await tx
      .update(NodeStorylineLinkTable)
      .set({ isPrimary: true })
      .where(
        and(
          eq(NodeStorylineLinkTable.nodeId, nodeId),
          eq(NodeStorylineLinkTable.storylineId, candidate[0].storylineId),
        ),
      );
  };

  const addNodeToStoryline = async (
    nodeId: string,
    storylineId: string,
    options?: { isPrimary?: boolean },
  ): Promise<void> => {
    await Promise.all([ensureStorylineInProject(storylineId), ensureNodeInProject(nodeId)]);

    const isPrimary = options?.isPrimary ?? false;

    await dbProvider().transaction(async (tx) => {
      if (isPrimary) {
        // Demote any existing primary on this node before inserting the new
        // one — preserves the partial unique index invariant.
        await tx
          .update(NodeStorylineLinkTable)
          .set({ isPrimary: false })
          .where(
            and(
              eq(NodeStorylineLinkTable.nodeId, nodeId),
              eq(NodeStorylineLinkTable.isPrimary, true),
            ),
          );
        // Upsert: promote to primary on conflict. The `set` clause is the
        // only-upward flip (false → true); demote-without-replacement goes
        // through setPrimaryStoryline instead.
        await tx
          .insert(NodeStorylineLinkTable)
          .values({ nodeId, storylineId, isPrimary: true })
          .onConflictDoUpdate({
            target: [NodeStorylineLinkTable.nodeId, NodeStorylineLinkTable.storylineId],
            set: { isPrimary: true },
          });
      } else {
        // Non-primary add: if the row already exists (with whatever isPrimary
        // value), leave it alone. Drizzle rejects `onConflictDoUpdate({ set: {} })`
        // as "No values to set", so we use `onConflictDoNothing` here.
        await tx
          .insert(NodeStorylineLinkTable)
          .values({ nodeId, storylineId, isPrimary: false })
          .onConflictDoNothing();
      }
      // A non-primary add onto a node that has no primary yet promotes this new
      // membership; no-op when a primary already exists.
      await ensurePrimaryInvariant(tx, nodeId);
    });
  };

  const setPrimaryStoryline = async (
    nodeId: string,
    storylineId: string | null,
  ): Promise<void> => {
    await ensureNodeInProject(nodeId);
    if (storylineId != null) await ensureStorylineInProject(storylineId);

    await dbProvider().transaction(async (tx) => {
      // Always demote the current primary first.
      await tx
        .update(NodeStorylineLinkTable)
        .set({ isPrimary: false })
        .where(
          and(
            eq(NodeStorylineLinkTable.nodeId, nodeId),
            eq(NodeStorylineLinkTable.isPrimary, true),
          ),
        );
      if (storylineId == null) return;
      // Promote the new primary, creating the link row if necessary.
      await tx
        .insert(NodeStorylineLinkTable)
        .values({ nodeId, storylineId, isPrimary: true })
        .onConflictDoUpdate({
          target: [NodeStorylineLinkTable.nodeId, NodeStorylineLinkTable.storylineId],
          set: { isPrimary: true },
        });
    });
  };

  const removeNodeFromStoryline = async (nodeId: string, storylineId: string): Promise<void> => {
    await dbProvider().transaction(async (tx) => {
      await tx
        .delete(NodeStorylineLinkTable)
        .where(
          and(
            eq(NodeStorylineLinkTable.nodeId, nodeId),
            eq(NodeStorylineLinkTable.storylineId, storylineId),
          ),
        );
      // Removing a secondary membership is a no-op for the invariant; removing
      // the primary while other memberships remain re-promotes the next one.
      await ensurePrimaryInvariant(tx, nodeId);
    });
  };

  const getStorylinesByNode = async (nodeId: string): Promise<Storyline[]> => {
    const rows = await dbProvider()
      .select({
        storyline: StorylineTable,
      })
      .from(StorylineTable)
      .innerJoin(NodeStorylineLinkTable, eq(StorylineTable.id, NodeStorylineLinkTable.storylineId))
      .where(
        and(eq(NodeStorylineLinkTable.nodeId, nodeId), eq(StorylineTable.projectId, projectId)),
      )
      .orderBy(asc(StorylineTable.orderKey));

    return rows.map((r) => toStoryline(r.storyline));
  };

  const getStorylinesByNodeIds = async (
    nodeIds: string[],
  ): Promise<Record<string, Storyline[]>> => {
    if (nodeIds.length === 0) return {};

    const rows = await dbProvider()
      .select({
        nodeId: NodeStorylineLinkTable.nodeId,
        storyline: StorylineTable,
      })
      .from(NodeStorylineLinkTable)
      .innerJoin(StorylineTable, eq(StorylineTable.id, NodeStorylineLinkTable.storylineId))
      .where(
        and(
          inArray(NodeStorylineLinkTable.nodeId, nodeIds),
          eq(StorylineTable.projectId, projectId),
        ),
      )
      .orderBy(asc(StorylineTable.orderKey));

    const grouped: Record<string, Storyline[]> = {};
    nodeIds.forEach((nodeId) => {
      grouped[nodeId] = [];
    });

    rows.forEach((row) => {
      grouped[row.nodeId].push(toStoryline(row.storyline));
    });

    return grouped;
  };

  const getNodeIdsByStoryline = async (storylineId: string): Promise<string[]> => {
    await ensureStorylineInProject(storylineId);

    const rows = await dbProvider()
      .select({ nodeId: NodeStorylineLinkTable.nodeId })
      .from(NodeStorylineLinkTable)
      .where(eq(NodeStorylineLinkTable.storylineId, storylineId));

    return rows.map((r) => r.nodeId);
  };

  const setNodeStorylines = async (
    nodeId: string,
    storylineIds: string[],
    options?: { primaryStorylineId?: string | null },
  ): Promise<void> => {
    await ensureNodeInProject(nodeId);

    if (storylineIds.length > 0) {
      const rows = await dbProvider()
        .select({ id: StorylineTable.id })
        .from(StorylineTable)
        .where(
          and(eq(StorylineTable.projectId, projectId), inArray(StorylineTable.id, storylineIds)),
        );
      if (rows.length !== storylineIds.length) {
        throw new Error('One or more storylines do not belong to the active project.');
      }
    }

    const primaryStorylineId = options?.primaryStorylineId ?? null;
    if (primaryStorylineId != null && !storylineIds.includes(primaryStorylineId)) {
      throw new Error('primaryStorylineId must be one of the supplied storylineIds.');
    }

    await dbProvider().transaction(async (tx) => {
      await tx.delete(NodeStorylineLinkTable).where(eq(NodeStorylineLinkTable.nodeId, nodeId));

      if (storylineIds.length > 0) {
        await tx.insert(NodeStorylineLinkTable).values(
          storylineIds.map((sid) => ({
            nodeId,
            storylineId: sid,
            isPrimary: sid === primaryStorylineId,
          })),
        );
      }
      // Non-empty membership with no primary named (primaryStorylineId null)
      // gets a deterministic primary so the node is never grouped-but-colorless.
      await ensurePrimaryInvariant(tx, nodeId);
    });
  };

  return {
    addNodeToStoryline,
    removeNodeFromStoryline,
    getStorylinesByNode,
    getStorylinesByNodeIds,
    getNodeIdsByStoryline,
    setNodeStorylines,
    setPrimaryStoryline,
  };
}
