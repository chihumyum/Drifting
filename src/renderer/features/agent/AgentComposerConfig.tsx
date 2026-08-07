import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useSettingsStore,
  AGENT_PROVIDER_OPTIONS,
  agentProviderOption,
  resolveAgentProviderReasoningProfile,
  type AgentEffort,
  type AgentProviderId,
} from '../../store/settings-store';
import { useProjectStore } from '../../store/project-store';
import { useAgentMemory } from '../../usecase/useAgentMemory';
import { Switch } from '../../components/ui/Switch';
import { AnchoredPopover } from '../../components/ui/AnchoredPopover';
import { DRIFTING_AGENT_MAX_CONTEXT_WINDOW_TOKENS } from '../../lib/agent/runtime/drifting-agent-product-contract';

/**
 * The single composer config control: a quiet summary button that opens an
 * upward menu. The menu adjusts the active model, provider-aware reasoning,
 * context budget and edit-review behavior.
 */
export function AgentComposerConfig() {
  const { t } = useTranslation();
  const agentProvider = useSettingsStore((s) => s.agentProvider);
  const setAgentProvider = useSettingsStore((s) => s.setAgentProvider);
  const agentModel = useSettingsStore((s) => s.agentModel);
  const setAgentModel = useSettingsStore((s) => s.setAgentModel);
  const agentThinking = useSettingsStore((s) => s.agentThinking);
  const setAgentThinking = useSettingsStore((s) => s.setAgentThinking);
  const agentEffort = useSettingsStore((s) => s.agentEffort);
  const setAgentEffort = useSettingsStore((s) => s.setAgentEffort);
  const agentMaxContext = useSettingsStore((s) => s.agentMaxContext);
  const setAgentMaxContext = useSettingsStore((s) => s.setAgentMaxContext);
  const agentEditMode = useSettingsStore((s) => s.agentEditMode);
  const setAgentEditMode = useSettingsStore((s) => s.setAgentEditMode);
  const agentAllowDangerousOperations = useSettingsStore(
    (s) => s.agentAllowDangerousOperations,
  );
  const setAgentAllowDangerousOperations = useSettingsStore(
    (s) => s.setAgentAllowDangerousOperations,
  );

  const projectId = useProjectStore((s) => s.currentProject?.id ?? '');
  const memory = useAgentMemory(projectId);
  const visibleMemories = memory.memories.filter((m) => m.status !== 'dismissed');

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'main' | 'model' | 'memory'>('main');
  const triggerRef = useRef<HTMLButtonElement>(null);

  const modelOptions = agentProviderOption(agentProvider).models;
  const modelOption = modelOptions.find((m) => m.value === agentModel);
  const reasoningProfile = resolveAgentProviderReasoningProfile(agentProvider, agentModel);
  const supportsThinking = reasoningProfile.thinkingModes.includes('adaptive');
  const supportsMaxContext =
    (modelOption?.context.contextWindowTokens ?? 0) >= DRIFTING_AGENT_MAX_CONTEXT_WINDOW_TOKENS;
  const modelShort = t(`settings.agent.modelOptions.${agentModel}.short`, {
    defaultValue: modelOption?.short ?? agentModel,
  });
  const close = () => {
    setOpen(false);
    setView('main');
  };

  return (
    <div className="agt-pop">
      <button
        ref={triggerRef}
        type="button"
        className={'agt-cfg' + (open ? ' agt-cfg--open' : '')}
        onClick={() => setOpen((o) => !o)}
        title={t('agentPanel.config.title')}
        aria-label={t('agentPanel.config.aria')}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <line x1="4" y1="8" x2="20" y2="8" />
          <circle cx="9" cy="8" r="2.3" fill="currentColor" stroke="none" />
          <line x1="4" y1="16" x2="20" y2="16" />
          <circle cx="15" cy="16" r="2.3" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <AnchoredPopover
        anchorRef={triggerRef}
        open={open}
        onClose={close}
        placement="top-start"
        maxHeight={360}
        className="menu-surface menu-surface--rich menu-surface--wide agt-menu"
        role="dialog"
        ariaLabel={t('agentPanel.config.aria')}
      >
        {view === 'main' ? (
          <>
            <div className="agt-menu__sec">{t('agentPanel.config.model')}</div>
            <button
              type="button"
              className="agt-menu__row agt-menu__row--btn"
              onClick={() => setView('model')}
            >
              <span>{t('agentPanel.config.switchModel')}</span>
              <span className="agt-menu__val">
                {modelShort}
                <span className="agt-menu__caret">›</span>
              </span>
            </button>
            <div
              className="agt-menu__row"
              title={
                supportsMaxContext
                  ? t('agentPanel.config.maxContextTitle')
                  : t('agentPanel.config.maxContextUnavailable')
              }
            >
              <span>{t('agentPanel.config.maxContext')}</span>
              <Switch
                checked={supportsMaxContext && agentMaxContext}
                disabled={!supportsMaxContext}
                onCheckedChange={setAgentMaxContext}
              />
            </div>
            <div className="agt-menu__divider" />
            <div className="agt-menu__sec">{t('agentPanel.config.reasoning')}</div>
            <div
              className="agt-menu__row"
              title={
                supportsThinking
                  ? t('agentPanel.config.extendedThinkingTitle')
                  : t('agentPanel.config.reasoningUnavailable')
              }
            >
              <span>{t('agentPanel.config.extendedThinking')}</span>
              <Switch
                checked={agentThinking === 'adaptive'}
                disabled={!supportsThinking}
                onCheckedChange={(checked) => setAgentThinking(checked ? 'adaptive' : 'off')}
              />
            </div>
            <label className="agt-menu__row">
              <span>{t('agentPanel.config.effortLabel')}</span>
              <select
                className="agt-menu__select"
                value={agentEffort}
                disabled={reasoningProfile.efforts.length === 0}
                onChange={(event) => setAgentEffort(event.target.value as AgentEffort)}
                aria-label={t('agentPanel.config.effortLabel')}
              >
                {reasoningProfile.efforts.length === 0 ? (
                  <option value={agentEffort}>{t('agentPanel.config.notSupported')}</option>
                ) : (
                  reasoningProfile.efforts.map((effort) => (
                    <option key={effort} value={effort}>
                      {t(`settings.agent.effortOptions.${effort}`)}
                    </option>
                  ))
                )}
              </select>
            </label>
            <div className="agt-menu__divider" />
            <div className="agt-menu__sec">{t('agentPanel.config.edits')}</div>
            <div className="agt-menu__row" title={t('agentPanel.config.reviewEditsTitle')}>
              <span>{t('agentPanel.config.reviewEdits')}</span>
              <Switch
                checked={agentEditMode === 'approve'}
                onCheckedChange={(checked) => setAgentEditMode(checked ? 'approve' : 'auto')}
              />
            </div>
            <div
              className="agt-menu__row"
              title={t('agentPanel.config.dangerousOperationsTitle')}
            >
              <span>{t('agentPanel.config.dangerousOperations')}</span>
              <Switch
                checked={agentAllowDangerousOperations}
                onCheckedChange={setAgentAllowDangerousOperations}
              />
            </div>
            <div className="agt-menu__divider" />
            <div className="agt-menu__sec">{t('agentPanel.config.memory')}</div>
            <button
              type="button"
              className="agt-menu__row agt-menu__row--btn"
              title={t('agentPanel.config.memoryTitle')}
              onClick={() => {
                void memory.refresh();
                setView('memory');
              }}
            >
              <span>{t('agentPanel.config.manageMemory')}</span>
              <span className="agt-menu__val">
                {visibleMemories.length || t('agentPanel.common.none')}
                <span className="agt-menu__caret">›</span>
              </span>
            </button>
          </>
        ) : view === 'model' ? (
          <>
            <button type="button" className="agt-menu__back" onClick={() => setView('main')}>
              ‹ {t('agentPanel.config.model')}
            </button>
            {AGENT_PROVIDER_OPTIONS.map((provider) => (
              <div key={provider.value}>
                <div className="agt-menu__sec">{provider.label}</div>
                {provider.models.map((m) => (
                  <button
                    type="button"
                    key={m.value}
                    className={
                      'agt-menu__opt' +
                      (provider.value === agentProvider && m.value === agentModel
                        ? ' agt-menu__opt--active'
                        : '')
                    }
                    onClick={() => {
                      setAgentProvider(provider.value as AgentProviderId);
                      setAgentModel(m.value);
                      setView('main');
                    }}
                  >
                    <span>
                      {t(`settings.agent.modelOptions.${m.value}.label`, {
                        defaultValue: m.label,
                      })}
                    </span>
                    {provider.value === agentProvider && m.value === agentModel && (
                      <span className="agt-menu__check">●</span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </>
        ) : (
          <>
            <button type="button" className="agt-menu__back" onClick={() => setView('main')}>
              ‹ {t('agentPanel.config.memory')}
            </button>
            {visibleMemories.length === 0 ? (
              <div className="agt-menu__row agt-menu__row--empty">
                <span style={{ opacity: 0.6 }}>{t('agentPanel.config.noMemory')}</span>
              </div>
            ) : (
              <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                {visibleMemories.map((m) => (
                  <div key={m.id} className="agt-mem">
                    <div className="agt-mem__main">
                      <span className={'agt-mem__kind agt-mem__kind--' + m.kind}>
                        {m.kind === 'veto'
                          ? t('agentPanel.memoryKind.veto')
                          : m.kind === 'directive'
                            ? t('agentPanel.memoryKind.directive')
                            : t('agentPanel.memoryKind.preference')}
                      </span>
                      <span className="agt-mem__body" title={m.body}>
                        {m.body}
                      </span>
                    </div>
                    <div className="agt-mem__acts">
                      {m.status === 'pending' && (
                        <button
                          type="button"
                          className="agt-mem__btn"
                          title={t('agentPanel.config.approveMemory')}
                          onClick={() => void memory.approve(m.id)}
                        >
                          ✓
                        </button>
                      )}
                      <button
                        type="button"
                        className="agt-mem__btn agt-mem__btn--del"
                        title={t('common.delete')}
                        onClick={() => void memory.remove(m.id)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </AnchoredPopover>
    </div>
  );
}
