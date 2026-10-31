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
import { requestConfirmation } from '../../store/confirmation-store';
import { Switch } from '../../components/ui/Switch';
import { AnchoredPopover } from '../../components/ui/AnchoredPopover';
import { agentProviderModelOption } from '../../lib/agent/runtime/agent-provider-contract';
import { codexModelCatalog } from '../../lib/agent/codex-model-catalog';
import { useCodexModelCatalog } from './useCodexModelCatalog';
import { BrushIcon } from '../../components/ui/BrushIcon';

/**
 * The single composer config control: a quiet summary button that opens an
 * upward menu. The menu adjusts the active model, provider-aware reasoning,
 * and edit-review behavior.
 *
 * On the desktop (`glass`) the menu is the shared menu surface: rows carry no
 * fill and flow out in glass under the pointer, the current model is medium
 * weight with a still ring, groups are separated by space, the effort is a
 * dropdown field of glass, and a memory row's actions are flat brush icons.
 * The paused mobile shell keeps the fallback rows.
 */
export function AgentComposerConfig({
  preserveInputFocus = false,
  glass = false,
}: {
  preserveInputFocus?: boolean;
  /** A round glass button in the desktop composer's tray. */
  glass?: boolean;
}) {
  const { t } = useTranslation();
  const agentProvider = useSettingsStore((s) => s.agentProvider);
  const setAgentProvider = useSettingsStore((s) => s.setAgentProvider);
  const agentModel = useSettingsStore((s) => s.agentModel);
  const setAgentModel = useSettingsStore((s) => s.setAgentModel);
  const agentThinking = useSettingsStore((s) => s.agentThinking);
  const setAgentThinking = useSettingsStore((s) => s.setAgentThinking);
  const agentEffort = useSettingsStore((s) => s.agentEffort);
  const setAgentEffort = useSettingsStore((s) => s.setAgentEffort);
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
  const catalog = useCodexModelCatalog(open && view === 'model');

  const modelOption = agentProviderModelOption(agentProvider, agentModel);
  const reasoningProfile = resolveAgentProviderReasoningProfile(agentProvider, agentModel);
  const supportsThinking = reasoningProfile.thinkingModes.includes('adaptive');
  const modelShort = modelOption.responses ? modelOption.short : t(`settings.agent.modelOptions.${agentModel}.short`, {
    defaultValue: modelOption?.short ?? agentModel,
  });
  const close = () => {
    setOpen(false);
    setView('main');
  };
  const sectionClass = glass ? 'menu-surface__section-label' : 'agt-menu__sec';
  const rowButtonClass = glass ? 'menu-surface__item agt-menu__item' : 'agt-menu__row agt-menu__row--btn';
  const backClass = glass ? 'menu-surface__item agt-menu__item agt-menu__item--back' : 'agt-menu__back';
  const divider = <div className={glass ? 'menu-surface__divider' : 'agt-menu__divider'} />;
  const effortValue = reasoningProfile.efforts.includes(agentEffort) ? agentEffort : reasoningProfile.defaultEffort;
  const effortSelect = (
    <select
      className={glass ? 'agt-menu__effort-select' : 'agt-menu__select'}
      value={effortValue}
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
  );

  return (
    <div className="agt-pop">
      <button
        ref={triggerRef}
        type="button"
        className={'agt-cfg' + (open ? ' agt-cfg--open' : '') + (glass ? ' glass glass--round' : '')}
        onClick={() => setOpen((o) => !o)}
        title={t('agentPanel.config.title')}
        aria-label={t('agentPanel.config.aria')}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <BrushIcon name="dharma-wheel" size={16} />
      </button>
      <AnchoredPopover
        anchorRef={triggerRef}
        open={open}
        autoFocus={!preserveInputFocus}
        restoreFocus={!preserveInputFocus}
        onClose={close}
        placement="top-start"
        maxHeight={360}
        className={'menu-surface menu-surface--rich menu-surface--wide agt-menu' + (glass ? ' agt-menu--glass' : '')}
        role="dialog"
        ariaLabel={t('agentPanel.config.aria')}
      >
        {view === 'main' ? (
          <>
            <div className={sectionClass}>{t('agentPanel.config.model')}</div>
            <button
              type="button"
              className={rowButtonClass}
              onClick={() => setView('model')}
            >
              <span>{t('agentPanel.config.switchModel')}</span>
              <span className="agt-menu__val">
                {modelShort}
                <BrushIcon name="chevron-right" size={9} inline className="agt-menu__caret" />
              </span>
            </button>
            {divider}
            <div className={sectionClass}>{t('agentPanel.config.reasoning')}</div>
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
                checked={supportsThinking && (agentThinking === 'adaptive' || !reasoningProfile.thinkingModes.includes('off'))}
                disabled={!supportsThinking || !reasoningProfile.thinkingModes.includes('off')}
                onCheckedChange={(checked) => setAgentThinking(checked ? 'adaptive' : 'off')}
              />
            </div>
            {glass ? (
              // A native select inside the glass field: its list is the
              // system's, so choosing never counts as a click outside this menu.
              <div className="agt-menu__row">
                <span>{t('agentPanel.config.effortLabel')}</span>
                <label className="ui-select glass glass--rest glass--field glass--small agt-menu__effort">
                  {effortSelect}
                  <BrushIcon name="chevron-down" size={12} />
                </label>
              </div>
            ) : (
              <label className="agt-menu__row">
                <span>{t('agentPanel.config.effortLabel')}</span>
                {effortSelect}
              </label>
            )}
            {divider}
            <div className={sectionClass}>{t('agentPanel.config.edits')}</div>
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
            {divider}
            <div className={sectionClass}>{t('agentPanel.config.memory')}</div>
            <button
              type="button"
              className={rowButtonClass}
              title={t('agentPanel.config.memoryTitle')}
              onClick={() => {
                void memory.refresh();
                setView('memory');
              }}
            >
              <span>{t('agentPanel.config.manageMemory')}</span>
              <span className="agt-menu__val">
                {visibleMemories.length || t('agentPanel.common.none')}
                <BrushIcon name="chevron-right" size={9} inline className="agt-menu__caret" />
              </span>
            </button>
          </>
        ) : view === 'model' ? (
          <>
            <button type="button" className={backClass} onClick={() => setView('main')}>
              <BrushIcon name="chevron-left" size={9} /> {t('agentPanel.config.model')}
            </button>
            {AGENT_PROVIDER_OPTIONS.map(({ value }) => agentProviderOption(value)).map((provider) => (
              <div key={provider.value}>
                <div className={sectionClass}>{provider.label}</div>
                {provider.value === 'openai-codex' && (
                  <button
                    type="button"
                    className={rowButtonClass}
                    disabled={catalog.state === 'loading'}
                    onClick={() => void codexModelCatalog.refresh(true)}
                  >
                    {t(`agentPanel.config.${catalog.state === 'loading' ? 'modelsLoading' : catalog.state === 'error' ? 'modelsRetry' : 'modelsRefresh'}`)}
                  </button>
                )}
                {provider.models.map((m) => {
                  const current = provider.value === agentProvider && m.value === agentModel;
                  return (
                    <button
                      type="button"
                      key={m.value}
                      className={
                        glass
                          ? 'menu-surface__item agt-menu__item' + (current ? ' menu-surface__item--active is-current' : '')
                          : 'agt-menu__opt' + (current ? ' agt-menu__opt--active' : '')
                      }
                      aria-current={current || undefined}
                      onClick={() => {
                        setAgentProvider(provider.value as AgentProviderId);
                        setAgentModel(m.value);
                        setView('main');
                      }}
                    >
                      <span>
                        {m.responses ? m.label : t(`settings.agent.modelOptions.${m.value}.label`, {
                          defaultValue: m.label,
                        })}
                      </span>
                      {current && !glass && (
                        <BrushIcon name="check" size={11} className="agt-menu__check" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </>
        ) : (
          <>
            <button type="button" className={backClass} onClick={() => setView('main')}>
              <BrushIcon name="chevron-left" size={9} /> {t('agentPanel.config.memory')}
            </button>
            {visibleMemories.length === 0 ? (
              <div className="agt-menu__row agt-menu__row--empty">
                <span style={{ opacity: 0.6 }}>{t('agentPanel.config.noMemory')}</span>
              </div>
            ) : (
              <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                {visibleMemories.map((m) => (
                  <div
                    key={m.id}
                    className={
                      glass
                        ? 'menu-surface__item agt-mem agt-mem--glass' + (m.status === 'pending' ? ' agt-mem--pending' : '')
                        : 'agt-mem'
                    }
                  >
                    <div className="agt-mem__main">
                      {m.status === 'pending' && (
                        <span className={glass ? 'agt-mem__pending' : 'agt-mem__kind'}>
                          {t('projectMemory.inactive')}
                        </span>
                      )}
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
                          <BrushIcon name="check" size={11} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="agt-mem__btn agt-mem__btn--del"
                        title={t('common.delete')}
                        onClick={() =>
                          void requestConfirmation(t('projectMemory.deleteConfirm')).then(
                            (confirmed) => (confirmed ? memory.remove(m.id) : undefined),
                          )
                        }
                      >
                        <BrushIcon name="close" size={10} />
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
