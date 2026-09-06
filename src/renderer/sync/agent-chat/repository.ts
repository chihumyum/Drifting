import { and, asc, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { getDb, type DbClient, type DbExecutor } from '../../lib/db';
import {
  AgentChatBindingTable as Bindings,
  AgentChatBranchTable as Branches,
  AgentChatObjectTable as Objects,
  AgentChatQueueTable as Queue,
  AgentChatDeliveryTable as Deliveries,
  AgentConversationTable as Conversations,
  AgentRuntimeResultArtifactTable as Artifacts,
} from '../../schema/drizzle';
import {
  createAgentRuntimePersistenceRepository,
  AgentRuntimePersistenceConflictError,
} from '../../sqlite-repo/agent-runtime-persistence-repo';
import {
  createAgentRuntimeResultArtifactRepository,
  AgentRuntimeResultArtifactError,
} from '../../sqlite-repo/agent-runtime-result-artifact-repo';
import { loadDurableAgentContextSummaries } from '../../lib/agent/runtime/durable-context-memory';
import {
  recoverAgentRuntimeSnapshot,
  AgentRuntimeRecoveryCorruptionError,
} from '../../lib/agent/runtime/recovery';
import {
  agentModelMessagesToContextSources,
  AgentContextMessageBridgeError,
} from '../../lib/agent/runtime/context-message-adapter';
import {
  applyAgentChatJournalEntry,
  finalizeAgentChatStreaming,
} from '../../lib/agent/runtime/chat-journal-projection';
import type { AgentRuntimeJournalEntry, AgentModelMessage } from '../../lib/agent/runtime/types';
import type { AgentChatMessage } from '../../domain/agent-conversation';
import { portableDisplay, historyResultRefs } from './payload';
import { events } from '../../lib/events';
import {
  ChatProtocolError,
  canonicalJson,
  chunkText,
  hashObject,
  validateObject,
  AGENT_CHAT_MAX_PAYLOAD_CHARS,
  type ChatObject,
  type ChatTurnObject,
  type ChatTurnPayload,
  type ChatBranchObject,
} from './protocol';

export class ChatHistoryUnavailable extends Error {}
export class ChatObjectConflict extends Error {}
export function isInvalidChatHistory(error: unknown): boolean {
  return (
    error instanceof ChatObjectConflict ||
    error instanceof ChatProtocolError ||
    error instanceof SyntaxError ||
    error instanceof AgentRuntimePersistenceConflictError ||
    error instanceof AgentRuntimeRecoveryCorruptionError ||
    error instanceof AgentContextMessageBridgeError ||
    error instanceof AgentRuntimeResultArtifactError
  );
}
const settled = new Set(['completed', 'failed', 'aborted', 'interrupted']);

function visibleMessages(messages: AgentModelMessage[]): AgentChatMessage[] {
  return messages.flatMap((message): AgentChatMessage[] => {
    if (message.role === 'user') return [{ kind: 'user', text: message.content }];
    if (message.role === 'tool') return [];
    return message.content.map(
      (block): AgentChatMessage =>
        block.type === 'tool_call'
          ? {
              kind: 'tool',
              id: block.callId,
              name: block.name,
              input: block.arguments,
              status: 'ok',
            }
          : { kind: block.type === 'thinking' ? 'thinking' : 'assistant', text: block.text },
    );
  });
}

export class AgentConversationSyncRepository {
  constructor(readonly db: DbClient = getDb()) {}

  async put(object: ChatObject, tx: DbExecutor = this.db): Promise<boolean> {
    validateObject(object);
    const bodyJson = canonicalJson(object);
    const hash = await hashObject(object);
    const [existing] = await tx.select().from(Objects).where(eq(Objects.id, object.id));
    if (existing) {
      if (
        existing.hash !== hash ||
        existing.bodyJson !== bodyJson ||
        existing.projectId !== object.projectId
      )
        throw new ChatObjectConflict('An immutable Agent chat identity changed content');
      return false;
    }
    const [previousBranch] =
      object.kind === 'branch'
        ? await tx.select().from(Branches).where(eq(Branches.id, object.branchId))
        : [];
    if (
      previousBranch &&
      object.kind === 'branch' &&
      (previousBranch.projectId !== object.projectId ||
        previousBranch.rootId !== object.rootId ||
        previousBranch.parentBranchId !== object.parentBranchId ||
        previousBranch.forkTurnId !== object.forkTurnId ||
        previousBranch.createdAt !== object.createdAt)
    )
      throw new ChatObjectConflict('Agent chat branch ancestry changed');
    if (
      object.kind === 'blob' &&
      (await chunkText(object.projectId, object.text))[0].id !== object.id
    )
      throw new ChatObjectConflict('Agent chat content address mismatch');
    if (
      previousBranch &&
      object.kind === 'branch' &&
      previousBranch.titleClock === object.clock &&
      previousBranch.title !== object.title
    )
      throw new ChatObjectConflict('Agent branch title clock changed content');
    await tx.insert(Objects).values({
      id: object.id,
      projectId: object.projectId,
      branchId: object.kind === 'blob' ? null : object.branchId,
      kind: object.kind,
      bodyJson,
      hash,
      createdAt:
        object.kind === 'blob'
          ? new Date().toISOString()
          : object.kind === 'branch'
            ? object.updatedAt
            : object.createdAt,
    });
    if (object.kind === 'branch') {
      const previous = previousBranch;
      if (
        previous &&
        (previous.projectId !== object.projectId ||
          previous.rootId !== object.rootId ||
          previous.parentBranchId !== object.parentBranchId ||
          previous.forkTurnId !== object.forkTurnId)
      )
        throw new ChatObjectConflict('Agent chat branch ancestry changed');
      if (!previous) {
        await tx.insert(Branches).values({
          id: object.branchId,
          projectId: object.projectId,
          rootId: object.rootId,
          parentBranchId: object.parentBranchId,
          forkTurnId: object.forkTurnId,
          headTurnId: null,
          title: object.title,
          titleClock: object.clock,
          deletedAt: object.deletedAt,
          createdAt: object.createdAt,
          updatedAt: object.updatedAt,
        });
      } else {
        const winning = object.clock > previous.titleClock;
        await tx
          .update(Branches)
          .set({
            ...(winning
              ? { title: object.title, titleClock: object.clock, updatedAt: object.updatedAt }
              : {}),
            deletedAt:
              previous.deletedAt && object.deletedAt
                ? [previous.deletedAt, object.deletedAt].sort()[0]
                : (previous.deletedAt ?? object.deletedAt),
          })
          .where(eq(Branches.id, object.branchId));
      }
    }
    if (object.kind !== 'blob')
      await tx
        .update(Branches)
        .set({ readiness: 'pending' })
        .where(eq(Branches.id, object.branchId));
    return true;
  }

  async object(id: string, projectId: string, tx: DbExecutor = this.db): Promise<ChatObject> {
    const [row] = await tx
      .select()
      .from(Objects)
      .where(and(eq(Objects.id, id), eq(Objects.projectId, projectId)));
    if (!row) throw new ChatHistoryUnavailable('Agent history is still syncing');
    const object = validateObject(JSON.parse(row.bodyJson));
    if ((await hashObject(object)) !== row.hash)
      throw new ChatObjectConflict('Agent chat local content hash mismatch');
    return object;
  }

  async text(ids: string[], projectId: string, tx: DbExecutor = this.db): Promise<string> {
    let result = '';
    for (const id of ids) {
      const value = await this.object(id, projectId, tx);
      if (value.kind !== 'blob')
        throw new ChatObjectConflict('Agent chat payload reference has the wrong kind');
      result += value.text;
      if (result.length > AGENT_CHAT_MAX_PAYLOAD_CHARS)
        throw new ChatObjectConflict('Agent chat payload exceeds limit');
    }
    return result;
  }

  async payload(turn: ChatTurnObject, tx: DbExecutor = this.db): Promise<ChatTurnPayload> {
    const value = JSON.parse(
      await this.text(turn.payloadIds, turn.projectId, tx),
    ) as ChatTurnPayload;
    if (
      !value ||
      !Array.isArray(value.messages) ||
      !Array.isArray(value.display) ||
      !Array.isArray(value.artifacts) ||
      !Array.isArray(value.summaries)
    )
      throw new ChatObjectConflict('Invalid Agent chat turn payload');
    // The same topology validator used before a provider request rejects broken
    // tool pairs. Display text is never promoted to model history.
    if (value.messages.length)
      agentModelMessagesToContextSources({
        systemPrompt: 'history validation',
        messages: value.messages,
        resolveToolAccess: () => 'read',
      });
    for (const artifact of value.artifacts) {
      if (
        !artifact ||
        typeof artifact.ref !== 'string' ||
        typeof artifact.toolName !== 'string' ||
        typeof artifact.callId !== 'string' ||
        !Array.isArray(artifact.payloadIds) ||
        artifact.payloadIds.some((id) => typeof id !== 'string')
      )
        throw new ChatObjectConflict('Invalid Agent chat result reference');
      await this.text(artifact.payloadIds, turn.projectId, tx);
    }
    // Runtime-only review provenance is never a remote actionable control.
    value.display = finalizeAgentChatStreaming(portableDisplay(value.display)).map((message) =>
      message.kind === 'tool'
        ? {
            ...message,
            review: undefined,
            ...(message.status === 'running' ? { status: 'error' as const } : {}),
          }
        : message,
    );
    return value;
  }

  async history(
    projectId: string,
    head: string | null,
    tx: DbExecutor = this.db,
  ): Promise<Array<{ turn: ChatTurnObject; payload: ChatTurnPayload }>> {
    const result: Array<{ turn: ChatTurnObject; payload: ChatTurnPayload }> = [];
    const seen = new Set<string>();
    while (head) {
      if (seen.has(head) || seen.size >= 100_000)
        throw new ChatObjectConflict('Cyclic or excessive Agent chat ancestry');
      seen.add(head);
      const object = await this.object(head, projectId, tx);
      if (object.kind !== 'turn') throw new ChatObjectConflict('Agent chat parent is not a turn');
      result.push({ turn: object, payload: await this.payload(object, tx) });
      head = object.parentTurnId;
    }
    result.reverse();
    const refs = new Map<string, string>();
    for (const { payload } of result)
      for (const artifact of payload.artifacts) {
        const content = canonicalJson(artifact);
        if (refs.has(artifact.ref) && refs.get(artifact.ref) !== content)
          throw new ChatObjectConflict('Agent result reference changed content');
        refs.set(artifact.ref, content);
      }
    for (const { payload } of result)
      for (const ref of historyResultRefs(payload.messages))
        if (!refs.has(ref))
          throw new ChatObjectConflict('Agent history result reference is missing');
    return result;
  }

  async storeText(projectId: string, text: string, tx: DbExecutor): Promise<string[]> {
    const chunks = await chunkText(projectId, text);
    for (const chunk of chunks) await this.put(chunk, tx);
    return chunks.map((chunk) => chunk.id);
  }

  async metadata(
    conversation: typeof Conversations.$inferSelect,
    existing: typeof Branches.$inferSelect | undefined,
    tx: DbExecutor,
  ): Promise<void> {
    if (
      existing &&
      existing.title === conversation.title &&
      (existing.deletedAt ?? null) === (conversation.deletedAt ?? null)
    )
      return;
    const at = conversation.updatedAt;
    const clock = `${Math.max(
      Date.parse(at),
      existing ? Number(existing.titleClock.split(':')[0]) + 1 : 0,
    )
      .toString()
      .padStart(16, '0')}:${uuidv7()}`;
    const object: ChatBranchObject = {
      kind: 'branch',
      id: `m:${uuidv7()}`,
      projectId: conversation.projectId,
      branchId: conversation.id,
      rootId: existing?.rootId ?? conversation.id,
      parentBranchId: existing?.parentBranchId ?? null,
      forkTurnId: existing?.forkTurnId ?? null,
      title: conversation.title,
      clock,
      deletedAt: existing?.deletedAt ?? conversation.deletedAt,
      createdAt: existing?.createdAt ?? conversation.createdAt,
      updatedAt: at,
    };
    await this.put(object, tx);
  }

  /** Bounded, durable backfill. SQL triggers also capture commits made while unmounted. */
  async flush(projectId: string, limit = 16, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    const missing = await this.db
      .select({ id: Conversations.id })
      .from(Conversations)
      .leftJoin(Bindings, eq(Bindings.conversationId, Conversations.id))
      .where(and(eq(Conversations.projectId, projectId), isNull(Bindings.conversationId)))
      .orderBy(asc(Conversations.id))
      .limit(limit);
    for (const row of missing)
      await this.db.insert(Queue).values({ conversationId: row.id }).onConflictDoNothing();
    const queued = await this.db
      .select({ id: Queue.conversationId, revision: Queue.revision })
      .from(Queue)
      .innerJoin(Conversations, eq(Conversations.id, Queue.conversationId))
      .where(eq(Conversations.projectId, projectId))
      .limit(limit);
    for (const item of queued) {
      signal?.throwIfAborted();
      let hasMore = false;
      try {
        hasMore = await this.exportConversation(item.id, signal);
        signal?.throwIfAborted();
        await this.db
          .delete(Deliveries)
          .where(
            and(eq(Deliveries.scopeId, `local:${projectId}`), eq(Deliveries.objectId, item.id)),
          );
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof ChatHistoryUnavailable) continue; // Keep queued until a pull supplies dependencies.
        if (!isInvalidChatHistory(error)) throw error;
        // One broken session must not starve every other conversation.
        const [conversation] = await this.db
          .select()
          .from(Conversations)
          .where(eq(Conversations.id, item.id));
        if (conversation)
          await this.db.transaction(
            async (tx) => {
              signal?.throwIfAborted();
              const [branch] = await tx.select().from(Branches).where(eq(Branches.id, item.id));
              await this.metadata(conversation, branch, tx);
              await tx
                .insert(Bindings)
                .values({ conversationId: item.id, localOwner: true })
                .onConflictDoNothing();
              await tx
                .insert(Deliveries)
                .values({
                  scopeId: `local:${projectId}`,
                  objectId: item.id,
                  state: 'quarantine',
                  detail: 'CHAT_EXPORT_INVALID',
                })
                .onConflictDoNothing();
            },
            { behavior: 'immediate' },
          );
      }
      signal?.throwIfAborted();
      if (!hasMore)
        await this.db
          .delete(Queue)
          .where(and(eq(Queue.conversationId, item.id), eq(Queue.revision, item.revision)));
    }
    return queued.length;
  }

  private async exportConversation(id: string, signal?: AbortSignal): Promise<boolean> {
    const [conversation] = await this.db
      .select()
      .from(Conversations)
      .where(eq(Conversations.id, id));
    if (!conversation) return false;
    const [binding] = await this.db.select().from(Bindings).where(eq(Bindings.conversationId, id));
    const [branch] = await this.db.select().from(Branches).where(eq(Branches.id, id));
    const runtime = createAgentRuntimePersistenceRepository(this.db);
    const session =
      binding?.localOwner === false
        ? null
        : await runtime.findSessionForRoute({
            projectId: conversation.projectId,
            routeKind: 'chat',
            conversationId: id,
          });
    const snapshot = session ? await runtime.loadRecoverySnapshot(session.id) : null;
    if (snapshot) await recoverAgentRuntimeSnapshot(snapshot); // validate before exporting
    const artifacts = snapshot
      ? await this.db.select().from(Artifacts).where(eq(Artifacts.sessionId, snapshot.session.id))
      : [];
    const artifactRepo = createAgentRuntimeResultArtifactRepository(this.db);
    const verifiedSummaries = snapshot
      ? await loadDurableAgentContextSummaries(snapshot.session.id, runtime)
      : [];
    const lastCompletedOrdinal = Math.max(
      -1,
      ...(snapshot?.turns
        .filter((turn) => turn.status === 'completed')
        .map((turn) => turn.ordinal) ?? []),
    );
    const exports: Array<{
      turn: ChatTurnObject;
      payload: ChatTurnPayload;
      artifactTexts: Map<string, string>;
      ordinal: number;
    }> = [];
    const visibleUsers = (JSON.parse(conversation.messagesJson) as AgentChatMessage[]).filter(
      (message): message is Extract<AgentChatMessage, { kind: 'user' }> => message.kind === 'user',
    );
    let parent = branch?.headTurnId ?? branch?.forkTurnId ?? null;
    let visibleIndex =
      parent && snapshot
        ? (await this.history(conversation.projectId, parent))
            .flatMap(({ payload }) => payload.display)
            .filter((message) => message.kind === 'user').length
        : 0;
    let hasMore = false;
    for (const turn of snapshot?.turns ?? []) {
      if (!settled.has(turn.status)) break;
      if (turn.ordinal <= (binding?.exportedOrdinal ?? -1)) continue;
      const promptRow = snapshot!.messages.find((row) => row.id === turn.promptMessageId);
      const prompt = typeof promptRow?.content === 'string' ? promptRow.content : '';
      const visibleMatch = visibleUsers.findIndex(
        (message, index) =>
          index >= visibleIndex &&
          (message.text === prompt || prompt.endsWith(`\n\n${message.text}`)),
      );
      const visibleUser = visibleMatch >= 0 ? visibleUsers[visibleMatch] : null;
      if (visibleMatch >= 0) visibleIndex = visibleMatch + 1;
      if (exports.length >= 16) {
        hasMore = true;
        break;
      }
      const messages = snapshot!.messages
        .filter(
          (row) => row.turnId === turn.id && row.status === 'complete' && row.role !== 'system',
        )
        .map((row) => ({ role: row.role, content: row.content }) as AgentModelMessage);
      const started = snapshot!.events.find(
        (row) => row.turnId === turn.id && row.eventType === 'turn_started',
      )?.payload as Pick<AgentRuntimeJournalEntry, 'event'> | undefined;
      const automatic =
        started?.event.type === 'turn_started' &&
        started.event.promptSource === 'runtime_continuation';
      let display: AgentChatMessage[] = automatic
        ? []
        : [visibleUser ?? { kind: 'user', text: prompt, at: promptRow?.createdAt }];
      for (const row of snapshot!.events
        .filter((entry) => entry.turnId === turn.id)
        .sort((a, b) => a.seq - b.seq)) {
        display = applyAgentChatJournalEntry(display, {
          schemaVersion: row.schemaVersion,
          eventId: row.eventId,
          sessionId: row.sessionId,
          turnId: row.turnId,
          seq: row.seq,
          wallTimeMs: row.wallTimeMs,
          ...(row.payload as Pick<AgentRuntimeJournalEntry, 'route' | 'event'>),
        } as AgentRuntimeJournalEntry);
      }
      if (!display.length) display = visibleMessages(messages);
      if (visibleUser) {
        const index = display.findIndex((message) => message.kind === 'user');
        if (index >= 0) display[index] = visibleUser;
      }
      visibleIndex += Math.max(
        0,
        display.filter((message) => message.kind === 'user').length - (automatic ? 0 : 1),
      );
      const artifactTexts = new Map<string, string>();
      const payload: ChatTurnPayload = {
        messages:
          turn.status === 'completed'
            ? messages
            : prompt
              ? [{ role: 'user', content: prompt }]
              : [],
        display: JSON.parse(
          JSON.stringify(
            finalizeAgentChatStreaming(display).map((m) =>
              m.kind === 'tool' ? { ...m, review: undefined } : m,
            ),
          ),
        ),
        artifacts: [],
        summaries: turn.ordinal === lastCompletedOrdinal ? verifiedSummaries : [],
      };
      for (const row of artifacts.filter((entry) => entry.turnId === turn.id)) {
        const value = await artifactRepo.get({
          ref: row.ref,
          projectId: conversation.projectId,
          sessionId: snapshot!.session.id,
        });
        if (value) {
          artifactTexts.set(row.ref, value.serialized);
          payload.artifacts.push({
            ref: row.ref,
            toolName: row.toolName,
            callId: row.callId,
            arguments: value.arguments,
            payloadIds: [],
          });
        }
      }
      const ancestorRefs = new Set(
        (branch?.forkTurnId
          ? await this.history(conversation.projectId, branch.forkTurnId)
          : []
        ).flatMap(({ payload }) => payload.artifacts.map((artifact) => artifact.ref)),
      );
      for (const ref of historyResultRefs(payload.messages))
        if (!artifacts.some((artifact) => artifact.ref === ref) && !ancestorRefs.has(ref))
          throw new ChatObjectConflict('Agent history result reference is missing');
      const object: ChatTurnObject = {
        id: `t:${turn.id}`,
        kind: 'turn',
        projectId: conversation.projectId,
        branchId: id,
        parentTurnId: parent,
        outcome: turn.status as ChatTurnObject['outcome'],
        payloadIds: [],
        createdAt: turn.endedAt ?? turn.updatedAt,
      };
      exports.push({ turn: object, payload, artifactTexts, ordinal: turn.ordinal });
      parent = object.id;
    }
    signal?.throwIfAborted();
    await this.db.transaction(
      async (tx) => {
        signal?.throwIfAborted();
        if (!binding) await tx.insert(Bindings).values({ conversationId: id, localOwner: true });
        const legacyArchive =
          !snapshot &&
          !binding &&
          (JSON.parse(conversation.messagesJson) as AgentChatMessage[]).some(
            (message) =>
              message.kind === 'assistant' || message.kind === 'tool' || message.kind === 'error',
          );
        // A root with only a live/permission-waiting turn has no portable history.
        if (!branch && exports.length === 0 && !legacyArchive) return;
        await this.metadata(conversation, branch, tx);
        if (legacyArchive) {
          const payload: ChatTurnPayload = {
            messages: [],
            display: portableDisplay(JSON.parse(conversation.messagesJson)),
            artifacts: [],
            summaries: [],
          };
          const payloadIds = await this.storeText(
            conversation.projectId,
            canonicalJson(payload),
            tx,
          );
          await this.put(
            {
              kind: 'turn',
              id: `archive:${id}`,
              projectId: conversation.projectId,
              branchId: id,
              parentTurnId: null,
              outcome: 'archive',
              payloadIds,
              createdAt: conversation.updatedAt,
            },
            tx,
          );
          await tx
            .update(Branches)
            .set({ headTurnId: `archive:${id}`, readiness: 'archive' })
            .where(eq(Branches.id, id));
        }
        for (const item of exports) {
          for (const artifact of item.payload.artifacts)
            artifact.payloadIds = await this.storeText(
              conversation.projectId,
              item.artifactTexts.get(artifact.ref)!,
              tx,
            );
          item.turn.payloadIds = await this.storeText(
            conversation.projectId,
            canonicalJson(item.payload),
            tx,
          );
          await this.put(item.turn, tx);
          await tx
            .update(Bindings)
            .set({ sessionId: session!.id, exportedOrdinal: item.ordinal })
            .where(eq(Bindings.conversationId, id));
          await tx
            .update(Branches)
            .set({ headTurnId: item.turn.id, readiness: 'ready' })
            .where(eq(Branches.id, id));
        }
        signal?.throwIfAborted();
      },
      { behavior: 'immediate' },
    );
    return hasMore;
  }

  async reconcile(projectId: string, signal?: AbortSignal): Promise<void> {
    const branches = await this.db.select().from(Branches).where(eq(Branches.projectId, projectId));
    const conversationIds: string[] = [];
    for (const branch of branches) {
      signal?.throwIfAborted();
      const rows = await this.db
        .select()
        .from(Objects)
        .where(and(eq(Objects.branchId, branch.id), eq(Objects.kind, 'turn')));
      let head: string | null = branch.headTurnId;
      let readiness = 'ready';
      let history: Awaited<ReturnType<AgentConversationSyncRepository['history']>> = [];
      try {
        const turns = rows.map((row) => validateObject(JSON.parse(row.bodyJson)) as ChatTurnObject);
        const parents = new Set(turns.map((turn) => turn.parentTurnId));
        const tips = turns.filter((turn) => !parents.has(turn.id));
        head = tips[0]?.id ?? branch.forkTurnId;
        const [exportFailure] = await this.db
          .select()
          .from(Deliveries)
          .where(
            and(
              eq(Deliveries.scopeId, `local:${projectId}`),
              eq(Deliveries.objectId, branch.id),
              eq(Deliveries.state, 'quarantine'),
            ),
          );
        if (exportFailure) throw new ChatObjectConflict('Local Agent history needs repair');
        if (tips.length > 1)
          throw new ChatObjectConflict('A single execution branch has divergent writers');
        if (
          branch.parentBranchId &&
          !branches.some(
            (parent) => parent.id === branch.parentBranchId && parent.rootId === branch.rootId,
          )
        )
          throw new ChatHistoryUnavailable('Parent branch is still syncing');
        history = await this.history(projectId, head);
        const allowedBranches = new Set([branch.id]);
        let ancestor = branch;
        while (ancestor.parentBranchId) {
          if (allowedBranches.has(ancestor.parentBranchId))
            throw new ChatObjectConflict('Cyclic Agent branch ancestry');
          allowedBranches.add(ancestor.parentBranchId);
          const next = branches.find((b) => b.id === ancestor.parentBranchId);
          if (!next) throw new ChatHistoryUnavailable('Parent branch is still syncing');
          ancestor = next;
        }
        if (ancestor.rootId !== ancestor.id || branch.rootId !== ancestor.id)
          throw new ChatObjectConflict('Invalid Agent conversation root');
        for (const { turn } of history) {
          const owner = branches.find((candidate) => candidate.id === turn.branchId);
          const parent = history.find((entry) => entry.turn.id === turn.parentTurnId)?.turn;
          if (
            !owner ||
            ((!parent || parent.branchId !== turn.branchId) &&
              turn.parentTurnId !== owner.forkTurnId)
          )
            throw new ChatObjectConflict('Agent turn skipped its fork point');
        }
        const dependencies = new Set(
          history.flatMap(({ turn, payload }) => [
            turn.id,
            ...turn.payloadIds,
            ...payload.artifacts.flatMap((artifact) => artifact.payloadIds),
          ]),
        );
        const metadataRows = await this.db
          .select({ id: Objects.id })
          .from(Objects)
          .where(and(eq(Objects.branchId, branch.id), eq(Objects.kind, 'branch')));
        for (const { id } of metadataRows) dependencies.add(id);
        const failures = await this.db
          .select({ id: Deliveries.objectId })
          .from(Deliveries)
          .where(eq(Deliveries.state, 'quarantine'));
        if (failures.some(({ id }) => dependencies.has(id)))
          throw new ChatObjectConflict('Agent history contains an isolated conflict');
        if (history.some(({ turn }) => !allowedBranches.has(turn.branchId)))
          throw new ChatObjectConflict('Agent turn escaped its branch ancestry');
        if (history.some(({ turn }) => turn.outcome === 'archive')) readiness = 'archive';
      } catch (error) {
        readiness = error instanceof ChatHistoryUnavailable ? 'pending' : 'conflict';
        head = branch.headTurnId;
      }
      const [binding] = await this.db
        .select()
        .from(Bindings)
        .where(eq(Bindings.conversationId, branch.id));
      signal?.throwIfAborted();
      await this.db.transaction(
        async (tx) => {
          signal?.throwIfAborted();
          await tx
            .update(Branches)
            .set({ headTurnId: head, readiness })
            .where(eq(Branches.id, branch.id));
          const [existing] = await tx
            .select()
            .from(Conversations)
            .where(eq(Conversations.id, branch.id));
          if (existing && existing.projectId !== projectId)
            throw new ChatObjectConflict('Conversation identity belongs to another project');
          const display = history.flatMap(({ payload }) => payload.display);
          const messagesJson = JSON.stringify(display);
          const updatedAt = history[history.length - 1]?.turn.createdAt ?? branch.updatedAt;
          if (!existing) {
            conversationIds.push(branch.id);
            await tx.insert(Conversations).values({
              id: branch.id,
              projectId,
              title: branch.title,
              messagesJson,
              mode: 'byok',
              createdAt: branch.createdAt,
              updatedAt,
              deletedAt: branch.deletedAt,
            });
            await tx.insert(Bindings).values({ conversationId: branch.id, localOwner: false });
          } else {
            const remoteDisplayChanged =
              binding?.localOwner === false &&
              (readiness === 'ready' || readiness === 'archive') &&
              existing.messagesJson !== messagesJson;
            if (remoteDisplayChanged || existing.deletedAt !== branch.deletedAt)
              conversationIds.push(branch.id);
            if (
              existing.title !== branch.title ||
              existing.deletedAt !== branch.deletedAt ||
              remoteDisplayChanged
            ) {
              await tx
                .update(Conversations)
                .set({
                  title: branch.title,
                  deletedAt: branch.deletedAt,
                  ...(remoteDisplayChanged ? { messagesJson, updatedAt } : {}),
                })
                .where(eq(Conversations.id, branch.id));
            }
          }
          // Remote projections are not authored changes.
          if (!binding?.localOwner)
            await tx.delete(Queue).where(eq(Queue.conversationId, branch.id));
          signal?.throwIfAborted();
        },
        { behavior: 'immediate' },
      );
    }
    events.emit('agent:conversations-changed', { projectId, conversationIds });
  }

  async forkForContinuation(id: string): Promise<string> {
    const [binding] = await this.db.select().from(Bindings).where(eq(Bindings.conversationId, id));
    if (!binding) return id;
    const [branch] = await this.db.select().from(Branches).where(eq(Branches.id, id));
    if (binding.localOwner && !branch) return id;
    if (!branch || branch.deletedAt || branch.readiness !== 'ready')
      throw new ChatHistoryUnavailable('Agent history is not ready to continue');
    if (binding.localOwner) return id;
    if (!branch.headTurnId)
      throw new ChatHistoryUnavailable('Agent history is not ready to continue');
    const [conversation] = await this.db
      .select()
      .from(Conversations)
      .where(eq(Conversations.id, id));
    if (!conversation) throw new ChatHistoryUnavailable('Conversation no longer exists');
    const forkId = uuidv7();
    const now = new Date().toISOString();
    await this.db.transaction(
      async (tx) => {
        await this.put(
          {
            kind: 'branch',
            id: `m:${uuidv7()}`,
            projectId: branch.projectId,
            branchId: forkId,
            rootId: branch.rootId,
            parentBranchId: id,
            forkTurnId: branch.headTurnId,
            title: branch.title,
            clock: `${Date.now().toString().padStart(16, '0')}:${uuidv7()}`,
            deletedAt: null,
            createdAt: now,
            updatedAt: now,
          },
          tx,
        );
        await tx
          .update(Branches)
          .set({ headTurnId: branch.headTurnId, readiness: 'ready' })
          .where(eq(Branches.id, forkId));
        await tx.insert(Conversations).values({
          ...conversation,
          id: forkId,
          runtimeSessionId: null,
          sdkSessionId: null,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(Bindings).values({ conversationId: forkId, localOwner: true });
      },
      { behavior: 'immediate' },
    );
    return forkId;
  }
}
