/**
 * Organize on return: when the author comes back to the app, a background
 * read-write General Agent folds the prose they wrote last time into the
 * project's elements, element changes and relations. The bell at the foot of
 * the left sidebar reports the run and leads to Project Home, which shows the
 * result. The check-in waits for it and runs after it.
 */
import { useEffect } from 'react';
import loglevel from 'loglevel';
import { v7 as uuidv7 } from 'uuid';
import { collectCheckinDelta, hasCheckinDelta, type CheckinDeltaFilter } from '../lib/agent/checkin/checkin-delta';
import {
  buildOrganizeTask,
  hasOrganizableChange,
  summarizeOrganizeTranscript,
  type OrganizeCounts,
} from '../lib/agent/organize/organize-task';
import { collectTurnEntityRefs } from '../lib/agent/tool-entity-ref';
import { canAgentProviderRun } from '../lib/agent/agent-provider-readiness';
import { generalAgentTransport } from '../lib/agent/transport';
import { i18next } from '../lib/i18n';
import { useAgentChatStore } from '../store/agent-chat-store';
import { useNotificationStore } from '../store/notification-store';
import {
  decideOrganize,
  newOrganizeRun,
  ORGANIZE_AWAY_MS,
  readProjectOrganize,
  useProjectOrganizeStore,
  type OrganizeRun,
  type OrganizeRunEntity,
} from '../store/project-organize-store';
import { useProjectStore } from '../store/project-store';
import { useSettingsStore } from '../store/settings-store';
import { maybeRunProjectCheckin } from './useProjectCheckin';

const log = loglevel.getLogger('projectOrganize');
log.setLevel(loglevel.levels.WARN);

/** Only the author's own manuscript prose is organized. */
const ORGANIZE_FILTER: CheckinDeltaFilter = { sources: ['user'], objectKinds: ['chapter', 'idea'] };
const MAX_ORGANIZE_DOCUMENTS = 12;
/** A relation names both ends without changing either. */
const RELATION_TOOLS = new Set(['create_relation', 'update_relation', 'delete_relation']);

/** Runs whose conversations this app run is watching. */
const watchedRuns = new Set<string>();
/** Projects whose open already counted as a return in this app run. */
const openedThisRun = new Set<string>();

function projectNameOf(projectId: string): string {
  const state = useProjectStore.getState();
  return (
    (state.currentProject?.id === projectId ? state.currentProject.name : null) ??
    state.projects.find((project) => project.id === projectId)?.name ??
    ''
  );
}

export function describeOrganizeCounts(counts: OrganizeCounts): string {
  const parts = [
    counts.elementsCreated > 0 && i18next.t('organize.counts.created', { count: counts.elementsCreated }),
    counts.elementsUpdated > 0 && i18next.t('organize.counts.updated', { count: counts.elementsUpdated }),
    counts.patches > 0 && i18next.t('organize.counts.patches', { count: counts.patches }),
    counts.relations > 0 && i18next.t('organize.counts.relations', { count: counts.relations }),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : i18next.t('organize.counts.none');
}

function notifyOrganize(projectId: string, run: OrganizeRun): void {
  const name = projectNameOf(projectId);
  const state =
    run.status === 'running'
      ? 'started'
      : run.status === 'completed'
        ? 'completed'
        : run.status === 'interrupted'
          ? 'stopped'
          : 'failed';
  useNotificationStore.getState().ingest({
    id: `agent-organize:${run.id}`,
    source: 'agent-organize',
    state,
    title: i18next.t(`organize.notify.${run.status}`),
    detail:
      [name || null, run.status === 'completed' ? describeOrganizeCounts(run.counts) : null]
        .filter(Boolean)
        .join(' · ') || undefined,
    outcome: run.status === 'completed' ? 'ok' : run.status === 'failed' ? 'error' : undefined,
    error: run.status === 'failed' ? (run.error ?? undefined) : undefined,
    projectHomeId: projectId,
    at: Date.now(),
  });
}

/** A project whose selected Agent provider cannot run is skipped quietly, not failed. */
async function generalAgentUsable(): Promise<boolean> {
  if (!generalAgentTransport.capability.available) return false;
  return canAgentProviderRun(useSettingsStore.getState().agentProvider);
}

function releaseToCheckin(projectId: string, afterOrganize: boolean): void {
  useProjectOrganizeStore.getState().setActive(projectId, false);
  void maybeRunProjectCheckin(projectId, projectNameOf(projectId), { afterOrganize });
}

/** Still working: a running turn, or a continuation about to start one. */
function conversationBusy(conversationId: string): boolean {
  const state = useAgentChatStore.getState();
  if (state.runningTurns[conversationId]) return true;
  const status = state.runs[conversationId]?.automaticContinuation.status;
  return status === 'evaluating' || status === 'scheduled';
}

function settleRun(projectId: string, run: OrganizeRun): void {
  const live = useAgentChatStore.getState().runs[run.conversationId];
  const messages = live?.transcript.toArray() ?? [];
  const { summary, counts } = summarizeOrganizeTranscript(messages);
  const entities: OrganizeRunEntity[] = collectTurnEntityRefs(
    messages.filter((message) => !(message.kind === 'tool' && RELATION_TOOLS.has(message.name))),
  )
    .filter((ref) => ref.op === 'create' || ref.op === 'write')
    .map((ref) => ({ entityType: ref.entityType, id: ref.id, op: ref.op as 'create' | 'write' }));
  const outcome = live?.lastTerminal?.outcome;
  const status = outcome === 'completed' ? 'completed' : outcome === 'aborted' || !live ? 'interrupted' : 'failed';
  const finishedAt = new Date().toISOString();
  useProjectOrganizeStore.getState().finishRun(projectId, run.id, {
    status,
    finishedAt,
    summary,
    counts,
    entities,
    error: status === 'failed' ? (live?.lastTerminal?.message ?? outcome ?? null) : null,
  });
  const settled = readProjectOrganize(projectId).run;
  if (settled?.id === run.id) notifyOrganize(projectId, settled);
  releaseToCheckin(projectId, status === 'completed');
}

/** Follow a run's conversation until it stops, then record and report it. */
function watchOrganizeRun(projectId: string, run: OrganizeRun): void {
  if (watchedRuns.has(run.id)) return;
  watchedRuns.add(run.id);
  if (!conversationBusy(run.conversationId)) {
    settleRun(projectId, run);
    return;
  }
  const unsubscribe = useAgentChatStore.subscribe(() => {
    if (conversationBusy(run.conversationId)) return;
    unsubscribe();
    settleRun(projectId, run);
  });
}

/**
 * A run recorded as running that no conversation in this app run carries was
 * cut off by a quit or reload; its horizon stays put so the next return
 * organizes that prose again.
 */
export function recoverInterruptedOrganize(projectId: string): void {
  const run = readProjectOrganize(projectId).run;
  if (!run || run.status !== 'running' || watchedRuns.has(run.id)) return;
  if (conversationBusy(run.conversationId)) {
    useProjectOrganizeStore.getState().setActive(projectId, true);
    watchOrganizeRun(projectId, run);
    return;
  }
  useProjectOrganizeStore.getState().finishRun(projectId, run.id, {
    status: 'interrupted',
    finishedAt: new Date().toISOString(),
  });
}

/**
 * Organize the author's prose since the horizon, if any. The project is
 * claimed synchronously so a check-in triggered by the same return waits.
 */
export async function maybeRunProjectOrganize(
  projectId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const store = useProjectOrganizeStore.getState();
  if (store.active[projectId]) return;
  if (!store.enabled && !options.force) return;
  store.setActive(projectId, true);
  let handedOff = false;
  try {
    const now = new Date();
    const decision = await decideOrganize({
      now,
      enabled: store.enabled,
      force: options.force === true,
      record: readProjectOrganize(projectId),
      hasChangesSince: (sinceIso) => hasCheckinDelta(projectId, sinceIso, ORGANIZE_FILTER),
    });
    if (!decision.run || !(await generalAgentUsable())) return;
    const documents = (
      await collectCheckinDelta(projectId, decision.sinceIso, MAX_ORGANIZE_DOCUMENTS, ORGANIZE_FILTER)
    ).filter(hasOrganizableChange);
    if (documents.length === 0) {
      useProjectOrganizeStore.getState().advanceHorizon(projectId, now.toISOString());
      return;
    }
    const task = buildOrganizeTask(documents);
    const chat = useAgentChatStore.getState();
    if (chat.boundProjectId !== projectId) {
      chat.bindProject(projectId, { restoreLastConversation: false });
    }
    let conversationId: string | null = null;
    await useAgentChatStore.getState().send({
      runtimePrompt: task.prompt,
      background: { title: task.title },
      toolAccess: 'read_write',
      onStarted: (id) => {
        conversationId = id;
      },
    });
    if (!conversationId) {
      log.warn('Organize session did not start', projectId);
      useProjectOrganizeStore.getState().failAttempt(projectId, new Date().toISOString());
      return;
    }
    const run = newOrganizeRun({
      id: uuidv7(),
      conversationId,
      startedAt: now.toISOString(),
      sinceIso: decision.sinceIso,
      documents: documents.map((document) => document.title),
    });
    useProjectOrganizeStore.getState().startRun(projectId, run);
    notifyOrganize(projectId, run);
    handedOff = true;
    watchOrganizeRun(projectId, run);
  } catch (error) {
    log.error('Organize failed to start', projectId, error);
    useProjectOrganizeStore.getState().failAttempt(projectId, new Date().toISOString());
  } finally {
    if (!handedOff) releaseToCheckin(projectId, false);
  }
}

/**
 * Mounted by the desktop workspace. The first open of a project in an app
 * run is a return; so is the first focus, pointer or key after being away
 * (window in the background, or no input) for `ORGANIZE_AWAY_MS`.
 */
export function useOrganizeOnReturn(projectId: string): void {
  useEffect(() => {
    recoverInterruptedOrganize(projectId);
    let lastPresenceAt = Date.now();
    if (!openedThisRun.has(projectId)) {
      openedThisRun.add(projectId);
      void maybeRunProjectOrganize(projectId);
    }
    const onPresence = () => {
      const now = Date.now();
      const returned = now - lastPresenceAt >= ORGANIZE_AWAY_MS;
      lastPresenceAt = now;
      if (returned) void maybeRunProjectOrganize(projectId);
    };
    const onLeave = () => {
      lastPresenceAt = Date.now();
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? onPresence() : onLeave());
    window.addEventListener('focus', onPresence);
    window.addEventListener('blur', onLeave);
    window.addEventListener('pointerdown', onPresence, { capture: true, passive: true });
    window.addEventListener('keydown', onPresence, { capture: true });
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onPresence);
      window.removeEventListener('blur', onLeave);
      window.removeEventListener('pointerdown', onPresence, { capture: true });
      window.removeEventListener('keydown', onPresence, { capture: true });
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [projectId]);
}
