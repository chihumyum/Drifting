import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getPlatformRuntime } from '../platform/runtime';
import '../../styles/super-view-header.css';

export interface SuperViewHeaderProps {
  /** Optional inline caption (e.g. counts like "3 故事线 · 12 章"). */
  meta?: ReactNode;
  /** Back-button click handler. Omit to hide the button entirely. */
  onBack?: () => void;
  /** Back-button tooltip / aria-label. Defaults to "返回". */
  backLabel?: string;
  /** Primary navigation placed after the back button. */
  navigationSlot?: ReactNode;
  /** Extra controls placed in the left group after navigation and meta — e.g.
   *  view-mode toggles or scoped action buttons. */
  leftSlot?: ReactNode;
  /** Trailing controls — filters, mode toggles, status pills. */
  rightSlot?: ReactNode;
}

export function SuperViewHeader({
  meta,
  onBack,
  backLabel,
  navigationSlot,
  leftSlot,
  rightSlot,
}: SuperViewHeaderProps) {
  const { t } = useTranslation();
  const runtime = getPlatformRuntime();
  const resolvedBackLabel = backLabel ?? t('navigation.back');
  return (
    <div
      className="super-view-head"
      data-tauri-drag-region={runtime.desktopWindowControls ? 'deep' : undefined}
      data-macos-window-controls={
        runtime.isMacDesktop && runtime.desktopWindowControls ? '' : undefined
      }
    >
      <div className="super-view-head__left">
        {onBack && (
          <button
            type="button"
            className="super-view-head__back"
            onClick={onBack}
            title={resolvedBackLabel}
            aria-label={resolvedBackLabel}
          >
            <ArrowLeft size={16} strokeWidth={1.7} aria-hidden="true" />
          </button>
        )}
        {navigationSlot}
        {meta != null && <em className="super-view-head__meta">{meta}</em>}
        {leftSlot}
      </div>
      {rightSlot != null && <div className="super-view-head__right">{rightSlot}</div>}
    </div>
  );
}
