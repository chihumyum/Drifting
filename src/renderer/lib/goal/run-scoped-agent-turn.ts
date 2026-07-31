/**
 * /goal 一键演化 — the EDITOR leaf (GOAL-EVOLVE.md §5 Phase 3).
 *
 * Drives ONE isolated agent turn over a single chapter to resolve the critic's
 * contradiction spots, then harvests what it changed from the agent-edit-store.
 * The turnId is NOT registered with the chat store, so the chat UI ignores this
 * stream. Edits land in live Yjs via the agent's prose tools and stage as pending
 * (soft-approval) for the final human gate — nothing auto-commits.
 *
 * Reserved for a future General Agent transport. The current Tauri build reports
 * that capability as unavailable and uses runShadowEditTurn instead.
 */
import { v7 as uuidv7 } from 'uuid';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { useSettingsStore } from '../../store/settings-store';
import { useProjectStore } from '../../store/project-store';
import { resolveWritingLanguage } from '../ai/output-language';
import { entityKey } from '../agent/tool-entity-ref';
import { generalAgentTransport } from '../agent/transport';
import { buildGeneralAgentProjectContext } from '../agent/product-project-context';
import { buildEditInstruction } from './edit-prompt';
import type { AgenticTraceStep } from '../ai/shadow-rules';
import type { ElementChange, ContradictionSpot, EditTurnResult } from './types';

// A remote/local Agent transport reads prose via its tools, so it receives the
// shared task instruction plus a tool tail rather than preloaded blocks.
function buildEditPrompt(
  chapterTitle: string,
  change: ElementChange,
  spots: ContradictionSpot[],
): string {
  return `${buildEditInstruction(chapterTitle, change, spots)}\n\n用 edit_block / edit_blocks 直接改对应段落（按段编号定位）。改完即可，无需解释。`;
}

export async function runScopedAgentTurn(
  chapterId: string,
  chapterTitle: string,
  change: ElementChange,
  spots: ContradictionSpot[],
  signal?: AbortSignal,
  onTrace?: (step: AgenticTraceStep) => void,
): Promise<EditTurnResult> {
  if (spots.length === 0) return { chapterId, ok: true, editedBlockIds: [] };
  if (signal?.aborted) return { chapterId, ok: false, editedBlockIds: [], error: 'aborted' };
  if (!generalAgentTransport.capability.available) {
    return {
      chapterId,
      ok: false,
      editedBlockIds: [],
      error: generalAgentTransport.capability.reason ?? 'General Agent is unavailable',
    };
  }

  const settings = useSettingsStore.getState();
  const projectId = useProjectStore.getState().currentProject?.id;
  const project = useProjectStore.getState().currentProject;
  if (!projectId) {
    return {
      chapterId,
      ok: false,
      editedBlockIds: [],
      error: 'No active project for the Agent turn',
    };
  }
  const turnId = uuidv7();
  const key = entityKey('node', chapterId);
  const projectContext = buildGeneralAgentProjectContext(projectId, project);

  // Blocks already pending before this turn — so we report only what THIS turn added.
  const before = new Set(
    (useAgentEditStore.getState().pending[key]?.changes ?? []).map((c) => c.blockId),
  );

  let lastError: string | undefined;
  // STOP aborts the owning transport turn. Edits already landed in Yjs stay staged.
  let onAbort: (() => void) | undefined;
  // Pair tool_use → tool_result by id so the trace shows one entry per completed
  // tool call (name, args peek, ok/error) — same shape the Shadow-FC editor emits.
  const inFlight = new Map<string, string>();
  const summarizeInput = (input: unknown): string | undefined => {
    if (input === undefined || input === null) return undefined;
    try {
      const s = typeof input === 'string' ? input : JSON.stringify(input);
      return s.length > 120 ? `${s.slice(0, 120)}…` : s;
    } catch {
      return undefined;
    }
  };
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let closeSubscription: () => void = () => undefined;
  const subscription = generalAgentTransport.subscribeEvents((env) => {
    if (env.turnId !== turnId) return;
    const ev = env.event;
    if (ev.type === 'tool_use') {
      const args = summarizeInput(ev.input);
      inFlight.set(ev.id, args ? `${ev.name}(${args})` : ev.name);
      onTrace?.({ label: `调用 ${ev.name}`, calls: [{ tool: ev.name, args, status: 'ok' }] });
    }
    if (ev.type === 'tool_result' && !ev.ok) {
      onTrace?.({
        label: `工具失败：${inFlight.get(ev.id) ?? ev.id}`,
        detail: ev.text.slice(0, 200),
      });
    }
    if (ev.type === 'error') lastError = ev.message;
    if (ev.type === 'done') {
      closeSubscription();
      resolveDone();
    }
  });
  if (!subscription.ok) {
    return { chapterId, ok: false, editedBlockIds: [], error: subscription.error };
  }
  let subscriptionClosed = false;
  closeSubscription = () => {
    if (subscriptionClosed) return;
    subscriptionClosed = true;
    subscription.value();
  };
  if (signal) {
    onAbort = () => {
      closeSubscription();
      void generalAgentTransport.abort();
      lastError = lastError ?? 'aborted';
      resolveDone();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      signal.removeEventListener('abort', onAbort);
      return { chapterId, ok: false, editedBlockIds: [], error: 'aborted' };
    }
  }

  const r = await generalAgentTransport.start({
    prompt: buildEditPrompt(chapterTitle, change, spots),
    route: { kind: 'goal', projectId, chapterId },
    projectId,
    mode: settings.agentAuth,
    model: settings.agentModel,
    effort: settings.agentEffort,
    thinking: settings.agentThinking,
    toolSearch: settings.agentToolSearch,
    ...projectContext,
    writingLanguage: projectId ? resolveWritingLanguage(projectId) : undefined,
    newConversation: true,
    turnId,
  });
  if (!r.ok) {
    closeSubscription();
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    return { chapterId, ok: false, editedBlockIds: [], error: r.error };
  }

  await done;
  closeSubscription();
  if (onAbort) signal?.removeEventListener('abort', onAbort);

  const after = useAgentEditStore.getState().pending[key]?.changes ?? [];
  const editedBlockIds = after.map((c) => c.blockId).filter((id) => !before.has(id));
  return { chapterId, ok: !lastError, editedBlockIds, error: lastError };
}
