/**
 * Project Home check-in orchestration: decide when to check in, run it in the
 * background, and turn opened cards into General Agent sessions.
 */
import { useCallback, useEffect } from 'react';
import { hasCheckinDelta } from '../lib/agent/checkin/checkin-delta';
import { runProjectCheckin } from '../lib/agent/checkin/checkin-runner';
import { useAgentChatStore } from '../store/agent-chat-store';
import {
  decideCheckin,
  readProjectCheckin,
  useProjectCheckinStore,
  EMPTY_PROJECT_CHECKIN,
  type StoredCheckinCard,
} from '../store/project-checkin-store';
import { useSettingsStore } from '../store/settings-store';

/** Projects whose open was already stamped during this app run. */
const openedThisRun = new Set<string>();

export async function maybeRunProjectCheckin(
  projectId: string,
  projectName: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const store = useProjectCheckinStore.getState();
  const now = new Date();
  let previousOpenedAt = readProjectCheckin(projectId).lastOpenedAt;
  if (!openedThisRun.has(projectId)) {
    openedThisRun.add(projectId);
    previousOpenedAt = store.recordOpen(projectId, now.toISOString());
  }
  const decision = await decideCheckin({
    now,
    enabled: store.enabled,
    running: Boolean(useProjectCheckinStore.getState().running[projectId]),
    force: options.force === true,
    record: readProjectCheckin(projectId),
    previousOpenedAt,
    hasChangesSince: (sinceIso) => hasCheckinDelta(projectId, sinceIso),
  });
  if (!decision.run) return;
  if (useProjectCheckinStore.getState().running[projectId]) return;
  const startedAt = new Date().toISOString();
  store.setRunning(projectId, true);
  store.markAttempt(projectId, startedAt);
  try {
    const settings = useSettingsStore.getState();
    const outcome = await runProjectCheckin({
      projectId,
      projectName,
      sinceIso: decision.sinceIso,
      mode: decision.mode,
      provider: settings.agentProvider,
      model: settings.agentModel,
    });
    const cards: StoredCheckinCard[] = outcome.cards.map((card) => ({
      ...card,
      createdAt: startedAt,
      status: 'open',
    }));
    useProjectCheckinStore.getState().completeCheckin(projectId, startedAt, cards);
  } catch (error) {
    useProjectCheckinStore
      .getState()
      .failCheckin(projectId, error instanceof Error ? error.message : String(error));
  } finally {
    useProjectCheckinStore.getState().setRunning(projectId, false);
  }
}

/** The General Agent task for an opened check-in card. */
export function buildCheckinCardPrompt(card: StoredCheckinCard): { title: string; prompt: string } {
  return {
    title: `签到 · ${card.title}`,
    prompt: [
      '作者打开了签到时你留下的一张卡片，请接手：',
      card.title,
      card.detail,
      card.target ? `相关对象：${card.target.title}` : '',
      `任务：${card.instruction}`,
      '先读取当前作品状态核实依据，内容可能已经变化。需要作者决定的事直接问作者并等待回答；需要做的事就用你的工具完成，正文改动照常进入审阅。需要长期记住的结论写进项目记忆。',
    ].filter(Boolean).join('\n\n'),
  };
}

/**
 * Open a card: start a background General Agent session with the card as its
 * task, then show it in the view `openAgent` returns.
 */
export async function startCheckinCardSession(
  projectId: string,
  card: StoredCheckinCard,
  openAgent: () => string,
): Promise<string> {
  const { title, prompt } = buildCheckinCardPrompt(card);
  const chat = useAgentChatStore.getState();
  if (chat.boundProjectId !== projectId) {
    chat.bindProject(projectId, { restoreLastConversation: false });
  }
  let conversationId: string | null = null;
  await useAgentChatStore.getState().send({
    runtimePrompt: prompt,
    background: { title },
    toolAccess: 'read_write',
    onStarted: (id) => {
      conversationId = id;
    },
  });
  if (!conversationId) throw new Error('The Agent session could not start.');
  useProjectCheckinStore.getState().updateCard(projectId, card.id, {
    status: 'started',
    conversationId,
  });
  await openCheckinConversation(projectId, conversationId, openAgent);
  return conversationId;
}

export async function openCheckinConversation(
  projectId: string,
  conversationId: string,
  openAgent: () => string,
): Promise<void> {
  const chat = useAgentChatStore.getState();
  if (chat.boundProjectId !== projectId) {
    chat.bindProject(projectId, { restoreLastConversation: false });
  }
  const viewId = openAgent();
  await useAgentChatStore.getState().loadConversation(conversationId, viewId);
}

/** Start a fresh, author-visible conversation from Project Home. */
export async function startProjectHomeConversation(
  projectId: string,
  text: string,
  openAgent: () => string,
): Promise<void> {
  const prompt = text.trim();
  if (!prompt) return;
  const chat = useAgentChatStore.getState();
  if (chat.boundProjectId !== projectId) {
    chat.bindProject(projectId, { restoreLastConversation: false });
  }
  const viewId = openAgent();
  useAgentChatStore.getState().newConversation(viewId);
  useAgentChatStore.getState().setPrompt(prompt, viewId);
  await useAgentChatStore.getState().send({ viewId, toolAccess: 'read_write' });
}

/** Mounted by Project Home: checks in on open and when the window regains focus. */
export function useProjectCheckin(projectId: string | null, projectName: string) {
  const record = useProjectCheckinStore((state) =>
    projectId ? (state.projects[projectId] ?? EMPTY_PROJECT_CHECKIN) : EMPTY_PROJECT_CHECKIN,
  );
  const running = useProjectCheckinStore((state) =>
    projectId ? Boolean(state.running[projectId]) : false,
  );
  const enabled = useProjectCheckinStore((state) => state.enabled);

  useEffect(() => {
    if (!projectId) return;
    const check = () => void maybeRunProjectCheckin(projectId, projectName);
    check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [projectId, projectName]);

  const runNow = useCallback(() => {
    if (projectId) void maybeRunProjectCheckin(projectId, projectName, { force: true });
  }, [projectId, projectName]);

  return { record, running, enabled, runNow };
}
