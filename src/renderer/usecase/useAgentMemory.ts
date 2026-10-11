/**
 * Project Memory usecases — PROJECT_MEMORY.md, the author's thoughts,
 * intentions, habits and standing instructions for one project, consumed by
 * every General Agent conversation (see domain/agent-memory.ts +
 * sqlite-repo/agent-memory-repo.ts).
 *
 * Two surfaces:
 *  - Plain repo-backed helpers (createMemory / updateMemoryBody / …) used by the
 *    agent tool handlers (which run outside React) and by the injection path.
 *  - A thin `useAgentMemory` hook for the author-facing editor.
 *
 * Writes use the same local-row + durable-outbox transaction as other synced
 * entities, one row per entry so edits on different devices merge per entry.
 * The author and the Agent edit the same entries; nothing waits for approval.
 * Rows still marked `pending` predate that and stay inactive until enabled.
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
import { withAtomicSyncTransaction } from './sync-helpers';

export const AGENT_MEMORY_CHANGED_EVENT = 'drifting:agent-memory-changed';

/** Tell mounted Project Memory views that this project's entries changed. */
export function notifyAgentMemoryChanged(projectId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(AGENT_MEMORY_CHANGED_EVENT, { detail: { projectId } }));
}

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
  const now = new Date().toISOString();
  const created = await withAtomicSyncTransaction(projectId, async (tx, sync) => {
    const row = await createAgentMemoryRepository(projectId, tx).create({
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
    await sync('agentMemory', 'create', row.id, projectId, memorySyncPayload(row));
    return row;
  });
  notifyAgentMemoryChanged(projectId);
  return created;
}

/** Flip a memory's status (e.g. approve a pending → 'active', or 'dismissed'). */
export async function setMemoryStatus(
  projectId: string,
  id: string,
  status: AgentMemoryStatus,
): Promise<AgentMemory | null> {
  const updatedAt = new Date().toISOString();
  const row = await withAtomicSyncTransaction(projectId, async (tx, sync) => {
    const updated = await createAgentMemoryRepository(projectId, tx).update(id, { status, updatedAt });
    if (updated) await sync('agentMemory', 'update', id, projectId, { status, updatedAt });
    return updated;
  });
  notifyAgentMemoryChanged(projectId);
  return row;
}

/**
 * Approve one pending Agent memory. If it supersedes an older memory, both the
 * activation and retirement are committed in the same SQLite/outbox
 * transaction. Replaying an already-approved decision is idempotent.
 */
export async function approvePendingMemory(
  projectId: string,
  id: string,
): Promise<AgentMemory> {
  const updatedAt = new Date().toISOString();
  const approved = await withAtomicSyncTransaction(projectId, async (tx, sync) => {
    const repo = createAgentMemoryRepository(projectId, tx);
    const candidate = await repo.findById(id);
    if (!candidate || candidate.deletedAt) {
      throw new Error('Pending Agent memory was not found in this project');
    }
    if (candidate.status === 'dismissed') {
      throw new Error('A dismissed Agent memory cannot be approved');
    }

    let active = candidate;
    if (candidate.status !== 'active') {
      const updated = await repo.update(id, {
        status: 'active',
        updatedAt,
      });
      if (!updated) throw new Error('Agent memory approval did not persist');
      active = updated;
      await sync('agentMemory', 'update', id, projectId, {
        status: 'active',
        updatedAt,
      });
    }

    const supersedesId = candidate.supersedesId;
    if (supersedesId && supersedesId !== id) {
      const superseded = await repo.findById(supersedesId);
      if (
        superseded &&
        !superseded.deletedAt &&
        superseded.status !== 'dismissed'
      ) {
        await repo.update(supersedesId, {
          status: 'dismissed',
          updatedAt,
        });
        await sync('agentMemory', 'update', supersedesId, projectId, {
          status: 'dismissed',
          updatedAt,
        });
      }
    }
    return active;
  });
  notifyAgentMemoryChanged(projectId);
  return approved;
}

/** Update a memory's body (and optionally retire the one it supersedes). */
export async function updateMemoryBody(
  projectId: string,
  id: string,
  body: string,
): Promise<AgentMemory | null> {
  const updatedAt = new Date().toISOString();
  const row = await withAtomicSyncTransaction(projectId, async (tx, sync) => {
    const updated = await createAgentMemoryRepository(projectId, tx).update(id, { body, updatedAt });
    if (updated) await sync('agentMemory', 'update', id, projectId, { body, updatedAt });
    return updated;
  });
  notifyAgentMemoryChanged(projectId);
  return row;
}

/** Soft-delete a memory (kept for provenance; drops out of all reads). The
 *  soft-delete travels to the server as an update carrying deletedAt. */
export async function softDeleteMemory(projectId: string, id: string): Promise<void> {
  const deletedAt = new Date().toISOString();
  await withAtomicSyncTransaction(projectId, async (tx, sync) => {
    await createAgentMemoryRepository(projectId, tx).softDelete(id, deletedAt);
    await sync('agentMemory', 'update', id, projectId, { deletedAt, updatedAt: deletedAt });
  });
  notifyAgentMemoryChanged(projectId);
}

/** Live (not deleted) memories for the project, newest first. */
export async function listLiveMemories(projectId: string): Promise<AgentMemory[]> {
  return createAgentMemoryRepository(projectId).listLive();
}

/**
 * The ACTIVE memories that may be injected into an Agent prompt. This is the
 * single retrieval seam; when episodic/embedding retrieval lands it slots in here.
 */
export async function loadActiveMemories(projectId: string): Promise<AgentMemory[]> {
  return createAgentMemoryRepository(projectId).listByStatus('active');
}

/** Compact PROJECT_MEMORY.md entries for the Agent system prompt, oldest
 *  first so unchanged memory keeps a stable prompt prefix. */
export async function loadActiveMemoryHints(
  projectId: string,
): Promise<{ id: string; kind: AgentMemoryKind; body: string }[]> {
  const rows = await loadActiveMemories(projectId);
  return [...rows]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((m) => ({ id: m.id, kind: m.kind, body: m.body }));
}

/**
 * Author-facing Project Memory hook: the live entries oldest first (document
 * order, matching the prompt), plus add / edit / enable / delete. It refreshes
 * when any writer in this window reports a change and when the window regains
 * focus, which also picks up entries that arrived through sync.
 * Assumes the DB is already initialized; a read before init yields no entries.
 */
export function useAgentMemory(projectId: string) {
  const [memories, setMemories] = useState<AgentMemory[]>([]);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      setMemories(sortMemoriesForDocument(await listLiveMemories(projectId)));
    } catch {
      setMemories([]);
    }
  }, [projectId]);

  // setState only inside resolve callbacks (external-state subscription shape)
  // with a cleanup guard — clear of react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    const load = () => {
      listLiveMemories(projectId)
        .then((rows) => {
          if (alive) setMemories(sortMemoriesForDocument(rows));
        })
        .catch(() => undefined);
    };
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (!detail?.projectId || detail.projectId === projectId) load();
    };
    load();
    window.addEventListener(AGENT_MEMORY_CHANGED_EVENT, onChanged);
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      window.removeEventListener(AGENT_MEMORY_CHANGED_EVENT, onChanged);
      window.removeEventListener('focus', load);
    };
  }, [projectId]);

  const add = useCallback(
    async (body: string) => {
      const trimmed = body.trim();
      if (!trimmed) return;
      await createMemory(projectId, {
        kind: 'preference',
        body: trimmed,
        source: 'author',
        status: 'active',
      });
    },
    [projectId],
  );

  const edit = useCallback(
    async (id: string, body: string) => {
      const trimmed = body.trim();
      if (!trimmed) return;
      await updateMemoryBody(projectId, id, trimmed);
    },
    [projectId],
  );

  const approve = useCallback(
    async (id: string) => {
      await approvePendingMemory(projectId, id);
    },
    [projectId],
  );

  const dismiss = useCallback(
    async (id: string) => {
      await setMemoryStatus(projectId, id, 'dismissed');
    },
    [projectId],
  );

  const remove = useCallback(
    async (id: string) => {
      await softDeleteMemory(projectId, id);
    },
    [projectId],
  );

  return useMemo(
    () => ({ memories, refresh, add, edit, approve, dismiss, remove }),
    [memories, refresh, add, edit, approve, dismiss, remove],
  );
}

/** Live, non-retired entries in PROJECT_MEMORY.md order (oldest first). */
export function sortMemoriesForDocument(rows: readonly AgentMemory[]): AgentMemory[] {
  return rows
    .filter((m) => m.status !== 'dismissed' && !m.deletedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
