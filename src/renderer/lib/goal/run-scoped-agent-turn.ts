/**
 * /goal 一键演化 — the EDITOR leaf (GOAL-EVOLVE.md §5 Phase 3).
 *
 * Drives ONE isolated agent turn over a single chapter to resolve the critic's
 * contradiction spots, then harvests what it changed from the agent-edit-store.
 * The turnId is NOT registered with the chat store, so the chat UI ignores this
 * stream. Edits land in live Yjs via the agent's prose tools and stage as pending
 * (soft-approval) for the final human gate — nothing auto-commits.
 *
 * First-slice assumptions (see GOAL-EVOLVE.md §11 follow-ups):
 *  - EXCLUSIVE use of the singleton main-process agent (no concurrent chat turn).
 *  - Runs from within the open project (useAgentToolBridge mounted → edits route).
 */
import { v7 as uuidv7 } from 'uuid';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { useSettingsStore } from '../../store/settings-store';
import { useProjectStore } from '../../store/project-store';
import { resolveWritingLanguage } from '../ai/output-language';
import { parseKv } from '../../domain/kv';
import { entityKey } from '../agent/tool-entity-ref';
import { buildEditInstruction } from './edit-prompt';
import type { AgenticTraceStep } from '../ai/shadow-rules';
import type { ElementChange, ContradictionSpot, EditTurnResult } from './types';

// The Agent-SDK editor reads the prose via its own tools, so it gets the shared
// task instruction + a tool tail (no pre-loaded blocks; the SDK agent read_node's).
function buildEditPrompt(chapterTitle: string, change: ElementChange, spots: ContradictionSpot[]): string {
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
  const api = window.electronAPI?.agent;
  if (!api) return { chapterId, ok: false, editedBlockIds: [], error: 'agent api unavailable' };
  if (spots.length === 0) return { chapterId, ok: true, editedBlockIds: [] };
  if (signal?.aborted) return { chapterId, ok: false, editedBlockIds: [], error: 'aborted' };

  const settings = useSettingsStore.getState();
  const projectId = useProjectStore.getState().currentProject?.id;
  const project = useProjectStore.getState().currentProject;
  const turnId = uuidv7();
  const key = entityKey('node', chapterId);

  // Blocks already pending before this turn — so we report only what THIS turn added.
  const before = new Set(
    (useAgentEditStore.getState().pending[key]?.changes ?? []).map((c) => c.blockId),
  );

  let lastError: string | undefined;
  // STOP → abort the singleton main-process agent (evolve assumes exclusive use of
  // it) and stop awaiting. Edits already landed in Yjs stay staged.
  let onAbort: (() => void) | undefined;
  // Pair tool_use → tool_result by id so the trace shows one entry per completed
  // SDK tool call (name, args peek, ok/error) — same shape the shadow-FC editor emits.
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
  const done = new Promise<void>((resolve) => {
    const off = api.onEvent((env) => {
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
        off();
        resolve();
      }
    });
    if (signal) {
      onAbort = () => {
        off();
        void api.abort();
        lastError = lastError ?? 'aborted';
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  const r = await api.start({
    prompt: buildEditPrompt(chapterTitle, change, spots),
    projectId,
    mode: settings.agentAuth,
    model: settings.agentModel,
    effort: settings.agentEffort,
    thinking: settings.agentThinking,
    toolSearch: settings.agentToolSearch,
    writingLanguage: projectId ? resolveWritingLanguage(projectId) : undefined,
    projectFacts: project ? parseKv(project.kvJson) : [],
    newConversation: true,
    turnId,
  });
  if (!r.ok) {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    return { chapterId, ok: false, editedBlockIds: [], error: r.error };
  }

  await done;
  if (onAbort) signal?.removeEventListener('abort', onAbort);

  const after = useAgentEditStore.getState().pending[key]?.changes ?? [];
  const editedBlockIds = after.map((c) => c.blockId).filter((id) => !before.has(id));
  return { chapterId, ok: !lastError, editedBlockIds, error: lastError };
}
