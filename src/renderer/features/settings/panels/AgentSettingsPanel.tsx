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
  SettingsGroupHeader,
  SettingsPanelHeader,
  SettingsSectionHeader,
  SettingsSegment,
  type SettingsRegisterRef,
} from '../SettingsPrimitives';
import { BrushIcon } from '../../../components/ui/BrushIcon';

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
        <span style={{ fontSize: 13, color: 'hsl(var(--ink-1))' }}>
          {t('settings.agentLimits.iterationLabel')}
        </span>
        <select
          className="set-input"
          style={{ flexShrink: 0, width: 160 }}
          value={limit === null ? 'unlimited' : String(limit)}
          onChange={(e) =>
            setLimit(e.target.value === 'unlimited' ? null : Number(e.target.value))
          }
          aria-label={t('settings.agentLimits.iterationLabel')}
        >
          {options.map((value) => (
            <option key={value} value={String(value)}>
              {t('settings.agentLimits.iterationOption', { value })}
            </option>
          ))}
          <option value="unlimited">{t('settings.agentLimits.unlimited')}</option>
        </select>
      </div>
      {limit === null && (
        <p className="set-row__desc" style={{ marginTop: 8, color: 'hsl(var(--accent))' }}>
          {t('settings.agentLimits.unlimitedHint')}
        </p>
      )}
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

  const card = (label: string, value: string, sub?: string) => (
    <div
      style={{
        flex: 1,
        border: '1px solid hsl(var(--rule))',
        borderRadius: 5,
        background: 'hsl(var(--surface))',
        padding: '14px 16px',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          textTransform: 'uppercase',
          letterSpacing: '0.14em',
          color: 'hsl(var(--ink-4))',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 30,
          color: 'hsl(var(--ink-1))',
          marginTop: 6,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'hsl(var(--ink-4))',
            marginTop: 2,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );

  return (
    <>
      <SettingsGroupHeader
        label={t('settings.agentUsage.usage')}
        hint="USAGE"
        desc={t('settings.agentUsage.usageDesc')}
      />

      {!projectId ? (
        <div style={{ color: 'hsl(var(--ink-4))', fontSize: 13 }}>
          {t('settings.agentUsage.noProjectUsage')}
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <SettingsSegment<'month' | 'all'>
              value={scope}
              options={[
                { value: 'month', label: t('settings.agentUsage.month') },
                { value: 'all', label: t('settings.agentUsage.all') },
              ]}
              onChange={setScope}
            />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {card(
              t('settings.agentUsage.tokenCard', { scope: scopeLabel }),
              fmtUsageTok(totals.input + totals.output),
              `↑${fmtUsageTok(totals.input)} ↓${fmtUsageTok(totals.output)}`,
            )}
            {card(
              t('settings.agentUsage.costCard', { scope: scopeLabel }),
              fmtUsageUsd(totals.cost),
            )}
            {card(
              t('settings.agentUsage.conversationsTurns'),
              `${withUsage.length} / ${totals.turns}`,
            )}
          </div>
        </>
      )}

      <SettingsGroupHeader
        label={t('settings.agentUsage.history')}
        hint="HISTORY"
        desc={t('settings.agentUsage.historyDesc')}
      />

      {projectId && live.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '2px 0 8px' }}>
          <button
            type="button"
            onClick={() => void handleClearAll()}
            style={{
              border: '1px solid hsl(var(--rule))',
              background: 'transparent',
              color: 'hsl(var(--ink-3))',
              cursor: 'pointer',
              fontSize: 12,
              padding: '4px 10px',
              borderRadius: 5,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'hsl(var(--ink-1))';
              e.currentTarget.style.background = 'hsl(var(--paper-deep))';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'hsl(var(--ink-3))';
              e.currentTarget.style.background = 'transparent';
            }}
          >
            {t('settings.agentUsage.clearHistory')}
          </button>
        </div>
      )}

      {!projectId ? (
        <div style={{ color: 'hsl(var(--ink-4))', fontSize: 13 }}>
          {t('settings.agentUsage.noProjectHistory')}
        </div>
      ) : live.length === 0 ? (
        <div style={{ color: 'hsl(var(--ink-4))', fontSize: 13, padding: '8px 0' }}>
          {t('settings.agentUsage.noHistory')}
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            border: '1px solid hsl(var(--rule))',
            borderRadius: 5,
            overflow: 'hidden',
          }}
        >
          {live.map((r, i) => (
            <div
              key={r.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                borderTop: i === 0 ? 'none' : '1px solid hsl(var(--rule))',
                fontSize: 12.5,
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: 'hsl(var(--ink-1))',
                }}
              >
                {r.title || t('settings.agentUsage.untitled')}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10.5,
                  color: 'hsl(var(--ink-4))',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {fmtConvTime(r.updatedAt)}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'hsl(var(--ink-3))',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {r.inputTokens + r.outputTokens > 0
                  ? `↑${fmtUsageTok(r.inputTokens)} ↓${fmtUsageTok(r.outputTokens)}`
                  : '—'}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'hsl(var(--ink-4))',
                  minWidth: 56,
                  textAlign: 'right',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {r.costUsd > 0 ? fmtUsageUsd(r.costUsd) : '—'}
              </span>
              <button
                type="button"
                title={t('settings.agentUsage.deleteConversation')}
                onClick={() => handleDelete(r.id)}
                style={{
                  flexShrink: 0,
                  border: 'none',
                  background: 'transparent',
                  color: 'hsl(var(--ink-4))',
                  cursor: 'pointer',
                  fontSize: 15,
                  lineHeight: 1,
                  padding: '2px 4px',
                  borderRadius: 4,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = 'hsl(var(--ink-1))';
                  e.currentTarget.style.background = 'hsl(var(--paper-deep))';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'hsl(var(--ink-4))';
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                <BrushIcon name="close" size={10} inline />
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
        <button
          className="set-btn"
          onClick={() =>
            document
              .getElementById('models')
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        >
          {t('settings.common.manageKeys')}
        </button>
      </div>

      <AgentLimitsSection />

      <AgentMemorySection open={open} />

      <AgentMcpAccessSettings open={open} />

      <AgentExtensionsSettings open={open} />

      <AgentUsageSection open={open} />
    </section>
  );
}
