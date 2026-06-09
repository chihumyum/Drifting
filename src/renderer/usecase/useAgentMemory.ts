/**
 * Agent memory usecases — the small, evolving store of author-level guidance
 * shared by the General agent and the Shadow review engine (see
 * domain/agent-memory.ts + sqlite-repo/agent-memory-repo.ts).
 *
 * Two surfaces:
 *  - Plain repo-backed helpers (createMemory / setMemoryStatus / …) used by the
 *    agent tool handlers (which run outside React) and by the injection path.
 *  - A thin `useAgentMemory` hook for the author-facing management list.
 *
 * Local-only for now: not wired to the sync outbox (the repo is pure-local; sync
 * lives in this layer for synced entities, and memory's outbox route isn't built
 * yet). Soft-approval is an inline confirm at write time (see the `remember`
 * handler) rather than a pending queue, so the agent path writes straight to
 * 'active'; the 'pending' status stays reserved for a future async flow.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { createAgentMemoryRepository } from '../sqlite-repo/agent-memory-repo';
import type {
  AgentMemory,
  AgentMemoryKind,
  AgentMemorySource,
  AgentMemoryStatus,
} from '../domain/agent-memory';
import type { StructuralEntityKind } from '../domain/entity-kinds';
import {
  syncAgentMemoryCreate,
  syncAgentMemoryUpdate,
} from './sync-helpers';

// The create payload pushed to the server (projectId is in the URL, not the body).
function memorySyncPayload(m: AgentMemory): Record<string, unknown> {
  return {
    id: m.id,
    kind: m.kind,
    body: m.body,
    targetKind: m.targetKind,
    targetId: m.targetId,
    targetBlockId: m.targetBlockId,
    source: m.source,
    originRef: m.originRef,
    status: m.status,
    supersedesId: m.supersedesId,
    deletedAt: m.deletedAt,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

export interface CreateAgentMemoryInput {
  kind: AgentMemoryKind;
  body: string;
  source?: AgentMemorySource;
  status?: AgentMemoryStatus;
  targetKind?: StructuralEntityKind | null;
  targetId?: string | null;
  targetBlockId?: string | null;
  originRef?: string | null;
  supersedesId?: string | null;
}

/** Create a memory row. Returns the persisted memory. */
export async function createMemory(
  projectId: string,
  input: CreateAgentMemoryInput,
): Promise<AgentMemory> {
  const repo = createAgentMemoryRepository(projectId);
  const now = new Date().toISOString();
  const created = await repo.create({
    id: uuidv7(),
    projectId,
    kind: input.kind,
    body: input.body,
    targetKind: input.targetKind ?? null,
    targetId: input.targetId ?? null,
    targetBlockId: input.targetBlockId ?? null,
    source: input.source ?? 'agent',
    originRef: input.originRef ?? null,
    status: input.status ?? 'pending',
    supersedesId: input.supersedesId ?? null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  syncAgentMemoryCreate(created.id, projectId, memorySyncPayload(created));
  return created;
}

/** Flip a memory's status (e.g. approve a pending → 'active', or 'dismissed'). */
export async function setMemoryStatus(
  projectId: string,
  id: string,
  status: AgentMemoryStatus,
): Promise<AgentMemory | null> {
  const repo = createAgentMemoryRepository(projectId);
  const updatedAt = new Date().toISOString();
  const row = await repo.update(id, { status, updatedAt });
  syncAgentMemoryUpdate(id, projectId, { status, updatedAt });
  return row;
}

/** Update a memory's body (and optionally retire the one it supersedes). */
export async function updateMemoryBody(
  projectId: string,
  id: string,
  body: string,
): Promise<AgentMemory | null> {
  const repo = createAgentMemoryRepository(projectId);
  const updatedAt = new Date().toISOString();
  const row = await repo.update(id, { body, updatedAt });
  syncAgentMemoryUpdate(id, projectId, { body, updatedAt });
  return row;
}

/** Soft-delete a memory (kept for provenance; drops out of all reads). The
 *  soft-delete travels to the server as an update carrying deletedAt. */
export async function softDeleteMemory(projectId: string, id: string): Promise<void> {
  const repo = createAgentMemoryRepository(projectId);
  const deletedAt = new Date().toISOString();
  await repo.softDelete(id, deletedAt);
  syncAgentMemoryUpdate(id, projectId, { deletedAt, updatedAt: deletedAt });
}

/** Live (not deleted) memories for the project, newest first. */
export async function listLiveMemories(projectId: string): Promise<AgentMemory[]> {
  return createAgentMemoryRepository(projectId).listLive();
}

/**
 * The ACTIVE memories that may be injected into an agent/judge prompt. This is
 * the single retrieval seam both consumers go through (General system prompt +
 * Shadow judge); when episodic/embedding retrieval lands it slots in here.
 */
export async function loadActiveMemories(projectId: string): Promise<AgentMemory[]> {
  return createAgentMemoryRepository(projectId).listByStatus('active');
}

/** Compact {kind, body} form passed across IPC into the agent's system prompt. */
export async function loadActiveMemoryHints(
  projectId: string,
): Promise<{ kind: AgentMemoryKind; body: string }[]> {
  const rows = await loadActiveMemories(projectId);
  return rows.map((m) => ({ kind: m.kind, body: m.body }));
}

/**
 * Author-facing management hook for the memory list (view / approve / dismiss /
 * delete). Fetches on mount and exposes `refresh` for callers that just wrote.
 * Assumes the DB is already initialized (the agent panel only renders inside an
 * open project); a read before init simply yields an empty list.
 */
export function useAgentMemory(projectId: string) {
  const [memories, setMemories] = useState<AgentMemory[]>([]);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      setMemories(await listLiveMemories(projectId));
    } catch {
      setMemories([]);
    }
  }, [projectId]);

  // Mount fetch: setState only inside the resolve callback (external-state
  // subscription shape) + cleanup guard — clear of react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    listLiveMemories(projectId)
      .then((rows) => {
        if (alive) setMemories(rows);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [projectId]);

  const approve = useCallback(
    async (id: string) => {
      await setMemoryStatus(projectId, id, 'active');
      await refresh();
    },
    [projectId, refresh],
  );

  const dismiss = useCallback(
    async (id: string) => {
      await setMemoryStatus(projectId, id, 'dismissed');
      await refresh();
    },
    [projectId, refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await softDeleteMemory(projectId, id);
      await refresh();
    },
    [projectId, refresh],
  );

  return useMemo(
    () => ({ memories, refresh, approve, dismiss, remove }),
    [memories, refresh, approve, dismiss, remove],
  );
}
