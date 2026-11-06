import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { getPlatformRuntime } from '../platform/runtime';
import { requestMobileWorkspaceBack } from '../shells/mobile/workspace/mobile-workspace-back';
import '../../styles/super-view-header.css';
import { BrushIcon } from './ui/BrushIcon';
import { useSuperViewLeaving } from './super-view-leaving';

export interface SuperViewHeaderProps {
  /** Optional inline caption (e.g. counts like "3 故事线 · 12 章"). */
  meta?: ReactNode;
  /** Back-button click handler. Omit to hide the button entirely. */
  onBack?: () => void;
  /** Back-button tooltip / aria-label. Defaults to "返回". */
  backLabel?: string;
  /** Primary navigation placed after the back button. */
  navigationSlot?: ReactNode;
  /** A control placed just before the meta caption — e.g. the element
   *  overview's layout switch. */
  metaLead?: ReactNode;
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
  metaLead,
  leftSlot,
  rightSlot,
}: SuperViewHeaderProps) {
  const { t } = useTranslation();
  const leaving = useSuperViewLeaving();
  const runtime = getPlatformRuntime();
  const resolvedBackLabel = backLabel ?? t('navigation.back');
  // A view being pushed away keeps the header's box, so its block does not
  // jump up, but none of its controls: its switch leaves in the same commit
  // the arriving view's switch arrives in, under the arriving header.
  if (leaving) return <div className="super-view-head" aria-hidden="true" />;
  return (
    <div
      className="super-view-head"
      data-tauri-drag-region={runtime.desktopWindowControls ? 'deep' : undefined}
      data-leading-window-controls={
        runtime.leadingWindowControls && runtime.desktopWindowControls ? '' : undefined
      }
    >
      <div className="super-view-head__left">
        {onBack && (
          <button
            type="button"
            // Round glass beside the window controls, the same level as the
            // sidebar toggles.
            className="super-view-head__back glass glass--rest glass--round"
            // The mobile shell owns its back stack (shells/mobile), so its
            // back goes through the shell's navigation rather than onBack.
            onClick={() => {
              if (runtime.isMobileShell) requestMobileWorkspaceBack('visible');
              else onBack();
            }}
            title={resolvedBackLabel}
            aria-label={resolvedBackLabel}
          >
            <BrushIcon name="arrow-back" size={16} />
          </button>
        )}
        {navigationSlot}
        {metaLead}
        {meta != null && <em className="super-view-head__meta">{meta}</em>}
        {leftSlot}
      </div>
      {rightSlot != null && <div className="super-view-head__right">{rightSlot}</div>}
    </div>
  );
}
