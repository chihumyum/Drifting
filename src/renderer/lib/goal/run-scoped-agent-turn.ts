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
import type { ElementChange, ContradictionSpot, EditTurnResult } from './types';

function buildEditPrompt(
  chapterTitle: string,
  change: ElementChange,
  spots: ContradictionSpot[],
): string {
  const field = change.field ? `（${change.field}）` : '';
  const list = spots
    .map((s, i) => {
      const where = s.blockIds.length ? `第 ${s.blockIds.join('、')} 块` : '本章（整章级）';
      return `${i + 1}. ${where}：${s.reason}`;
    })
    .join('\n');
  return [
    `设定《${change.elementName}》${field}已更新：`,
    `  旧值：${change.oldSetting || '（未给）'}`,
    `  新值：${change.newSetting}`,
    '',
    change.profile
      ? `该设定的当前完整内容（已提供，无需再 read_element 查）：\n${change.profile}\n`
      : '',
    `请在《${chapterTitle}》中，对下列与新设定冲突的位置做【最小】改动，使正文符合新设定。只改真正冲突处，不要顺手改写无关内容，不要新增设定以外的事实。`,
    '',
    '需修正的冲突：',
    list,
    '',
    '用 edit_block / edit_blocks 直接改对应段落（按段编号定位）。改完即可，无需解释。',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export async function runScopedAgentTurn(
  chapterId: string,
  chapterTitle: string,
  change: ElementChange,
  spots: ContradictionSpot[],
): Promise<EditTurnResult> {
  const api = window.electronAPI?.agent;
  if (!api) return { chapterId, ok: false, editedBlockIds: [], error: 'agent api unavailable' };
  if (spots.length === 0) return { chapterId, ok: true, editedBlockIds: [] };

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
  const done = new Promise<void>((resolve) => {
    const off = api.onEvent((env) => {
      if (env.turnId !== turnId) return;
      const ev = env.event;
      if (ev.type === 'error') lastError = ev.message;
      if (ev.type === 'done') {
        off();
        resolve();
      }
    });
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
  if (!r.ok) return { chapterId, ok: false, editedBlockIds: [], error: r.error };

  await done;

  const after = useAgentEditStore.getState().pending[key]?.changes ?? [];
  const editedBlockIds = after.map((c) => c.blockId).filter((id) => !before.has(id));
  return { chapterId, ok: !lastError, editedBlockIds, error: lastError };
}
