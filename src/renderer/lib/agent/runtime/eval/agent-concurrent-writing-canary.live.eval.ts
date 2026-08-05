import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { LLMClient } from '../../../ai/client/llm-client';
import { DeepSeekProvider } from '../../../ai/client/providers/deepseek';
import { createDatabaseClient, type DbClient } from '../../../db';
import {
  AgentConversationTable,
  BookNodeTable,
  NodeContentTable,
  ProjectTable,
} from '../../../../schema/drizzle';
import { createBookContentRepository } from '../../../../sqlite-repo/content-repo';
import { createBookNodeSqliteRepository } from '../../../../sqlite-repo/node-repo';
import { createProjectRepository } from '../../../../sqlite-repo/project-repo';
import { createYjsRepository } from '../../../../sqlite-repo/yjs-repo';
import { useAgentEditStore } from '../../../../store/agent-edit-store';
import { useDataStore } from '../../../../store/data-store';
import { useProjectStore } from '../../../../store/project-store';
import { useSettingsStore } from '../../../../store/settings-store';
import { setAgentEditModeOverride } from '../../agent-edit-mode';
import type { AgentToolContext, AgentWriteApi } from '../../tool-handlers';
import { ProductFileBackedSqliteGateway } from '../acceptance/p3-file-backed-sqlite';
import { createDriftingAgentProductComposition } from '../drifting-product-composition';
import { DriftingAgentModelDriver } from '../drivers/drifting-agent-driver';
import type {
  AgentModelDriver,
  AgentModelRequest,
  AgentRuntimeJournalEntry,
} from '../types';
import { createYjsProseSeedState } from '../yjs-prose-command';

const databaseSlot = vi.hoisted(() => ({
  current: null as unknown,
}));

vi.mock('../../../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../db')>();
  return {
    ...actual,
    getDb: () => {
      if (!databaseSlot.current) {
        throw new Error('The concurrent DeepSeek canary database is not installed.');
      }
      return databaseSlot.current as ReturnType<typeof actual.getDb>;
    },
  };
});

const LIVE_EVAL_ENABLED = process.env.DRIFTING_AGENT_LIVE_EVAL === '1';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const PROJECT_ID = 'concurrent-deepseek-project';
const USER_ID = 'concurrent-deepseek-user';
const NODE_ID = 'concurrent-deepseek-node';
const NODE_TITLE = '并发试验';
const DOC_ID = `node-content:${NODE_ID}`;
const CONVERSATION_A = 'concurrent-deepseek-conversation-a';
const CONVERSATION_B = 'concurrent-deepseek-conversation-b';
const TURN_A = 'concurrent-deepseek-turn-a';
const TURN_B = 'concurrent-deepseek-turn-b';
const INITIAL_REVISION = '2026-08-05T00:00:00.000Z';
const SLOT_A = 'SLOTA';
const SLOT_B = 'SLOTB';
const DONE_A = 'AGENTADONE';
const DONE_B = 'AGENTBDONE';
const MODEL_READ_TOOL_NAMES = ['read_object', 'read_file'] as const;
const MODEL_REVISE_TOOL_NAMES = ['revise_object', 'edit_file'] as const;
const INITIAL_CONTENT_JSON = JSON.stringify({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { id: 'concurrent-opening' },
      content: [{ type: 'text', text: '并发试验起点。' }],
    },
    {
      type: 'paragraph',
      attrs: { id: 'concurrent-slot-a' },
      content: [{ type: 'text', text: SLOT_A }],
    },
    {
      type: 'paragraph',
      attrs: { id: 'concurrent-slot-b' },
      content: [{ type: 'text', text: SLOT_B }],
    },
  ],
});

const initialDataState = useDataStore.getState();
const initialProjectState = useProjectStore.getState();
const initialSettingsState = useSettingsStore.getState();

interface ProviderRequestTrace {
  sessionId: string;
  turnId: string;
  iteration: number;
  toolNames: string[];
  forcedTool: string | null;
}

function isModelReadTool(name: string): boolean {
  return MODEL_READ_TOOL_NAMES.some((candidate) => candidate === name);
}

function isModelReviseTool(name: string): boolean {
  return MODEL_REVISE_TOOL_NAMES.some((candidate) => candidate === name);
}

function classifyModelToolTrace(trace: string): string {
  const separator = trace.lastIndexOf(':');
  const name = separator >= 0 ? trace.slice(0, separator) : trace;
  const outcome = separator >= 0 ? trace.slice(separator + 1) : '';
  if (isModelReadTool(name)) return `read:${outcome}`;
  if (isModelReviseTool(name)) return `revise:${outcome}`;
  return trace;
}

/**
 * Both real provider turns must finish their first canonical read before either
 * can ask DeepSeek for a write. The production writer scheduler and Yjs/CAS
 * path remain untouched; this only removes network-latency luck from the race.
 */
class ReadThenConcurrentWriteDriver implements AgentModelDriver {
  readonly id: string;
  readonly capabilities;
  readonly requests: ProviderRequestTrace[] = [];
  private readonly barrier = new TwoPartyBarrier(2);

  constructor(private readonly delegate: AgentModelDriver) {
    this.id = `${delegate.id}-concurrent-live-canary`;
    this.capabilities = delegate.capabilities;
  }

  get barrierParticipants(): readonly string[] {
    return this.barrier.participants;
  }

  stream(request: AgentModelRequest) {
    return this.streamPrepared(request);
  }

  private async *streamPrepared(request: AgentModelRequest) {
    let effective = request;
    let forcedTool: string | null = null;
    const latestResult = latestModelToolResult(request);
    const sawReviseFailure = request.context.messages.some(
      (entry) =>
        entry.type === 'model_message' &&
        entry.message.role === 'tool' &&
        entry.message.content.some(
          (result) => isModelReviseTool(result.name) && !result.ok,
        ),
    );
    if (request.lifecycle !== 'single_request' && request.iteration === 1) {
      const read = request.tools.find((tool) => isModelReadTool(tool.name));
      if (!read) throw new Error('The product selector did not expose a prose read facade.');
      forcedTool = read.name;
      effective = {
        ...request,
        tools: [read],
        toolChoice: { force: read.name },
      };
    } else if (request.lifecycle !== 'single_request' && request.iteration === 2) {
      const revise = request.tools.find((tool) => isModelReviseTool(tool.name));
      if (!revise) throw new Error('The product selector did not expose a prose revision facade.');
      forcedTool = revise.name;
      effective = {
        ...request,
        tools: [revise],
        toolChoice: { force: revise.name },
      };
      await this.barrier.arrive(request.sessionId, request.signal);
    } else if (
      request.lifecycle !== 'single_request' &&
      latestResult &&
      !latestResult.ok &&
      isModelReviseTool(latestResult.name)
    ) {
      const read = request.tools.find((tool) => isModelReadTool(tool.name));
      if (!read) throw new Error('Conflict recovery did not expose a prose read facade.');
      forcedTool = read.name;
      effective = {
        ...request,
        tools: [read],
        toolChoice: { force: read.name },
      };
    } else if (
      request.lifecycle !== 'single_request' &&
      sawReviseFailure &&
      latestResult?.ok === true &&
      isModelReadTool(latestResult.name)
    ) {
      const revise = request.tools.find((tool) => isModelReviseTool(tool.name));
      if (!revise) throw new Error('Conflict recovery did not expose a prose revision facade.');
      forcedTool = revise.name;
      effective = {
        ...request,
        tools: [revise],
        toolChoice: { force: revise.name },
      };
    } else if (
      request.lifecycle !== 'single_request' &&
      latestResult?.ok === true &&
      isModelReviseTool(latestResult.name)
    ) {
      effective = {
        ...request,
        tools: [],
        toolChoice: 'auto',
      };
    }
    this.requests.push({
      sessionId: request.sessionId,
      turnId: request.turnId,
      iteration: request.iteration,
      toolNames: effective.tools.map((tool) => tool.name),
      forcedTool,
    });
    yield* this.delegate.stream(effective);
  }
}

class TwoPartyBarrier {
  private readonly arrived = new Set<string>();
  private readonly open: Promise<void>;
  private release!: () => void;
  private released = false;

  constructor(private readonly expected: number) {
    this.open = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  get participants(): readonly string[] {
    return [...this.arrived];
  }

  async arrive(participant: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('Concurrent DeepSeek canary was aborted at the barrier.');
    this.arrived.add(participant);
    if (!this.released && this.arrived.size >= this.expected) {
      this.released = true;
      this.release();
    }
    await waitWithTimeoutAndSignal(
      this.open,
      90_000,
      signal,
      'Both DeepSeek sessions did not reach the write barrier.',
    );
  }
}

describe.skipIf(!LIVE_EVAL_ENABLED)('General Agent concurrent DeepSeek writing canary', () => {
  it(
    'runs two real sessions against one Yjs document and attributes the stale writer',
    async () => {
      const apiKey = process.env.DEEPSEEK_AI_API_KEY;
      if (!apiKey) {
        throw new Error(
          'DEEPSEEK_AI_API_KEY is required; use pnpm eval:agent:concurrency:live',
        );
      }
      const model = process.env.DEEPSEEK_AGENT_MODEL ?? DEFAULT_MODEL;
      const expectedDirectoryPrefix = path.join(
        tmpdir(),
        'drifting-concurrent-deepseek-',
      );
      const directory = await mkdtemp(expectedDirectoryPrefix);
      expect(directory.startsWith(expectedDirectoryPrefix)).toBe(true);
      const databasePath = path.join(directory, 'drifting.db');
      const gateway = new ProductFileBackedSqliteGateway(databasePath, true, {
        deferRootRequestsDuringTransaction: true,
      });
      const database = createDatabaseClient(gateway);
      databaseSlot.current = database;
      let unsubscribe: (() => void) | undefined;
      let transport: ReturnType<typeof createDriftingAgentProductComposition>['transport'] | undefined;
      const entries: AgentRuntimeJournalEntry[] = [];
      const terminalTurns = new Set<string>();
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });

      try {
        await gateway.open('drifting.db');
        await seedDatabase(database);
        await hydrateStores(database);
        useAgentEditStore.getState().clearAll();
        useSettingsStore.getState().setAgentEditMode('auto');
        setAgentEditModeOverride(null);

        const productDriver = new DriftingAgentModelDriver({
          defaultModel: model,
          createClient: async () =>
            new LLMClient(
              new DeepSeekProvider({
                apiKey,
                defaultModel: model,
                thinking: false,
              }),
            ),
        });
        const driver = new ReadThenConcurrentWriteDriver(productDriver);
        let idOrdinal = 0;
        const context: AgentToolContext = {
          projectId: PROJECT_ID,
          write: unsupportedRendererWriteApi(),
        };
        const composition = createDriftingAgentProductComposition({
          driver,
          database,
          getContext: () => context,
          createId: (kind) => `concurrent-deepseek-${kind}-${(idOrdinal += 1)}`,
          limits: {
            maxDurationMs: 240_000,
            maxModelIterations: 8,
            maxToolCalls: 10,
            maxInputTokens: 120_000,
            maxOutputTokens: 12_000,
            maxTotalTokens: 132_000,
          },
        });
        transport = composition.transport;
        const subscription = transport.subscribeJournal((entry) => {
          entries.push(entry);
          if (entry.event.type !== 'turn_finished') return;
          terminalTurns.add(entry.turnId);
          if (terminalTurns.has(TURN_A) && terminalTurns.has(TURN_B)) resolveDone();
        });
        if (!subscription.ok) throw new Error(subscription.error);
        unsubscribe = subscription.value;

        const specs = [
          {
            conversationId: CONVERSATION_A,
            turnId: TURN_A,
            prompt:
              `先完整读取章节「${NODE_TITLE}」。只把正文中唯一的 ${SLOT_A} 改成 ${DONE_A}，` +
              '其他文字一个字都不要改，并且必须实际保存。若工具说明另一个 General Agent 刚修改过该章节，' +
              '先重新读取当前章节，再只完成仍未完成的这一处替换；不要重复已经成功的修改。' +
              `若工具使用 target/currentText/revisedText，必须传 target="章节「${NODE_TITLE}」"、` +
              `currentText="${SLOT_A}"、revisedText="${DONE_A}"；若工具使用 path/replacements，` +
              `必须传 path="/chapters/${NODE_TITLE}/prose.md"、oldText="${SLOT_A}"、newText="${DONE_A}"。`,
          },
          {
            conversationId: CONVERSATION_B,
            turnId: TURN_B,
            prompt:
              `先完整读取章节「${NODE_TITLE}」。只把正文中唯一的 ${SLOT_B} 改成 ${DONE_B}，` +
              '其他文字一个字都不要改，并且必须实际保存。若工具说明另一个 General Agent 刚修改过该章节，' +
              '先重新读取当前章节，再只完成仍未完成的这一处替换；不要重复已经成功的修改。' +
              `若工具使用 target/currentText/revisedText，必须传 target="章节「${NODE_TITLE}」"、` +
              `currentText="${SLOT_B}"、revisedText="${DONE_B}"；若工具使用 path/replacements，` +
              `必须传 path="/chapters/${NODE_TITLE}/prose.md"、oldText="${SLOT_B}"、newText="${DONE_B}"。`,
          },
        ] as const;
        const starts = await Promise.all(
          specs.map((spec) =>
            transport!.start({
              turnId: spec.turnId,
              route: {
                kind: 'chat',
                projectId: PROJECT_ID,
                conversationId: spec.conversationId,
              },
              newConversation: true,
              prompt: spec.prompt,
              provider: 'deepseek',
              model,
              projectName: '并发 DeepSeek canary',
              thinking: 'off',
              toolSearch: 'off',
            }),
          ),
        );
        expect(starts).toEqual([
          { ok: true, value: undefined },
          { ok: true, value: undefined },
        ]);
        await waitWithTimeout(done, 5 * 60_000, 'Concurrent DeepSeek turns did not finish.');

        const terminals = entries
          .filter((entry) => entry.event.type === 'turn_finished')
          .filter((entry) => entry.turnId === TURN_A || entry.turnId === TURN_B);
        const conciseTraces = [TURN_A, TURN_B].map((turnId) => {
          const terminal = terminals.find((entry) => entry.turnId === turnId);
          const tools = entries
            .filter(
              (entry) => entry.turnId === turnId && entry.event.type === 'tool_result',
            )
            .map((entry) => {
              if (entry.event.type !== 'tool_result') return '';
              return `${entry.event.name}:${entry.event.ok ? 'ok' : 'failed'}`;
            })
            .join(',');
          return `${turnId}:${
            terminal?.event.type === 'turn_finished'
              ? `${terminal.event.outcome}/${terminal.event.modelIterations}`
              : 'missing'
          }[${tools}]`;
        });
        console.log(`[agent-concurrent-writing-canary-trace] ${conciseTraces.join(' ')}`);
        expect(terminals).toHaveLength(2);
        expect(terminals.every((entry) => entry.event.type === 'turn_finished')).toBe(true);
        for (const terminal of terminals) {
          if (terminal.event.type !== 'turn_finished') continue;
          expect(terminal.event.outcome, terminal.turnId).toBe('completed');
          expect(terminal.event.modelIterations, terminal.turnId).toBeLessThanOrEqual(6);
        }

        const toolResults = entries.filter((entry) => entry.event.type === 'tool_result');
        const failedWrites = toolResults.filter(
          (entry) =>
            entry.event.type === 'tool_result' &&
            isModelReviseTool(entry.event.name) &&
            !entry.event.ok,
        );
        expect(failedWrites).toHaveLength(1);
        const conflict = failedWrites[0]!;
        if (conflict.event.type !== 'tool_result') {
          throw new Error('Expected one model-visible write conflict.');
        }
        expect(conflict.event.content).toContain(
          'Another General Agent conversation changed this authored object after the cited read.',
        );
        expect(conflict.event.content).not.toContain(
          'The author changed this authored object',
        );
        expect(conflict.event.content).not.toContain(
          'AGENT_COLLABORATION_CONFLICT_LIMIT',
        );

        const successfulWrites = toolResults.filter(
          (entry) =>
            entry.event.type === 'tool_result' &&
            isModelReviseTool(entry.event.name) &&
            entry.event.ok,
        );
        expect(successfulWrites).toHaveLength(2);
        for (const turnId of [TURN_A, TURN_B]) {
          const trace = toolResults
            .filter((entry) => entry.turnId === turnId)
            .map((entry) => {
              if (entry.event.type !== 'tool_result') return '';
              return `${entry.event.name}:${entry.event.ok ? 'ok' : 'failed'}`;
            });
          expect(trace[0], turnId).toMatch(/^(?:read_object|read_file):ok$/u);
          expect(trace[trace.length - 1], turnId).toMatch(
            /^(?:revise_object|edit_file):ok$/u,
          );
        }
        const losingTrace = toolResults
          .filter((entry) => entry.turnId === conflict.turnId)
          .map((entry) => {
            if (entry.event.type !== 'tool_result') return '';
            return `${entry.event.name}:${entry.event.ok ? 'ok' : 'failed'}`;
          });
        expect(losingTrace.map(classifyModelToolTrace)).toEqual([
          'read:ok',
          'revise:failed',
          'read:ok',
          'revise:ok',
        ]);

        expect(driver.barrierParticipants).toHaveLength(2);
        expect(new Set(driver.barrierParticipants).size).toBe(2);
        expect(
          driver.requests.filter((request) => request.iteration === 1),
        ).toHaveLength(2);
        expect(
          driver.requests.filter((request) => request.iteration === 2),
        ).toHaveLength(2);

        const projection = await createBookContentRepository(database).findByNodeId(NODE_ID);
        if (!projection) throw new Error('The final node projection is missing.');
        const base = await composition.proseCoordinator.readBase(DOC_ID);
        const ydoc = new Y.Doc({ gc: false });
        Y.applyUpdate(ydoc, base.stateUpdate, 'live-canary-read');
        const yjsJson = yDocToProsemirrorJSON(ydoc, 'default');
        ydoc.destroy();
        expect(JSON.parse(projection.contentJson)).toEqual(yjsJson);
        const finalText = collectText(yjsJson);
        expect(occurrences(finalText, DONE_A)).toBe(1);
        expect(occurrences(finalText, DONE_B)).toBe(1);
        expect(finalText).not.toContain(SLOT_A);
        expect(finalText).not.toContain(SLOT_B);
        expect(base.revision).toBe(2);

        const provenance = await createYjsRepository(database).listRevisionProvenance(
          DOC_ID,
          0,
        );
        expect(provenance).toHaveLength(2);
        expect(provenance.map((entry) => entry.revision)).toEqual([1, 2]);
        expect(provenance.every((entry) => entry.source.kind === 'agent')).toBe(true);
        const provenanceTurns = provenance.flatMap((entry) =>
          entry.source.kind === 'agent' && entry.source.collaborator
            ? [entry.source.collaborator.turnId]
            : [],
        );
        expect(new Set(provenanceTurns)).toEqual(new Set([TURN_A, TURN_B]));
        const successfulCallIds = successfulWrites.map((entry) => {
          if (entry.event.type !== 'tool_result') return '';
          return entry.event.callId;
        });
        const provenanceCallIds = provenance.flatMap((entry) =>
          entry.source.kind === 'agent' && entry.source.collaborator
            ? [entry.source.collaborator.callId]
            : [],
        );
        expect(new Set(provenanceCallIds)).toEqual(new Set(successfulCallIds));

        const totalUsage = terminals.reduce(
          (sum, entry) => {
            if (entry.event.type !== 'turn_finished') return sum;
            return {
              inputTokens: sum.inputTokens + entry.event.usage.inputTokens,
              outputTokens: sum.outputTokens + entry.event.usage.outputTokens,
              costUsd: sum.costUsd + entry.event.usage.costUsd,
              durationMs: Math.max(sum.durationMs, entry.event.durationMs),
            };
          },
          { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
        );
        console.log(
          `[agent-concurrent-writing-canary] model=${model} sessions=2 barrier=2 conflicts=1 successfulWrites=2 yjsRevision=${base.revision} provenance=${provenance.length} tokens=${totalUsage.inputTokens}+${totalUsage.outputTokens} costUsd=${totalUsage.costUsd.toFixed(6)} wallMs=${totalUsage.durationMs}`,
        );
      } finally {
        unsubscribe?.();
        if (transport && terminalTurns.size < 2) {
          await Promise.allSettled([
            transport.abort({ turnId: TURN_A }),
            transport.abort({ turnId: TURN_B }),
          ]);
        }
        if (databaseSlot.current === database) databaseSlot.current = null;
        await gateway.close();
        if (directory.startsWith(expectedDirectoryPrefix)) {
          await rm(directory, { recursive: true, force: true });
        }
        useDataStore.setState(initialDataState, true);
        useProjectStore.setState(initialProjectState, true);
        useSettingsStore.setState(initialSettingsState, true);
        useAgentEditStore.getState().clearAll();
        setAgentEditModeOverride(null);
      }
    },
    6 * 60_000,
  );
});

async function seedDatabase(database: DbClient): Promise<void> {
  await database.insert(ProjectTable).values({
    id: PROJECT_ID,
    userId: USER_ID,
    name: 'Concurrent DeepSeek canary',
    summary: '',
    kvJson: '[]',
    storylineTemplateKvJson: '[]',
    createdAt: INITIAL_REVISION,
    updatedAt: INITIAL_REVISION,
  });
  await database.insert(BookNodeTable).values({
    id: NODE_ID,
    projectId: PROJECT_ID,
    title: NODE_TITLE,
    summary: 'Synthetic same-document concurrency target.',
    bookOrder: 0,
    narrativeOrder: null,
    wordCount: 3,
    writingStatus: 'draft',
    kind: 'chapter',
    driftGroupId: null,
    deletedAt: null,
    createdAt: INITIAL_REVISION,
    updatedAt: INITIAL_REVISION,
    positionX: 0,
    positionY: 0,
  });
  await database.insert(NodeContentTable).values({
    nodeId: NODE_ID,
    contentJson: INITIAL_CONTENT_JSON,
    outlineJson: '[]',
    plotGridJson: '{}',
    createdAt: INITIAL_REVISION,
    updatedAt: INITIAL_REVISION,
  });
  await database.insert(AgentConversationTable).values(
    [CONVERSATION_A, CONVERSATION_B].map((id, index) => ({
      id,
      projectId: PROJECT_ID,
      title: `Concurrent DeepSeek canary ${index + 1}`,
      sdkSessionId: null,
      runtimeSessionId: null,
      mode: 'byok',
      messagesJson: '[]',
      deletedAt: null,
      createdAt: INITIAL_REVISION,
      updatedAt: INITIAL_REVISION,
    })),
  );
  const seedState = await createYjsProseSeedState(INITIAL_CONTENT_JSON);
  await createYjsRepository(database).upsertSnapshot(DOC_ID, seedState, {
    advanceRevision: false,
  });
}

async function hydrateStores(database: DbClient): Promise<void> {
  const project = await createProjectRepository(USER_ID, database).findById(PROJECT_ID);
  if (!project) throw new Error('The concurrent DeepSeek canary project is missing.');
  const nodes = await createBookNodeSqliteRepository(PROJECT_ID, database).findAll();
  useProjectStore.setState({ currentProject: project, projects: [project] });
  useDataStore.getState().setBookNodes(nodes);
  useDataStore.getState().setBookElementCategories([]);
  useDataStore.getState().setBookElements([]);
  useDataStore.getState().setStorylines([]);
  useDataStore.getState().setLibraryItems([]);
}

function unsupportedRendererWriteApi(): AgentWriteApi {
  return new Proxy({} as AgentWriteApi, {
    get: (_target, property) => async () => {
      throw new Error(
        `Unexpected legacy renderer write API call in prose canary: ${String(property)}`,
      );
    },
  });
}

function latestModelToolResult(request: AgentModelRequest) {
  for (let messageIndex = request.context.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const entry = request.context.messages[messageIndex];
    if (entry?.type !== 'model_message' || entry.message.role !== 'tool') continue;
    const results = entry.message.content;
    for (let resultIndex = results.length - 1; resultIndex >= 0; resultIndex -= 1) {
      const result = results[resultIndex];
      if (result) return result;
    }
  }
  return null;
}

function collectText(value: unknown): string {
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  return [
    typeof record.text === 'string' ? record.text : '',
    collectText(record.content),
  ]
    .filter(Boolean)
    .join('\n');
}

function occurrences(value: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= value.length - needle.length) {
    const next = value.indexOf(needle, offset);
    if (next < 0) break;
    count += 1;
    offset = next + needle.length;
  }
  return count;
}

async function waitWithTimeout(
  promise: Promise<void>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitWithTimeoutAndSignal(
  promise: Promise<void>,
  timeoutMs: number,
  signal: AbortSignal,
  message: string,
): Promise<void> {
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      waitWithTimeout(promise, timeoutMs, message),
      new Promise<void>((_resolve, reject) => {
        onAbort = () => reject(new Error('Concurrent DeepSeek canary was aborted.'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
