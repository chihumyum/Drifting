import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AGENT_WORKING_MEMORY_FILENAME,
  AgentWorkingMemoryConflictError,
  type AgentWorkingMemory,
  type AgentWorkingMemorySnapshot,
  type AgentWorkingMemoryUpdatedBy,
} from '../domain/agent-working-memory';
import {
  decideAgentWorkingMemoryNotice,
  measureAgentWorkingMemoryMarkdown,
} from '../lib/agent/runtime/working-memory-document';
import { createAgentWorkingMemoryRepository } from '../sqlite-repo/agent-working-memory-repo';
import type { DbClient, DbExecutor } from '../lib/db';
import { runDerivedTransaction } from '../sync/journal';

export const AGENT_WORKING_MEMORY_CHANGED_EVENT = 'drifting:agent-working-memory-changed';

function notifyWorkingMemoryChanged(projectId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(AGENT_WORKING_MEMORY_CHANGED_EVENT, { detail: { projectId } }),
  );
}

function toSnapshot(projectId: string, row: AgentWorkingMemory | null): AgentWorkingMemorySnapshot {
  const exists = Boolean(row && !row.deletedAt && row.contentMd.trim());
  return {
    projectId,
    filename: AGENT_WORKING_MEMORY_FILENAME,
    exists,
    contentMd: exists ? row!.contentMd : '',
    revision: row?.revision ?? 0,
    approxTokens: exists ? row!.approxTokens : 0,
    updatedBy: row?.updatedBy ?? null,
    lastCompactedAt: row?.lastCompactedAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function loadAgentWorkingMemory(
  projectId: string,
  database?: DbExecutor,
): Promise<AgentWorkingMemorySnapshot> {
  const row = await createAgentWorkingMemoryRepository(projectId, database).find();
  return toSnapshot(projectId, row);
}

export interface SaveAgentWorkingMemoryInput {
  contentMd: string;
  expectedRevision: number;
  updatedBy: AgentWorkingMemoryUpdatedBy;
}

export interface SaveAgentWorkingMemoryResult {
  snapshot: AgentWorkingMemorySnapshot;
}

async function persistAgentWorkingMemory(
  projectId: string,
  input: SaveAgentWorkingMemoryInput,
  tx: DbExecutor,
): Promise<{ row: AgentWorkingMemory }> {
  const measured = measureAgentWorkingMemoryMarkdown(input.contentMd);
  const now = new Date().toISOString();
  const repo = createAgentWorkingMemoryRepository(projectId, tx);
  const current = await repo.find();
  const currentRevision = current?.revision ?? 0;
  if (currentRevision !== input.expectedRevision) {
    throw new AgentWorkingMemoryConflictError(input.expectedRevision, currentRevision);
  }
  const revision = currentRevision + 1;
  const next: AgentWorkingMemory = {
    projectId,
    contentMd: measured.contentMd,
    revision,
    approxTokens: measured.approxTokens,
    updatedBy: input.updatedBy,
    lastCompactedAt: current?.lastCompactedAt ?? null,
    deletedAt: null,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  const saved = current
    ? await repo.updateCas(currentRevision, {
        contentMd: next.contentMd,
        revision: next.revision,
        approxTokens: next.approxTokens,
        updatedBy: next.updatedBy,
        lastCompactedAt: next.lastCompactedAt,
        deletedAt: null,
        updatedAt: next.updatedAt,
      })
    : await repo.create(next);
  if (!saved) {
    const actual = (await repo.find())?.revision ?? 0;
    throw new AgentWorkingMemoryConflictError(input.expectedRevision, actual);
  }
  return { row: saved };
}

export async function saveAgentWorkingMemory(
  projectId: string,
  input: SaveAgentWorkingMemoryInput,
): Promise<SaveAgentWorkingMemoryResult> {
  const result = await runDerivedTransaction('agent.working-memory', (tx) =>
    persistAgentWorkingMemory(projectId, input, tx),
  );
  notifyWorkingMemoryChanged(projectId);
  return { snapshot: toSnapshot(projectId, result.row) };
}

/** Isolated runtime/eval entrypoint bound to an explicitly injected product DB. */
export async function saveAgentWorkingMemoryInDatabase(
  projectId: string,
  input: SaveAgentWorkingMemoryInput,
  database: DbClient,
): Promise<SaveAgentWorkingMemoryResult> {
  const result = await database.transaction((tx) =>
    persistAgentWorkingMemory(projectId, input, tx),
  );
  return { snapshot: toSnapshot(projectId, result.row) };
}

export async function clearAgentWorkingMemory(
  projectId: string,
  expectedRevision: number,
  updatedBy: AgentWorkingMemoryUpdatedBy = 'author',
): Promise<AgentWorkingMemorySnapshot> {
  const now = new Date().toISOString();
  const row = await runDerivedTransaction('agent.working-memory-clear', async (tx) => {
    const repo = createAgentWorkingMemoryRepository(projectId, tx);
    const current = await repo.find();
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== expectedRevision) {
      throw new AgentWorkingMemoryConflictError(expectedRevision, currentRevision);
    }
    if (!current) return null;
    const cleared = await repo.updateCas(currentRevision, {
      contentMd: '',
      revision: currentRevision + 1,
      approxTokens: 0,
      updatedBy,
      lastCompactedAt: current.lastCompactedAt,
      deletedAt: now,
      updatedAt: now,
    });
    if (!cleared) {
      const actual = (await repo.find())?.revision ?? 0;
      throw new AgentWorkingMemoryConflictError(expectedRevision, actual);
    }
    return cleared;
  });
  notifyWorkingMemoryChanged(projectId);
  return toSnapshot(projectId, row);
}

const NOTICE_TIER_KEY = (projectId: string) => `drifting:working-memory-notice-tier:${projectId}`;

/**
 * Whether this writable turn should ask the Agent to consolidate Working
 * Memory. The tier already announced is device-local, like the document.
 */
export function takeWorkingMemoryConsolidationNotice(
  projectId: string,
  approxTokens: number,
): boolean {
  let notifiedTier = 0;
  try {
    notifiedTier = Number(localStorage.getItem(NOTICE_TIER_KEY(projectId)) ?? 0) || 0;
  } catch {
    notifiedTier = 0;
  }
  const decision = decideAgentWorkingMemoryNotice(approxTokens, notifiedTier);
  try {
    localStorage.setItem(NOTICE_TIER_KEY(projectId), String(decision.notifiedTier));
  } catch {
    // Without storage the notice simply repeats at the next turn.
  }
  return decision.notice;
}

/** The current document for a new Agent turn. Never rewritten here. */
export async function prepareAgentWorkingMemoryForTurn(
  projectId: string,
): Promise<AgentWorkingMemorySnapshot> {
  return loadAgentWorkingMemory(projectId);
}

export function useAgentWorkingMemory(projectId: string) {
  const [snapshot, setSnapshot] = useState<AgentWorkingMemorySnapshot | null>(null);
  const [loading, setLoading] = useState(Boolean(projectId));

  const refresh = useCallback(async () => {
    if (!projectId) {
      setSnapshot(null);
      setLoading(false);
      return null;
    }
    setLoading(true);
    try {
      const next = await loadAgentWorkingMemory(projectId);
      setSnapshot(next);
      return next;
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    if (!projectId) return;
    loadAgentWorkingMemory(projectId)
      .then((next) => {
        if (alive) setSnapshot(next);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (detail?.projectId === projectId) void refresh();
    };
    window.addEventListener(AGENT_WORKING_MEMORY_CHANGED_EVENT, onChanged);
    return () => {
      alive = false;
      window.removeEventListener(AGENT_WORKING_MEMORY_CHANGED_EVENT, onChanged);
    };
  }, [projectId, refresh]);

  return useMemo(() => ({ snapshot, loading, refresh }), [snapshot, loading, refresh]);
}
