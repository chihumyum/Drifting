/**
 * Runs one Project Home check-in: gather the change digest and memory, make a
 * single forced-tool model request with the author's selected Agent provider,
 * apply the memory upkeep it returns, and hand back the cards. The manuscript
 * is never written here; accepted cards go through ordinary Agent sessions.
 */
import { v7 as uuidv7 } from 'uuid';
import { isChapter } from '../../../domain/book-node';
import { extractTextFromCommentBody } from '../../../domain/comment';
import { useDataStore } from '../../../store/data-store';
import {
  createMemory,
  loadActiveMemories,
  softDeleteMemory,
  updateMemoryBody,
} from '../../../usecase/useAgentMemory';
import {
  loadAgentWorkingMemory,
  saveAgentWorkingMemory,
} from '../../../usecase/useAgentWorkingMemory';
import {
  AGENT_WORKING_MEMORY_NOTICE_TOKENS,
  EMPTY_AGENT_WORKING_MEMORY_MD,
  type AgentWorkingMemorySnapshot,
} from '../../../domain/agent-working-memory';
import { applyAgentWorkingMemoryEdits } from '../runtime/working-memory-document';
import { DriftingAgentModelDriver } from '../runtime/drivers';
import type { AgentModelDriver } from '../runtime/types';
import { collectCheckinDelta, type CheckinChangedDocument } from './checkin-delta';
import {
  buildCheckinContext,
  CHECKIN_SYSTEM_PROMPT,
  CHECKIN_TOOL_DESCRIPTION,
  CHECKIN_TOOL_NAME,
  checkinToolSchema,
  parseCheckinToolArguments,
  type CheckinCard,
} from './checkin-prompt';

const CHECKIN_TIMEOUT_MS = 120_000;
const CHECKIN_MAX_OUTPUT_TOKENS = 6_000;
const MAX_OPEN_TODOS = 20;

export interface ProjectCheckinRequest {
  projectId: string;
  projectName: string;
  sinceIso: string;
  mode: 'changes' | 'resume';
  provider: string;
  model: string;
  signal?: AbortSignal;
  driver?: AgentModelDriver;
  now?: () => Date;
}

export interface ProjectCheckinOutcome {
  cards: CheckinCard[];
  documents: number;
  memory: { added: number; updated: number; deleted: number; workingMemoryUpdated: boolean };
}

function openTodos(projectId: string): string[] {
  return useDataStore
    .getState()
    .comments.filter(
      (comment) =>
        comment.projectId === projectId && comment.kind === 'todo' && comment.status === 'open',
    )
    .map((comment) => extractTextFromCommentBody(comment.bodyJson).replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .slice(0, MAX_OPEN_TODOS)
    .map((todo) => (todo.length > 160 ? `${todo.slice(0, 160)}…` : todo));
}

function chapterTitles(projectId: string): string[] {
  return useDataStore
    .getState()
    .bookNodes.filter((node) => node.projectId === projectId)
    .filter(isChapter)
    .sort((a, b) => a.bookOrder - b.bookOrder)
    .map((node) => node.title)
    .filter(Boolean)
    .slice(0, 80);
}

async function requestCheckin(
  driver: AgentModelDriver,
  request: ProjectCheckinRequest,
  context: string,
  signal: AbortSignal,
): Promise<string> {
  const turnId = uuidv7();
  let callId: string | null = null;
  let argumentsJson = '';
  for await (const event of driver.stream({
    sessionId: `project-checkin:${request.projectId}`,
    turnId,
    iteration: 1,
    lifecycle: 'single_request',
    provider: request.provider,
    model: request.model,
    context: {
      systemPrompt: CHECKIN_SYSTEM_PROMPT,
      messages: [
        {
          type: 'model_message',
          sourceIds: [`project-checkin:${turnId}`],
          message: { role: 'user', content: context },
        },
      ],
    },
    tools: [
      {
        name: CHECKIN_TOOL_NAME,
        description: CHECKIN_TOOL_DESCRIPTION,
        inputSchema: checkinToolSchema,
      },
    ],
    toolChoice: { force: CHECKIN_TOOL_NAME },
    maxOutputTokens: CHECKIN_MAX_OUTPUT_TOKENS,
    signal,
  })) {
    if (event.type === 'tool_call_start') {
      if (event.name !== CHECKIN_TOOL_NAME || callId !== null) {
        throw new Error('The check-in returned an unexpected tool call.');
      }
      callId = event.callId;
    } else if (event.type === 'tool_args_delta' && event.callId === callId) {
      argumentsJson += event.delta;
    }
  }
  if (!callId) throw new Error('The check-in returned no result.');
  return argumentsJson;
}

/** Documents larger than this stay out of the check-in request. */
const CHECKIN_WORKING_MEMORY_TOKENS = AGENT_WORKING_MEMORY_NOTICE_TOKENS[0];

async function applyMemoryUpkeep(
  projectId: string,
  parsed: ReturnType<typeof parseCheckinToolArguments>,
  workingMemory: AgentWorkingMemorySnapshot,
  workingMemoryIncluded: boolean,
): Promise<ProjectCheckinOutcome['memory']> {
  const outcome = { added: 0, updated: 0, deleted: 0, workingMemoryUpdated: false };
  for (const body of parsed.memoryAdd) {
    await createMemory(projectId, { kind: 'preference', body, source: 'agent', status: 'active' });
    outcome.added += 1;
  }
  for (const { memoryId, body } of parsed.memoryUpdate) {
    if (await updateMemoryBody(projectId, memoryId, body)) outcome.updated += 1;
  }
  for (const memoryId of parsed.memoryDelete) {
    await softDeleteMemory(projectId, memoryId);
    outcome.deleted += 1;
  }
  if (workingMemoryIncluded && parsed.workingMemoryEdits.length > 0) {
    // Revision CAS: a conversation that edited meanwhile wins, and an edit
    // whose passage no longer matches leaves the document untouched.
    try {
      await saveAgentWorkingMemory(projectId, {
        contentMd: applyAgentWorkingMemoryEdits(
          workingMemory.exists ? workingMemory.contentMd : EMPTY_AGENT_WORKING_MEMORY_MD,
          parsed.workingMemoryEdits,
        ),
        expectedRevision: workingMemory.revision,
        updatedBy: 'agent',
      });
      outcome.workingMemoryUpdated = true;
    } catch {
      outcome.workingMemoryUpdated = false;
    }
  }
  return outcome;
}

export async function runProjectCheckin(
  request: ProjectCheckinRequest,
): Promise<ProjectCheckinOutcome> {
  const now = request.now ?? (() => new Date());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECKIN_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  if (request.signal?.aborted) controller.abort();
  request.signal?.addEventListener('abort', forwardAbort, { once: true });
  const signal = controller.signal;
  try {
    const documents: CheckinChangedDocument[] = await collectCheckinDelta(
      request.projectId,
      request.sinceIso,
    );
    const memories = await loadActiveMemories(request.projectId);
    const workingMemory = await loadAgentWorkingMemory(request.projectId);
    const workingMemoryIncluded = workingMemory.approxTokens <= CHECKIN_WORKING_MEMORY_TOKENS;
    const context = buildCheckinContext({
      projectName: request.projectName,
      nowIso: now().toISOString(),
      sinceIso: request.sinceIso,
      mode: request.mode,
      documents,
      projectMemory: [...memories]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((memory) => ({ id: memory.id, body: memory.body })),
      workingMemory: workingMemoryIncluded ? workingMemory.contentMd : null,
      openTodos: openTodos(request.projectId),
      chapterTitles: chapterTitles(request.projectId),
    });
    const driver =
      request.driver ??
      new DriftingAgentModelDriver({
        featureLabel: 'Project check-in',
        logTag: 'project-checkin',
        feature: 'project-checkin',
      });
    const argumentsJson = await requestCheckin(driver, request, context, signal);
    const parsed = parseCheckinToolArguments(
      argumentsJson,
      documents,
      new Set(memories.map((memory) => memory.id)),
    );
    const memory = await applyMemoryUpkeep(
      request.projectId,
      parsed,
      workingMemory,
      workingMemoryIncluded,
    );
    return {
      cards: parsed.cards.map((card) => ({ ...card, id: uuidv7() })),
      documents: documents.length,
      memory,
    };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', forwardAbort);
  }
}
