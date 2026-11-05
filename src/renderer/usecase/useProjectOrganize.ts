/**
 * Organize card: Project Home offers to fold the prose the author wrote since
 * the last organize into the project's elements, element changes and
 * relations. Nothing runs until the author opens the card; then a background
 * read-write General Agent does the work. The bell at the foot of the left
 * sidebar reports the run, Home shows the result, and a check-in that comes
 * up meanwhile waits for it.
 */
import { useEffect } from 'react';
import loglevel from 'loglevel';
import { v7 as uuidv7 } from 'uuid';
import {
  collectCheckinDelta,
  hasCheckinDelta,
  type CheckinChangedDocument,
  type CheckinDeltaFilter,
} from '../lib/agent/checkin/checkin-delta';
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
import { useProjectCheckinStore } from '../store/project-checkin-store';
import {
  newOrganizeRun,
  organizeSince,
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
  // Prose the run did not cover, or a failed run's, is offered again.
  void refreshOrganizeOffer(projectId);
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
 * The author's own prose since the horizon that carries content: null when
 * none changed, empty when the changes were formatting only.
 */
async function organizableDocuments(
  projectId: string,
  sinceIso: string,
): Promise<CheckinChangedDocument[] | null> {
  if (!(await hasCheckinDelta(projectId, sinceIso, ORGANIZE_FILTER))) return null;
  return (
    await collectCheckinDelta(projectId, sinceIso, MAX_ORGANIZE_DOCUMENTS, ORGANIZE_FILTER)
  ).filter(hasOrganizableChange);
}

/**
 * Work out Project Home's organize card from local history; no model is
 * asked. Home's check-in switch covers this card too, and it waits while the
 * selected Agent provider cannot run. Formatting-only changes move the
 * horizon without a card.
 */
export async function refreshOrganizeOffer(projectId: string): Promise<void> {
  const store = useProjectOrganizeStore.getState();
  if (store.active[projectId]) return;
  if (!useProjectCheckinStore.getState().enabled || !(await generalAgentUsable())) {
    store.setOffer(projectId, null);
    return;
  }
  const now = new Date();
  const sinceIso = organizeSince(now, readProjectOrganize(projectId));
  const documents = await organizableDocuments(projectId, sinceIso);
  // The author may have opened the card while this was reading.
  if (useProjectOrganizeStore.getState().active[projectId]) return;
  if (!documents?.length) {
    if (documents) useProjectOrganizeStore.getState().advanceHorizon(projectId, now.toISOString());
    useProjectOrganizeStore.getState().setOffer(projectId, null);
    return;
  }
  useProjectOrganizeStore.getState().setOffer(projectId, {
    sinceIso,
    documents: documents.map((document) => document.title),
  });
}

/** × on the card: the prose written so far is not organized. */
export function dismissOrganizeOffer(projectId: string): void {
  const store = useProjectOrganizeStore.getState();
  store.advanceHorizon(projectId, new Date().toISOString());
  store.setOffer(projectId, null);
}

/**
 * The author opened the organize card: hand the prose since the horizon, read
 * again now, to a background General Agent session. The project is claimed
 * synchronously so a check-in that comes up meanwhile waits. Failures to
 * start are thrown for the card to show.
 */
export async function startProjectOrganize(projectId: string): Promise<void> {
  const store = useProjectOrganizeStore.getState();
  if (store.active[projectId]) return;
  store.setActive(projectId, true);
  store.setOffer(projectId, null);
  let handedOff = false;
  try {
    const now = new Date();
    const sinceIso = organizeSince(now, readProjectOrganize(projectId));
    const documents = await organizableDocuments(projectId, sinceIso);
    if (!documents?.length) {
      if (documents) useProjectOrganizeStore.getState().advanceHorizon(projectId, now.toISOString());
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
      throw new Error('The Agent session could not start.');
    }
    const run = newOrganizeRun({
      id: uuidv7(),
      conversationId,
      startedAt: now.toISOString(),
      sinceIso,
      documents: documents.map((document) => document.title),
    });
    useProjectOrganizeStore.getState().startRun(projectId, run);
    notifyOrganize(projectId, run);
    handedOff = true;
    watchOrganizeRun(projectId, run);
  } finally {
    if (!handedOff) {
      releaseToCheckin(projectId, false);
      void refreshOrganizeOffer(projectId);
    }
  }
}

/**
 * Mounted by Project Home: settle a run a quit cut off, and keep the organize
 * card current on open, on window focus and when the check-in switch changes.
 */
export function useOrganizeOffer(projectId: string): void {
  const enabled = useProjectCheckinStore((state) => state.enabled);
  useEffect(() => {
    if (!projectId) return;
    recoverInterruptedOrganize(projectId);
    const refresh = () => void refreshOrganizeOffer(projectId);
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [projectId, enabled]);
}
