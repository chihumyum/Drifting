import { useSettingsPreloadIntent } from '../../../features/settings/useSettingsPanels';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings, X } from 'lucide-react';
import { motion, useIsPresent, useReducedMotion } from 'framer-motion';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import type { EntityKind } from '../../../lib/extensions/entity-link';
import { ReviewPanel } from '../../../components/rightBars/ReviewPanel';
import { LibraryPanel, type FocusedEntity } from '../../../features/library/LibraryPanel';
import { MobileAgentPanel } from './MobileAgentPanel';
import { MobilePaperStats } from './MobilePaperStats';
import { useMobilePaperPresentation } from './MobilePaperContent';
import { usePaperGlyph } from './mobile-paper-glyph';

type ToolTab = 'stats' | 'review' | 'agent' | 'library';

let lastMobileRightSidebarTab: ToolTab = 'stats';

function focusedEntity(target: WorkspaceTarget | null): FocusedEntity {
  if (!target || target.entityType === 'all-chapters') {
    return { kind: null, id: null };
  }
  return { kind: target.entityType as EntityKind, id: target.id };
}

/** Mobile presentation of the desktop right sidebar. It remains one modal
 * workspace containing every right-sidebar tool; only its chrome differs. */
export function MobileRightSidebar({
  projectId,
  target,
  onClose,
  onOpenSettings,
}: {
  projectId: string;
  target: WorkspaceTarget;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLElement | null>(null);
  const isPresent = useIsPresent();
  const settingsIntent = useSettingsPreloadIntent(isPresent);
  const reducedMotion = useReducedMotion();
  const [tab, setTab] = useState<ToolTab>(() => lastMobileRightSidebarTab);
  const presentation = useMobilePaperPresentation(target);
  const glyph = usePaperGlyph(target);
  const focused = focusedEntity(target);
  const tabs = [
    ['stats', t('rightSidebar.tabs.stats')],
    ['review', t('rightSidebar.tabs.review')],
    ['agent', 'Agent'],
    ['library', t('rightSidebar.tabs.library')],
  ] as const;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogRef.current?.focus({ preventScroll: true });
    return () => previousFocus?.focus({ preventScroll: true });
  }, []);

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hasAttribute('hidden'));
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="m-right-sidebar-layer"
      data-debug-id="mobile-right-sidebar-layer"
      data-state={isPresent ? 'open' : 'closing'}
    >
      <motion.button
        type="button"
        className="m-right-sidebar__backdrop"
        onClick={() => { if (isPresent) onClose(); }}
        tabIndex={-1}
        aria-hidden="true"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reducedMotion ? 0 : 0.2 }}
      />
      <motion.section
        ref={dialogRef}
        className="m-tools-face m-right-sidebar"
        role="dialog"
        aria-modal="true"
        inert={!isPresent}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        data-debug-id="mobile-right-sidebar"
        aria-label={t('mobileWorkspace.tools', { defaultValue: '工具工作区' })}
        initial={reducedMotion ? false : { x: 28, y: '-100%' }}
        animate={{ x: 0, y: 0 }}
        exit={{
          x: 0,
          y: reducedMotion ? 0 : '-100%',
          transition: { duration: reducedMotion ? 0 : 0.24, ease: [0.4, 0, 1, 1] },
        }}
        transition={{ duration: reducedMotion ? 0 : 0.3, ease: [0.22, 0.8, 0.2, 1] }}
      >
        <header className="m-tools-face__header">
          <span className="m-tools-face__identity">
            <span aria-hidden="true">{glyph}</span> {presentation.title}
          </span>
          <nav
            className="m-tools-face__tabs"
            aria-label={t('mobileWorkspace.tools', { defaultValue: '工具工作区' })}
          >
            {tabs.map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-current={tab === id ? 'page' : undefined}
                onClick={() => {
                  lastMobileRightSidebarTab = id;
                  setTab(id);
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          <button
            type="button"
            className="m-tools-face__settings"
            {...settingsIntent}
            onClick={onOpenSettings}
            aria-label={t('settings.title')}
          >
            <Settings size={18} strokeWidth={1.7} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="m-tools-face__close"
            onClick={onClose}
            aria-label={t('findPanel.closeTitle')}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>
        <div className="m-tools-face__pane">
          {tab === 'stats' && (
            <div className="m-context-workspace__pane m-context-workspace__body">
              <MobilePaperStats target={target} />
            </div>
          )}
          {tab === 'review' && (
            <div className="m-context-workspace__pane m-context-workspace__body m-review-workspace">
              <ReviewPanel focused={focused} />
            </div>
          )}
          {tab === 'agent' && (
            <div className="m-context-workspace__pane m-context-workspace__body">
              <MobileAgentPanel projectId={projectId} target={target} />
            </div>
          )}
          {tab === 'library' && (
            <div className="m-context-workspace__pane m-context-workspace__body m-library-workspace">
              <LibraryPanel focused={focused} presentation="mobile" />
            </div>
          )}
        </div>
      </motion.section>
    </div>
  );
}
