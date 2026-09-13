/**
 * Local SQLite repo for Agent conversations (right-sidebar chat history).
 *
 * Display projection and local execution pointers. SQL triggers queue authored
 * changes for the independent Agent chat protocol; canonical history is exported
 * by the application sync supervisor. Soft-delete uses durable branch tombstones.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { events } from '../lib/events';
import { getDb } from '../lib/db';
import { AgentChatBranchTable, AgentConversationTable } from '../schema/drizzle';
import type {
  AgentChatMessage,
  AgentConversation,
  AgentConversationSummary,
  AgentConvMode,
} from '../domain/agent-conversation';

function parseMessages(json: string | null | undefined): AgentChatMessage[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as AgentChatMessage[]) : [];
  } catch {
    return [];
  }
}

function coerceMode(mode: string): AgentConvMode {
  return mode === 'hosted' ? 'hosted' : 'byok';
}

function recordToDomain(record: typeof AgentConversationTable.$inferSelect): AgentConversation {
  return {
    id: record.id,
    projectId: record.projectId,
    title: record.title,
    sdkSessionId: record.sdkSessionId ?? null,
    runtimeSessionId: record.runtimeSessionId ?? null,
    mode: coerceMode(record.mode),
    messages: parseMessages(record.messagesJson),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export interface CreateAgentConversationInput {
  id: string;
  projectId: string;
  title: string;
  mode: AgentConvMode;
  messages: AgentChatMessage[];
  sdkSessionId?: string | null;
  runtimeSessionId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateAgentConversationInput {
  title?: string;
  mode?: AgentConvMode;
  messages?: AgentChatMessage[];
  sdkSessionId?: string | null;
  runtimeSessionId?: string | null;
  updatedAt?: string;
}

/** Per-conversation token/cost totals, summed from its transcript usage rows. */
export interface AgentConversationUsage {
  id: string;
  title: string;
  updatedAt: string;
  /** Soft-delete marker — null while live. Deleted rows still count toward usage
   *  totals (the spend happened) but drop out of the manageable history list. */
  deletedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
}

export interface AgentConversationRemovalReceipt { id: string; projectId: string; deletedAt: string }

export interface AgentConversationRepository {
  listByProject(projectId: string): Promise<AgentConversationSummary[]>;
  get(id: string): Promise<AgentConversation | null>;
  create(input: CreateAgentConversationInput): Promise<void>;
  update(id: string, patch: UpdateAgentConversationInput): Promise<void>;
  softDelete(id: string, deletedAt: string): Promise<AgentConversationRemovalReceipt[]>;
  /** Soft-delete every live conversation in a project (one UPDATE). */
  softDeleteAllByProject(projectId: string, deletedAt: string): Promise<AgentConversationRemovalReceipt[]>;
  /**
   * Per-conversation token/cost usage for a project (most-recent first).
   * `opts.since` (ISO) scopes the sum to usage entries stamped at/after it — e.g.
   * the start of the month; omit for all-time. Every conversation is still
   * returned (usage 0 when none in-window) so the row stays manageable.
   */
  usageByProject(
    projectId: string,
    opts?: { since?: string },
  ): Promise<AgentConversationUsage[]>;
}

async function wakeConversationSync(id: string): Promise<void> {
  const [row] = await getDb().select({ projectId: AgentConversationTable.projectId }).from(AgentConversationTable).where(eq(AgentConversationTable.id, id));
  if (row) events.emit('agent:conversation-committed', { projectId: row.projectId });
}

export function createAgentConversationRepository(): AgentConversationRepository {
  return {
    async listByProject(projectId) {
      const rows = await getDb()
        .select({
          id: AgentConversationTable.id,
          title: AgentConversationTable.title,
          mode: AgentConversationTable.mode,
          updatedAt: AgentConversationTable.updatedAt,
        })
        .from(AgentConversationTable)
        .where(
          and(
            eq(AgentConversationTable.projectId, projectId),
            isNull(AgentConversationTable.deletedAt),
          ),
        )
        .orderBy(desc(AgentConversationTable.updatedAt));
      const branches = await getDb().select().from(AgentChatBranchTable).where(eq(AgentChatBranchTable.projectId, projectId));
      const hidden = new Set(branches.filter((branch) => {
        const children = branches.filter((child) => child.parentBranchId === branch.id && !child.deletedAt);
        return children.length === 1 && children[0].readiness === 'ready' && branch.headTurnId !== null && children[0].forkTurnId === branch.headTurnId;
      }).map((branch) => branch.id));
      const visible = rows.filter((row) => !hidden.has(row.id));
      return visible.map((r) => ({
        ...(branches.some((branch) => branch.id === r.id) ? { syncState: branches.find((branch) => branch.id === r.id)!.readiness as import('../domain/agent-conversation').AgentConversationSyncState } : {}),
        ...(visible.filter((row) => row.title === r.title).length > 1 ? { branchLabel: r.id.slice(-6) } : {}),
        id: r.id,
        title: r.title,
        mode: coerceMode(r.mode),
        updatedAt: r.updatedAt,
      }));
    },

    async usageByProject(projectId, opts) {
      const since = opts?.since;
      // Includes soft-deleted conversations on purpose: the tokens/cost were
      // really spent, so usage totals must survive a deleted chat. Callers split
      // live vs deleted via the returned `deletedAt`.
      const rows = await getDb()
        .select({
          id: AgentConversationTable.id,
          title: AgentConversationTable.title,
          updatedAt: AgentConversationTable.updatedAt,
          deletedAt: AgentConversationTable.deletedAt,
          messagesJson: AgentConversationTable.messagesJson,
        })
        .from(AgentConversationTable)
        .where(eq(AgentConversationTable.projectId, projectId))
        .orderBy(desc(AgentConversationTable.updatedAt));
      return rows.map((r) => {
        let inputTokens = 0;
        let outputTokens = 0;
        let costUsd = 0;
        let turns = 0;
        for (const m of parseMessages(r.messagesJson)) {
          if (m.kind !== 'usage') continue;
          // Time-scoped window: count only entries stamped at/after `since`.
          // Entries written before `at` existed are undated, so they fall
          // outside any bounded window (they still count for all-time).
          if (since && !(m.at && m.at >= since)) continue;
          inputTokens += m.inputTokens + m.cacheReadTokens + m.cacheCreationTokens;
          outputTokens += m.outputTokens;
          costUsd += m.costUsd;
          turns += m.turns;
        }
        return {
          id: r.id,
          title: r.title,
          updatedAt: r.updatedAt,
          deletedAt: r.deletedAt ?? null,
          inputTokens,
          outputTokens,
          costUsd,
          turns,
        };
      });
    },

    async get(id) {
      const rows = await getDb()
        .select()
        .from(AgentConversationTable)
        .where(and(eq(AgentConversationTable.id, id), isNull(AgentConversationTable.deletedAt)))
        .limit(1);
      return rows[0] ? recordToDomain(rows[0]) : null;
    },

    async create(input) {
      const row: typeof AgentConversationTable.$inferInsert = {
        id: input.id,
        projectId: input.projectId,
        title: input.title,
        mode: input.mode,
        messagesJson: JSON.stringify(input.messages),
        sdkSessionId: input.sdkSessionId ?? null,
        runtimeSessionId: input.runtimeSessionId ?? null,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      };
      await getDb().insert(AgentConversationTable).values(row);
      events.emit('agent:conversation-committed', { projectId: input.projectId });
    },

    async update(id, patch) {
      const set: Partial<typeof AgentConversationTable.$inferInsert> = {};
      if (patch.title !== undefined) set.title = patch.title;
      if (patch.mode !== undefined) set.mode = patch.mode;
      if (patch.messages !== undefined) set.messagesJson = JSON.stringify(patch.messages);
      if (patch.sdkSessionId !== undefined) set.sdkSessionId = patch.sdkSessionId;
      if (patch.runtimeSessionId !== undefined)
        set.runtimeSessionId = patch.runtimeSessionId;
      if (patch.updatedAt !== undefined) set.updatedAt = patch.updatedAt;
      await getDb()
        .update(AgentConversationTable)
        .set(set)
        .where(eq(AgentConversationTable.id, id));
      void wakeConversationSync(id).catch(() => {});
    },

    async softDelete(id, deletedAt) {
      const rows = await getDb()
        .update(AgentConversationTable)
        .set({ deletedAt, updatedAt: deletedAt })
        .where(eq(AgentConversationTable.id, id))
        .returning({ id: AgentConversationTable.id, projectId: AgentConversationTable.projectId });
      void wakeConversationSync(id).catch(() => {});
      return rows.map(row => ({ ...row, deletedAt }));
    },

    async softDeleteAllByProject(projectId, deletedAt) {
      const rows = await getDb()
        .update(AgentConversationTable)
        .set({ deletedAt, updatedAt: deletedAt })
        .where(
          and(
            eq(AgentConversationTable.projectId, projectId),
            isNull(AgentConversationTable.deletedAt),
          ),
        )
        .returning({ id: AgentConversationTable.id, projectId: AgentConversationTable.projectId });
      events.emit('agent:conversation-committed', { projectId });
      return rows.map(row => ({ ...row, deletedAt }));
    },
  };
}
