import { AgentMcpAccessSettings } from '../../../components/agent/AgentMcpAccessSettings';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../../store/project-store';
import { useAgentChatStore } from '../../../store/agent-chat-store';
import { createAgentUsageHistoryController } from '../agent-usage-history';
import { requestConfirmation } from '../../../store/confirmation-store';
import { createAgentConversationRepository, type AgentConversationUsage } from '../../../sqlite-repo/agent-conversation-repo';
import { ProjectMemoryEditor } from '../../agent/ProjectMemoryEditor';
import { AgentExtensionsSettings } from '../../../components/agent/AgentExtensionsSettings';
import { generalAgentTransport } from '../../../lib/agent/transport';
import {
  AGENT_TURN_ITERATION_LIMIT_OPTIONS,
  useSettingsStore,
} from '../../../store/settings-store';
import {
  SettingsButton,
  SettingsGroupHeader,
  SettingsNote,
  SettingsPanelHeader,
  SettingsSectionHeader,
  SettingsSegment,
  SettingsSelect,
  type SettingsRegisterRef,
} from '../SettingsPrimitives';
import { BrushIcon } from '../../../components/ui/BrushIcon';
import { EmptyState } from '../../../components/ui/EmptyState';

const fmtUsageTok = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
      : String(n);
const fmtUsageUsd = (n: number): string => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;
const fmtConvTime = (iso: string): string => {
  try {
    const d = new Date(iso);
    const now = new Date();
    return d.toDateString() === now.toDateString()
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
  } catch {
    return '';
  }
};

// PROJECT_MEMORY.md for the open project — the same editor as Project Home.
function AgentMemorySection({ open }: { open: boolean }) {
  const { t } = useTranslation();
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  if (!open || !projectId) return null;
  return (
    <div className="set-sec">
      <SettingsSectionHeader title={t('settings.agentMemory.title')} hint="PROJECT_MEMORY.md" />
      <ProjectMemoryEditor projectId={projectId} compact />
    </div>
  );
}

// Per-turn hard brake on the model-iteration loop. The value is read by the
// transport at every turn start, so a change here applies to the next turn
// without a reload. `null` keeps the historical unlimited behavior.
function AgentLimitsSection() {
  const { t } = useTranslation();
  const limit = useSettingsStore((s) => s.agentTurnIterationLimit);
  const setLimit = useSettingsStore((s) => s.setAgentTurnIterationLimit);
  // A persisted custom value stays selectable even if it is not a preset.
  const options =
    limit !== null && !AGENT_TURN_ITERATION_LIMIT_OPTIONS.includes(limit)
      ? [...AGENT_TURN_ITERATION_LIMIT_OPTIONS, limit].sort((a, b) => a - b)
      : AGENT_TURN_ITERATION_LIMIT_OPTIONS;
  return (
    <div className="set-sec">
      <SettingsSectionHeader title={t('settings.agentLimits.title')} hint="LIMITS" />
      <p className="set-row__desc">{t('settings.agentLimits.desc')}</p>
      <div className="set-agent-limit">
        <span className="set-agent-limit__label">{t('settings.agentLimits.iterationLabel')}</span>
        <SettingsSelect
          value={limit === null ? 'unlimited' : String(limit)}
          onChange={(next) => setLimit(next === 'unlimited' ? null : Number(next))}
          ariaLabel={t('settings.agentLimits.iterationLabel')}
          width={160}
          options={[
            ...options.map((value) => ({
              value: String(value),
              label: t('settings.agentLimits.iterationOption', { value }),
            })),
            { value: 'unlimited', label: t('settings.agentLimits.unlimited') },
          ]}
        />
      </div>
      {limit === null && <SettingsNote className="set-agent-limit__hint">{t('settings.agentLimits.unlimitedHint')}</SettingsNote>}
    </div>
  );
}

function monthStartISO(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

function AgentUsageSection({ open }: { open: boolean }) {
  const { t } = useTranslation();
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const [snapshot, setSnapshot] = useState<{ projectId: string | null; scope: 'month' | 'all'; rows: AgentConversationUsage[] }>({ projectId: null, scope: 'all', rows: [] });
  // Two reporting windows: this-month vs all-time.
  // Defaults to all-time: usage entries written before per-turn timestamps existed
  // are undated, so they only surface under 累计 — landing there shows real numbers
  // instead of a misleading 本月 = 0 until fresh, dated turns accrue.
  const [scope, setScope] = useState<'month' | 'all'>('all');
  const rows = snapshot.projectId === projectId && snapshot.scope === scope ? snapshot.rows : [];

  const history = useRef<ReturnType<typeof createAgentUsageHistoryController> | null>(null);
  useEffect(() => {
    const owner = createAgentUsageHistoryController({
      currentProjectId: () => useProjectStore.getState().currentProject?.id ?? null,
      list: (pid, since) => createAgentConversationRepository().usageByProject(pid, { since }),
      publish: rows => setSnapshot({ projectId, scope, rows }),
      remove: id => useAgentChatStore.getState().deleteConversation(id),
      clear: pid => useAgentChatStore.getState().clearConversations(pid),
      requestConfirmation: count => requestConfirmation(t('settings.agentUsage.clearConfirm', { count })),
    });
    history.current = owner;
    owner.bind({ open, projectId, since: scope === 'month' ? monthStartISO() : undefined });
    return () => { owner.dispose(); if (history.current === owner) history.current = null; };
  }, [open, projectId, scope, t]);

  // Totals sum EVERY conversation in-window, deleted or not — the spend was real,
  // so deleting a chat must not shrink the usage figures.
  const totals = rows.reduce(
    (a, r) => ({
      input: a.input + r.inputTokens,
      output: a.output + r.outputTokens,
      cost: a.cost + r.costUsd,
      turns: a.turns + r.turns,
    }),
    { input: 0, output: 0, cost: 0, turns: 0 },
  );
  const withUsage = rows.filter((r) => r.inputTokens + r.outputTokens > 0);
  // The manageable history list is live conversations only (all of them, not
  // window-scoped — you manage every chat regardless of when it was last used).
  const live = rows.filter((r) => !r.deletedAt);
  const scopeLabel =
    scope === 'month' ? t('settings.agentUsage.month') : t('settings.agentUsage.all');

  const handleDelete = (id: string) => { void history.current?.remove(id); };
  const handleClearAll = () => history.current?.clear(live.length);

  // Read like the statistics panel: an index-type key over each figure.
  const readout = (label: string, value: string, sub?: string) => (
    <div className="set-usage__item">
      <span className="set-usage__key">{label}</span>
      <strong className="set-usage__value">{value}</strong>
      {sub && <span className="set-usage__key">{sub}</span>}
    </div>
  );

  return (
    <>
      <SettingsGroupHeader label={t('settings.agentUsage.usage')} desc={t('settings.agentUsage.usageDesc')} />

      {!projectId ? (
        <EmptyState density="compact" message={t('settings.agentUsage.noProjectUsage')} />
      ) : (
        <>
          <SettingsSegment<'month' | 'all'>
            value={scope}
            ariaLabel={t('settings.agentUsage.usage')}
            options={[
              { value: 'month', label: t('settings.agentUsage.month') },
              { value: 'all', label: t('settings.agentUsage.all') },
            ]}
            onChange={setScope}
          />
          <div className="set-usage">
            {readout(
              t('settings.agentUsage.tokenCard', { scope: scopeLabel }),
              fmtUsageTok(totals.input + totals.output),
              `↑${fmtUsageTok(totals.input)} ↓${fmtUsageTok(totals.output)}`,
            )}
            {readout(t('settings.agentUsage.costCard', { scope: scopeLabel }), fmtUsageUsd(totals.cost))}
            {readout(t('settings.agentUsage.conversationsTurns'), `${withUsage.length} / ${totals.turns}`)}
          </div>
        </>
      )}

      <div className="set-history__head">
        <SettingsGroupHeader label={t('settings.agentUsage.history')} desc={t('settings.agentUsage.historyDesc')} />
        {projectId && live.length > 0 && (
          <SettingsButton variant="danger" size="sm" onClick={() => void handleClearAll()}>
            {t('settings.agentUsage.clearHistory')}
          </SettingsButton>
        )}
      </div>

      {!projectId ? (
        <EmptyState density="compact" message={t('settings.agentUsage.noProjectHistory')} />
      ) : live.length === 0 ? (
        <EmptyState density="compact" message={t('settings.agentUsage.noHistory')} />
      ) : (
        <div className="set-history">
          {live.map((r) => (
            // A menu row: the ring under the pointer, and delete only there.
            <div key={r.id} className="set-history__row menu-surface__item">
              <span className="set-history__title">{r.title || t('settings.agentUsage.untitled')}</span>
              <span className="set-history__meta">{fmtConvTime(r.updatedAt)}</span>
              <span className="set-history__meta">
                {r.inputTokens + r.outputTokens > 0
                  ? `↑${fmtUsageTok(r.inputTokens)} ↓${fmtUsageTok(r.outputTokens)}`
                  : '—'}
              </span>
              <span className="set-history__meta set-history__meta--cost">
                {r.costUsd > 0 ? fmtUsageUsd(r.costUsd) : '—'}
              </span>
              <button
                type="button"
                className="set-history__delete"
                title={t('settings.agentUsage.deleteConversation')}
                aria-label={t('settings.agentUsage.deleteConversation')}
                onClick={() => handleDelete(r.id)}
              >
                <BrushIcon name="trash" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function AgentPanel({ open, registerRef }: { open: boolean; registerRef: SettingsRegisterRef }) {
  const { t } = useTranslation();

  if (!generalAgentTransport.capability.available) {
    return (
      <section className="set-panel" ref={registerRef} id="agent">
        <SettingsPanelHeader
          kicker={t('settings.agent.kicker')}
          title={t('settings.agent.unavailableTitle')}
          sub={t('settings.agent.unavailableReason')}
        />
        <div className="set-sec">
          <SettingsSectionHeader title={t('settings.agent.unavailableStatus')} hint="TAURI · UNSUPPORTED" />
          <p className="set-row__desc">{t('settings.agent.unavailableFuture')}</p>
        </div>
        <AgentMemorySection open={open} />
        <AgentUsageSection open={open} />
      </section>
    );
  }

  return (
    <section className="set-panel" ref={registerRef} id="agent">
      <SettingsPanelHeader
        kicker={t('settings.agent.kicker')}
        title={t('settings.agent.title')}
        sub={
          <>
            {t('settings.agent.sub')}
            <span className="set-italic"> {t('settings.agent.credentialPrivacy')}</span>
          </>
        }
      />

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.agent.chatConfigTitle')} hint="RIGHT PANEL" />
        <p className="set-row__desc">{t('settings.agent.chatConfigDesc')}</p>
        <SettingsButton
          className="set-sec__action"
          onClick={() => document.getElementById('models')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          {t('settings.common.manageKeys')}
        </SettingsButton>
      </div>

      <AgentLimitsSection />

      <AgentMemorySection open={open} />

      <AgentMcpAccessSettings open={open} />

      <AgentExtensionsSettings open={open} />

      <AgentUsageSection open={open} />
    </section>
  );
}
