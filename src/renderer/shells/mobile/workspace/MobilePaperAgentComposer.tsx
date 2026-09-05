import { useInputPreservingActions } from '../../../hooks/useInputPreservingActions';
import { useLayoutEffect, useRef, type ReactNode, type RefCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { MobileUnifiedBackAction } from './MobileUnifiedBackAction';

/** Agent input uses the paper accessory's surface and Back control. */
export function MobilePaperAgentComposer({
  value, onChange, textAreaRef, disabled, readOnly, placeholder, controls, feedback, onBack,
}: {
  value: string;
  onChange: (value: string) => void;
  textAreaRef: RefCallback<HTMLTextAreaElement>;
  disabled: boolean;
  readOnly: boolean;
  placeholder: string;
  controls: ReactNode;
  feedback: ReactNode;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const inputActions = useInputPreservingActions<HTMLElement>(true, true);
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    const panel = bar?.closest<HTMLElement>('.m-agent');
    if (!bar || !panel) return;
    const sync = () => panel.style.setProperty('--m-paper-agent-toolbar-height', `${bar.offsetHeight + 8}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(bar);
    return () => { observer.disconnect(); panel.style.removeProperty('--m-paper-agent-toolbar-height'); };
  }, []);
  return (
    <footer {...inputActions} ref={ref} className="m-unified-bar m-paper-agent__toolbar" data-debug-id="mobile-agent-accessory" aria-label={t('mobileWorkspace.unifiedBar')}
      >
      <div className="m-paper-agent__input-row">
        <textarea ref={textAreaRef} value={value} onChange={(event) => onChange(event.target.value)}
          className="m-paper-agent__input" data-debug-id="mobile-agent-composer" rows={1}
          aria-label={t('agentPanel.composer.placeholder')} disabled={disabled} readOnly={readOnly} placeholder={placeholder} />
      </div>
      {feedback}
      <div className="m-paper-agent__input-controls">
        <MobileUnifiedBackAction preserveFocusUntilBack onBack={onBack} label={t('navigation.back')} />
        {controls}
      </div>
    </footer>
  );
}
