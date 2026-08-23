import { ListTree, MessageSquare, Type, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MobileFormattingSheetContent } from './MobileEditorAccessory';
import type { MobileWorkspaceTransient } from './mobile-workspace-controller';

type BarSheet = Extract<MobileWorkspaceTransient, { kind: 'bar-sheet' }>['sheet'];

export function MobileBarSheet({ sheet, onClose }: { sheet: BarSheet; onClose: () => void }) {
  const { t } = useTranslation();
  const presentation =
    sheet === 'formatting'
      ? { icon: Type, label: t('mobileWorkspace.editorAccessory.expand', { defaultValue: '格式' }) }
      : sheet === 'outline'
        ? { icon: ListTree, label: t('mobileEditorRails.toc') }
        : sheet === 'comments'
          ? { icon: MessageSquare, label: t('mobileEditorRails.comments') }
          : { icon: Type, label: t('mobileEditorRails.menu') };
  const Icon = presentation.icon;
  return (
    <div className="m-bar-sheet" data-sheet={sheet} role="presentation">
      <button
        type="button"
        className="m-bar-sheet__backdrop"
        onClick={onClose}
        aria-label={t('findPanel.closeTitle')}
      />
      <section role="dialog" aria-modal="true" aria-label={presentation.label}>
        <div className="m-bar-sheet__grab" aria-hidden="true" />
        <header>
          <span><Icon size={18} aria-hidden="true" /> {presentation.label}</span>
          <button type="button" onClick={onClose} aria-label={t('findPanel.closeTitle')}>
            <X size={19} aria-hidden="true" />
          </button>
        </header>
        <div
          id={
            sheet === 'outline'
              ? 'mobile-outline-sheet-content'
              : sheet === 'comments'
                ? 'mobile-comments-sheet-content'
                : undefined
          }
          className="m-bar-sheet__content"
        >
          {sheet === 'formatting' ? <MobileFormattingSheetContent /> : null}
        </div>
      </section>
    </div>
  );
}
