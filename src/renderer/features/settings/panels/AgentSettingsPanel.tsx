import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../../store/project-store';
import { useAgentChatStore } from '../../../store/agent-chat-store';
import { createAgentUsageHistoryController } from '../agent-usage-history';
import { requestConfirmation } from '../../../store/confirmation-store';
import { createAgentConversationRepository, type AgentConversationUsage } from '../../../sqlite-repo/agent-conversation-repo';
import { approvePendingMemory, createMemory, listLiveMemories, softDeleteMemory } from '../../../usecase/useAgentMemory';
import type { AgentMemory, AgentMemoryKind } from '../../../domain/agent-memory';
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

// Author-facing management of the agent's saved memories (preferences / vetoes /
// directives — see domain/agent-memory). The fuller surface vs the agt-menu mini
// list: view + approve a pending memory + delete. Open-gated load like the usage
// section; all setState in async callbacks (clear of set-state-in-effect).
function AgentMemorySection({ open }: { open: boolean }) {
  const { t } = useTranslation();
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [draftKind, setDraftKind] = useState<AgentMemoryKind>('preference');
  const [draftBody, setDraftBody] = useState('');

  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    void listLiveMemories(projectId)
      .then((rows) => {
        if (!cancelled) setMemories(rows);
      })
      .catch(() => {
        if (!cancelled) setMemories([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const reload = () => {
    if (!projectId) return;
    void listLiveMemories(projectId)
      .then(setMemories)
      .catch(() => setMemories([]));
  };

  // Hide dismissed (retired/superseded); show active + pending.
  const visible = memories.filter((m) => m.status !== 'dismissed');

  const kindLabel = (k: AgentMemory['kind']) =>
    k === 'veto'
      ? t('settings.agentMemory.kind.veto')
      : k === 'directive'
        ? t('settings.agentMemory.kind.directive')
        : t('settings.agentMemory.kind.preference');

  const approve = (id: string) => {
    if (!projectId) return;
    void approvePendingMemory(projectId, id).then(reload);
  };
  const remove = async (id: string) => {
    if (!projectId) return;
    const confirmed = await requestConfirmation(t('settings.agentMemory.deleteConfirm'));
    if (!confirmed) return;
    void softDeleteMemory(projectId, id).then(reload);
  };
  // Manual add — author-authored, active immediately (it's the author's own).
  const add = () => {
    const body = draftBody.trim();
    if (!body || !projectId) return;
    void createMemory(projectId, {
      kind: draftKind,
      body,
      source: 'author',
      status: 'active',
    }).then(() => {
      setDraftBody('');
      reload();
    });
  };

  return (
    <div className="set-sec">
      <SettingsSectionHeader title={t('settings.agentMemory.title')} hint="MEMORY" />
      <p className="set-panel__sub" style={{ marginTop: -2, marginBottom: 12 }}>
        {t('settings.agentMemory.desc')}
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <select
          className="set-input"
          style={{ flexShrink: 0, width: 84 }}
          value={draftKind}
          onChange={(e) => setDraftKind(e.target.value as AgentMemoryKind)}
        >
          <option value="preference">{t('settings.agentMemory.kind.preference')}</option>
          <option value="directive">{t('settings.agentMemory.kind.directive')}</option>
          <option value="veto">{t('settings.agentMemory.kind.veto')}</option>
        </select>
        <input
          className="set-input"
          style={{ flex: 1, minWidth: 0 }}
          placeholder={t('settings.agentMemory.placeholder')}
          value={draftBody}
          onChange={(e) => setDraftBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
        <button
          className="set-btn set-btn--primary"
          style={{ flexShrink: 0 }}
          disabled={!draftBody.trim()}
          onClick={add}
        >
          {t('settings.agentMemory.add')}
        </button>
      </div>
      {visible.length === 0 ? (
        <div
          style={{
            border: '1px dashed hsl(var(--rule))',
            borderRadius: 5,
            padding: '16px',
            color: 'hsl(var(--ink-4))',
            fontSize: 12.5,
          }}
        >
          {t('settings.agentMemory.empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {visible.map((m) => {
            const pending = m.status === 'pending';
            return (
              <div
                key={m.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  border: '1px solid hsl(var(--rule))',
                  borderRadius: 5,
                  background: 'hsl(var(--surface))',
                  padding: '10px 12px',
                }}
              >
                <span
                  style={{
                    flexShrink: 0,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9.5,
                    letterSpacing: '0.04em',
                    padding: '2px 6px',
                    borderRadius: 4,
                    marginTop: 1,
                    color: m.kind === 'veto' ? 'hsl(var(--accent))' : 'hsl(var(--ink-3))',
                    background:
                      m.kind === 'veto' ? 'hsl(var(--accent) / 0.1)' : 'hsl(var(--ink-1) / 0.07)',
                  }}
                >
                  {kindLabel(m.kind)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: 'hsl(var(--ink-1))', lineHeight: 1.5 }}>
                    {m.body}
                  </div>
                  {pending && (
                    <div
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 9.5,
                        letterSpacing: '0.1em',
                        textTransform: 'uppercase',
                        color: 'hsl(var(--accent))',
                        marginTop: 4,
                      }}
                    >
                      {t('settings.agentMemory.pending')}
                    </div>
                  )}
                </div>
                <div style={{ flexShrink: 0, display: 'flex', gap: 6 }}>
                  {pending && (
                    <button className="set-btn" onClick={() => approve(m.id)}>
                      {t('settings.agentMemory.approve')}
                    </button>
                  )}
                  <button className="set-btn set-btn--danger" onClick={() => void remove(m.id)}>
                    {t('settings.common.delete')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
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
                ×
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

      <AgentExtensionsSettings open={open} />

      <AgentUsageSection open={open} />
    </section>
  );
}
