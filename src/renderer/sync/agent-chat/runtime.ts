import { and, eq, isNull, asc, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { DbClient } from '../../lib/db';
import {
  AgentChatBindingTable as Bindings,
  AgentChatCursorTable as Cursors,
  AgentChatDeliveryTable as Deliveries,
  AgentChatObjectTable as Objects,
  AgentChatBranchTable as Branches,
  AgentChatQueueTable as Queue,
  AgentConversationTable as Conversations,
  ProjectTable as Projects,
  SyncGenerationTable as Generations,
  SyncAppAuthorityTable as Authority,
} from '../../schema/drizzle';
import type {
  ObjectLogProvider,
  ProviderBinding,
  ProviderGeneration,
  RemoteObject,
  ProviderCursor,
  ProviderPageToken,
} from '../protocol';
import { createLocalObjectRef, createProviderCursor } from '../protocol';
import type { NativeSyncObjectCodec } from '../native-object-codec';
import { SyncGenerationCycleLane, type SyncGenerationCycleResult } from '../engine/cycle';
import type { RegisteredSyncGenerationRuntime } from '../engine/coordinator';
import type { SyncGenerationTransferProgress } from '../engine/status-store';
import type { SchedulerTrigger } from '../engine/scheduler';
import {
  AgentConversationSyncRepository,
  ChatObjectConflict,
  isInvalidChatHistory,
} from './repository';
import {
  AGENT_CHAT_MAX_OBJECT_BYTES,
  decodeChatWire,
  encodeChatWire,
  hashText,
  validateObject,
} from './protocol';

/** Separate failure/cursor domain, sharing the existing coordinator and native transport. */
export class AgentChatSyncRuntime implements RegisteredSyncGenerationRuntime {
  readonly syncGenerationId: string;
  readonly projectId: string;
  private readonly repo: AgentConversationSyncRepository;
  private readonly lane: SyncGenerationCycleLane;
  private readonly listeners = new Set<(runtime: RegisteredSyncGenerationRuntime) => void>();
  private progress: SyncGenerationTransferProgress | null = null;
  get transferProgress() {
    return this.progress;
  }
  private reportProgress(progress: SyncGenerationTransferProgress): void {
    this.progress = progress;
    for (const listener of this.listeners) listener(this);
  }
  private generation: ProviderGeneration | null = null;
  private projectSyncId = '';
  private scopeId = '';
  private didChange = false;
  private readonly incoming = new Map<string, RemoteObject>();
  constructor(
    private readonly options: {
      db: DbClient;
      projectId: string;
      binding: ProviderBinding;
      provider: ObjectLogProvider;
      codec: NativeSyncObjectCodec;
      verifyAuthority?: boolean;
    },
  ) {
    this.projectId = options.projectId;
    this.syncGenerationId = `${options.binding.syncGenerationId}:agent-chat`;
    this.repo = new AgentConversationSyncRepository(options.db);
    this.lane = new SyncGenerationCycleLane({
      syncGenerationId: this.syncGenerationId,
      clock: { nowMs: () => Date.now() },
      onPhaseChange: () => {
        for (const listener of this.listeners) listener(this);
      },
      durable: {
        prepare: async (signal) => {
          this.progress = null;
          await this.guard(signal);
          this.didChange = (await this.repo.flush(this.projectId, 16, signal)) > 0;
          const pending = await options.db
            .select({ id: Branches.id })
            .from(Branches)
            .where(and(eq(Branches.projectId, this.projectId), eq(Branches.readiness, 'pending')))
            .limit(1);
          this.didChange ||= pending.length > 0;
          this.generation ??= await options.provider.openGeneration(options.binding);
          await this.guard(signal);
          this.scopeId = await hashText(
            JSON.stringify([
              options.binding.accountRef,
              options.binding.syncGenerationId,
              'agent-chat',
            ]),
          );
          await options.db.insert(Cursors).values({ id: this.scopeId }).onConflictDoNothing();
        },
        ingest: async (signal) => {
          for (const object of this.incoming.values()) await this.receive(object, signal);
          this.incoming.clear();
        },
        apply: async (signal) => {
          await this.guard(signal);
          if (this.didChange) await this.repo.reconcile(this.projectId, signal);
        },
        checkpoint: async () => false, // Immutable per-turn commits are the restart unit; v1 never prunes them.
        inspectPending: async (signal) => {
          await this.guard(signal);
          const pending = await this.inspectPending();
          return {
            hasPending: pending.pendingChangeSets > 0 || pending.pendingTransfers > 0,
            hasGap: pending.openGaps > 0,
            hasConflict: pending.openConflicts > 0,
            hasQuarantine: pending.quarantinedObjects > 0,
          };
        },
      },
      provider: {
        pull: (signal) => this.pull(signal),
        publishBlobs: (signal) => this.publish(true, signal),
        publishSegments: (signal) => this.publish(false, signal),
      },
    });
  }
  get status() {
    return this.lane.status;
  }
  subscribeStatus(listener: (runtime: RegisteredSyncGenerationRuntime) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async runCycle(
    _triggers: ReadonlySet<SchedulerTrigger>,
    signal: AbortSignal,
  ): Promise<SyncGenerationCycleResult> {
    return this.lane.run(signal);
  }

  private async guard(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const [generation] = await this.options.db
      .select()
      .from(Generations)
      .where(eq(Generations.syncGenerationId, this.options.binding.syncGenerationId));
    if (!generation || generation.projectId !== this.projectId || generation.status !== 'active')
      throw new Error('Agent chat project generation is no longer active');
    const [project] = await this.options.db
      .select({ id: Projects.id })
      .from(Projects)
      .where(eq(Projects.id, this.projectId));
    if (!project) throw new Error('Agent chat project is no longer active');
    this.projectSyncId = generation.projectSyncId;
    if (this.options.verifyAuthority !== false) {
      const [authority] = await this.options.db.select().from(Authority).limit(1);
      if (
        !authority ||
        authority.generation !== this.options.binding.authorityGeneration ||
        authority.mode !== 'google-drive' ||
        authority.transitionState !== 'stable'
      )
        throw new Error('Agent chat provider authority changed');
    }
    signal.throwIfAborted();
  }

  private async pull(signal: AbortSignal): Promise<{ objectCount: number }> {
    await this.guard(signal);
    const [state] = await this.options.db
      .select()
      .from(Cursors)
      .where(eq(Cursors.id, this.scopeId));
    let nextCursor: ProviderCursor | null = state?.cursor
      ? createProviderCursor(state.cursor)
      : null;
    const pageTokens = new Set<string>();
    let pageToken: ProviderPageToken | undefined;
    this.incoming.clear();
    try {
      if (!nextCursor) {
        nextCursor = await this.options.provider.captureStartCursor(this.generation!);
        do {
          await this.guard(signal);
          const page = await this.options.provider.listInventory({
            generation: this.generation!,
            ...(pageToken ? { pageToken } : {}),
          });
          for (const object of page.objects) this.incoming.set(object.objectId, object);
          pageToken = page.nextPageToken;
          if (pageToken && (pageTokens.has(pageToken) || pageTokens.size >= 10_000))
            throw new Error('Agent chat inventory pagination did not advance');
          if (pageToken) pageTokens.add(pageToken);
        } while (pageToken);
      } else {
        do {
          await this.guard(signal);
          const page = await this.options.provider.listChanges({
            generation: this.generation!,
            cursor: nextCursor,
            ...(pageToken ? { pageToken } : {}),
          });
          for (const change of page.changes) {
            if (change.kind === 'present') this.incoming.set(change.object.objectId, change.object);
            else {
              // Account-wide Drive changes also include unrelated files. Only
              // a previously observed chat object can become degraded.
              const [known] = await this.options.db
                .select()
                .from(Deliveries)
                .where(
                  and(
                    eq(Deliveries.scopeId, this.scopeId),
                    eq(Deliveries.remoteId, change.objectId),
                  ),
                );
              if (known)
                await this.quarantine(
                  known.objectId,
                  change.objectId,
                  'REMOTE_OBJECT_REMOVED',
                  signal,
                );
            }
          }
          pageToken = page.nextPageToken;
          if (page.newCursor) nextCursor = page.newCursor;
          if (pageToken && (pageTokens.has(pageToken) || pageTokens.size >= 10_000))
            throw new Error('Agent chat changes pagination did not advance');
          if (pageToken) pageTokens.add(pageToken);
        } while (pageToken);
      }
    } catch (error) {
      const code = (error as { code?: string }).code?.toUpperCase().replace(/-/g, '_');
      if (code === 'INVALID_CURSOR' || code === 'INVALID_PAGE_TOKEN') {
        await this.guard(signal);
        await this.options.db
          .update(Cursors)
          .set({ cursor: null })
          .where(eq(Cursors.id, this.scopeId));
      }
      throw error;
    }
    // Persist every downloaded object before advancing the cursor. A crash
    // replays inventory safely; there is no volatile-only acknowledged inbox.
    if (this.incoming.size)
      this.reportProgress({
        stage: 'download',
        totalObjects: this.incoming.size,
        completedObjects: 0,
        totalBytes: [...this.incoming.values()].reduce((n, object) => n + object.sizeBytes, 0),
        transferredBytes: 0,
        totalKnown: true,
      });
    for (const object of this.incoming.values()) {
      await this.receive(object, signal);
      this.reportProgress({
        ...this.progress!,
        completedObjects: this.progress!.completedObjects + 1,
        transferredBytes: this.progress!.transferredBytes + object.sizeBytes,
      });
    }
    const count = this.incoming.size;
    this.incoming.clear();
    await this.guard(signal);
    await this.options.db
      .update(Cursors)
      .set({ cursor: nextCursor, backfillComplete: true })
      .where(eq(Cursors.id, this.scopeId));
    return { objectCount: count };
  }

  private async receive(remote: RemoteObject, signal: AbortSignal): Promise<void> {
    const [receipt] = await this.options.db
      .select()
      .from(Deliveries)
      .where(and(eq(Deliveries.scopeId, this.scopeId), eq(Deliveries.remoteId, remote.objectId)));
    if (receipt?.remoteId === remote.objectId && receipt.state === 'present') {
      const [local] = await this.options.db
        .select()
        .from(Objects)
        .where(eq(Objects.id, receipt.objectId));
      if (local) {
        const bytes = encodeChatWire(
          validateObject(JSON.parse(local.bodyJson)),
          this.projectSyncId,
          this.options.binding.syncGenerationId,
        );
        if (
          (await hashText(new TextDecoder().decode(bytes))) === remote.storedSha256 &&
          bytes.byteLength === remote.sizeBytes
        )
          return;
      }
    }
    const ref = createLocalObjectRef(`syncobj:agent-chat.${uuidv7()}`);
    let downloaded = false;
    let identity = receipt?.objectId ?? `wire:${remote.logicalKeyId}`;
    try {
      if (
        remote.sizeBytes <= 0 ||
        remote.sizeBytes > AGENT_CHAT_MAX_OBJECT_BYTES ||
        !['segment', 'blob'].includes(remote.objectKind)
      ) {
        downloaded = true;
        throw new ChatObjectConflict('Invalid Agent chat remote object');
      }
      await this.options.provider.downloadImmutable({
        generation: this.generation!,
        objectId: remote.objectId,
        destinationRef: ref,
        expectedStoredSha256: remote.storedSha256 as `sha256:${string}`,
        transferId: uuidv7(),
        signal,
      });
      downloaded = true;
      await this.guard(signal);
      const bytes = await this.options.codec.readProtocolBytes(ref, AGENT_CHAT_MAX_OBJECT_BYTES);
      const object = decodeChatWire(bytes, {
        projectId: this.projectId,
        projectSyncId: this.projectSyncId,
        generationId: this.options.binding.syncGenerationId,
      });
      if ((await hashText(object.id)) !== remote.logicalKeyId)
        throw new ChatObjectConflict('Agent chat logical identity mismatch');
      identity = object.id;
      if ((object.kind === 'blob') !== (remote.objectKind === 'blob'))
        throw new ChatObjectConflict('Agent chat object kind mismatch');
      await this.guard(signal);
      await this.options.db.transaction(
        async (tx) => {
          signal.throwIfAborted();
          this.didChange = (await this.repo.put(object, tx)) || this.didChange;
          await tx
            .insert(Deliveries)
            .values({
              scopeId: this.scopeId,
              objectId: object.id,
              remoteId: remote.objectId,
              state: 'present',
            })
            .onConflictDoUpdate({
              target: [Deliveries.scopeId, Deliveries.objectId],
              set: { state: 'present', remoteId: remote.objectId, detail: null },
            });
          signal.throwIfAborted();
        },
        { behavior: 'immediate' },
      );
    } catch (error) {
      signal.throwIfAborted();
      const code = (error as { code?: string }).code?.toUpperCase().replace(/-/g, '_');
      const permanentObjectFailure = [
        'REMOTE_OBJECT_MISSING',
        'REMOTE_CORRUPT',
        'REMOTE_STORE_CORRUPT',
        'HASH_MISMATCH',
        'SIZE_MISMATCH',
      ].includes(code ?? '');
      if (
        (!isInvalidChatHistory(error) && !permanentObjectFailure) ||
        (!downloaded && !permanentObjectFailure) ||
        (error as { retryable?: boolean }).retryable
      )
        throw error;
      await this.guard(signal);
      this.didChange = true;
      await this.quarantine(identity, remote.objectId, 'CHAT_OBJECT_INVALID', signal);
    } finally {
      await this.options.codec.discardLocal?.(ref);
    }
  }

  private async quarantine(
    identity: string,
    remoteId: string,
    detail: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.guard(signal);
    await this.options.db.transaction(
      async (tx) => {
        signal.throwIfAborted();
        await tx
          .insert(Deliveries)
          .values({
            scopeId: this.scopeId,
            objectId: identity,
            remoteId,
            state: 'quarantine',
            detail,
          })
          .onConflictDoUpdate({
            target: [Deliveries.scopeId, Deliveries.objectId],
            set: { state: 'quarantine', detail },
          });
        // A committed inbox remains discoverable after a crash before projection.
        await tx
          .update(Branches)
          .set({ readiness: 'pending' })
          .where(eq(Branches.projectId, this.projectId));
        signal.throwIfAborted();
      },
      { behavior: 'immediate' },
    );
    this.didChange = true;
  }

  private async publish(blobs: boolean, signal: AbortSignal): Promise<{ objectCount: number }> {
    const { db, codec, provider } = this.options;
    const rows = await db
      .select({ object: Objects })
      .from(Objects)
      .leftJoin(
        Deliveries,
        and(eq(Deliveries.scopeId, this.scopeId), eq(Deliveries.objectId, Objects.id)),
      )
      .where(
        and(
          eq(Objects.projectId, this.projectId),
          isNull(Deliveries.objectId),
          blobs ? eq(Objects.kind, 'blob') : sql`${Objects.kind} <> 'blob'`,
        ),
      )
      .orderBy(asc(Objects.id))
      .limit(128);
    let count = 0;
    if (rows.length)
      this.reportProgress({
        stage: 'upload-changes',
        totalObjects: rows.length,
        completedObjects: 0,
        totalBytes: 0,
        transferredBytes: 0,
        totalKnown: false,
      });
    for (const { object: row } of rows) {
      await this.guard(signal);
      const object = validateObject(JSON.parse(row.bodyJson));
      if (object.kind === 'turn') {
        const payload = await this.repo.payload(object);
        const dependencies = [
          ...object.payloadIds,
          ...payload.artifacts.flatMap((artifact) => artifact.payloadIds),
        ];
        let ready = true;
        for (const id of dependencies) {
          const [receipt] = await db
            .select()
            .from(Deliveries)
            .where(
              and(
                eq(Deliveries.scopeId, this.scopeId),
                eq(Deliveries.objectId, id),
                eq(Deliveries.state, 'present'),
              ),
            );
          if (!receipt) {
            ready = false;
            break;
          }
        }
        if (!ready) continue;
      }
      const staged = await codec.stageProtocolBytes(
        encodeChatWire(object, this.projectSyncId, this.options.binding.syncGenerationId),
      );
      try {
        await this.guard(signal);
        const result = await provider.uploadImmutable({
          generation: this.generation!,
          ...staged,
          objectKind: blobs ? 'blob' : 'segment',
          logicalKeyId: await hashText(row.id),
          transferId: uuidv7(),
          signal,
        });
        await this.guard(signal);
        await db
          .insert(Deliveries)
          .values({
            scopeId: this.scopeId,
            objectId: row.id,
            remoteId: result.object.objectId,
            state: 'present',
          })
          .onConflictDoNothing();
        count += 1;
        this.reportProgress({
          ...this.progress!,
          completedObjects: count,
          transferredBytes: this.progress!.transferredBytes + staged.sizeBytes,
        });
      } finally {
        await codec.discardLocal?.(staged.sourceRef);
      }
    }
    return { objectCount: count };
  }

  async inspectPending() {
    const db = this.options.db;
    const queue = await db
      .select({ count: sql<number>`count(*)` })
      .from(Queue)
      .innerJoin(Conversations, eq(Conversations.id, Queue.conversationId))
      .where(eq(Conversations.projectId, this.projectId));
    const unbound = await db
      .select({ count: sql<number>`count(*)` })
      .from(Conversations)
      .leftJoin(Bindings, eq(Bindings.conversationId, Conversations.id))
      .where(and(eq(Conversations.projectId, this.projectId), isNull(Bindings.conversationId)));
    const pending = await db
      .select({ count: sql<number>`count(*)` })
      .from(Objects)
      .leftJoin(
        Deliveries,
        and(eq(Deliveries.scopeId, this.scopeId), eq(Deliveries.objectId, Objects.id)),
      )
      .where(and(eq(Objects.projectId, this.projectId), isNull(Deliveries.objectId)));
    const branches = await db
      .select({ readiness: Branches.readiness })
      .from(Branches)
      .where(eq(Branches.projectId, this.projectId));
    const quarantine = await db
      .select({ count: sql<number>`count(*)` })
      .from(Deliveries)
      .where(and(eq(Deliveries.scopeId, this.scopeId), eq(Deliveries.state, 'quarantine')));
    return {
      pendingChangeSets: (queue[0]?.count ?? 0) + (unbound[0]?.count ?? 0),
      pendingSegments: 0,
      pendingTransfers: pending[0]?.count ?? 0,
      openGaps: branches.filter((b) => b.readiness === 'pending').length,
      openConflicts: branches.filter((b) => b.readiness === 'conflict').length,
      quarantinedObjects: quarantine[0]?.count ?? 0,
    };
  }
}
