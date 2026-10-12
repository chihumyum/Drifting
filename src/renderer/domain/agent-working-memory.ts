/**
 * Project-scoped rolling context shared by every General Agent conversation.
 *
 * This is deliberately one user-readable Markdown document, not a project
 * knowledge base or a typed history ledger. Long-lived preferences and rules
 * remain in `agent_memory`; authored story truth remains in Yjs/SQLite.
 */

export type AgentWorkingMemoryUpdatedBy = 'author' | 'agent';

export interface AgentWorkingMemory {
  projectId: string;
  contentMd: string;
  revision: number;
  approxTokens: number;
  updatedBy: AgentWorkingMemoryUpdatedBy;
  lastCompactedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentWorkingMemorySnapshot {
  projectId: string;
  filename: typeof AGENT_WORKING_MEMORY_FILENAME;
  exists: boolean;
  contentMd: string;
  revision: number;
  approxTokens: number;
  updatedBy: AgentWorkingMemoryUpdatedBy | null;
  lastCompactedAt: string | null;
  updatedAt: string | null;
}

export const AGENT_WORKING_MEMORY_FILENAME = 'WORKING_MEMORY.md' as const;

export const EMPTY_AGENT_WORKING_MEMORY_MD = `# Working Memory

## Current

## Recent
`;

/**
 * Working Memory has no size ceiling and nothing is deleted automatically.
 * Crossing each notice size prompts the Agent once to consolidate (lasting
 * items move to PROJECT_MEMORY.md, stale detail goes); above the persistent
 * size every turn carries that prompt.
 */
export const AGENT_WORKING_MEMORY_NOTICE_TOKENS = [20_000, 40_000] as const;
export const AGENT_WORKING_MEMORY_PERSISTENT_NOTICE_TOKENS = 80_000 as const;

export class AgentWorkingMemoryConflictError extends Error {
  readonly code = 'WORKING_MEMORY_REVISION_CONFLICT' as const;

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Working Memory revision changed from ${expectedRevision} to ${actualRevision}; read the current document before retrying.`,
    );
    this.name = 'AgentWorkingMemoryConflictError';
  }
}
