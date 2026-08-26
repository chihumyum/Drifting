import { GitBranch, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { ChapterPanel } from '../../../components/leftBars/ChapterPanel';
import { ElementPanel } from '../../../components/leftBars/ElementPanel';
import { DriftPanel } from '../../../components/leftBars/DriftPanel';
import type { MobileTabBarTab } from './MobileTabBar';
import type { MobileSuperViewId } from './mobile-workspace-controller';

/** The near-full-screen structure layer behind a bottom tab bar entry. It
 * hosts the same panels as the desktop left bar; tapping an entry opens it
 * directly as a paper. Chapter-axis companions (通览全书, 叙事图) ride in the
 * header of the chapters layer. */
export function MobileStructureOverlay({
  tab,
  target,
  onClose,
  onOpenTarget,
  onOpenAllChapters,
  onOpenSuperView,
}: {
  tab: MobileTabBarTab;
  target: WorkspaceTarget | null;
  onClose: () => void;
  onOpenTarget: (target: WorkspaceTarget) => void;
  onOpenAllChapters: () => void;
  onOpenSuperView: (view: MobileSuperViewId) => void;
}) {
  const { t } = useTranslation();
  const titles: Record<MobileTabBarTab, [string, string]> = {
    chapters: ['§', t('leftSidebar.tabs.chapters')],
    elements: ['◆', t('leftSidebar.tabs.elements')],
    drifts: ['❦', t('leftSidebar.tabs.drifts')],
  };
  const [glyph, title] = titles[tab];
  return (
    <section
      className="m-struct-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-debug-id="mobile-structure-overlay"
      data-tab={tab}
    >
      <button
        type="button"
        className="m-struct-overlay__scrim"
        aria-label={t('navigation.back')}
        onClick={onClose}
      />
      <div className="m-struct-overlay__sheet">
        <header className="m-struct-overlay__header">
          <span className="m-struct-overlay__glyph" aria-hidden="true">{glyph}</span>
          <strong>{title}</strong>
          {tab === 'chapters' && (
            <span className="m-struct-overlay__aux">
              <button type="button" onClick={onOpenAllChapters}>
                <span className="m-struct-overlay__aux-glyph" aria-hidden="true">☰</span>
                <span>{t('rightSidebar.targets.allChapters', { defaultValue: '通览全书' })}</span>
              </button>
              <button type="button" onClick={() => onOpenSuperView('graph')}>
                <GitBranch size={13} strokeWidth={1.8} aria-hidden="true" />
                <span>{t('dashboard.quick.graph', { defaultValue: '叙事图' })}</span>
              </button>
            </span>
          )}
          {tab === 'elements' && (
            <span className="m-struct-overlay__aux">
              <button type="button" onClick={() => onOpenSuperView('element')}>
                <span className="m-struct-overlay__aux-glyph" aria-hidden="true">◆</span>
                <span>{t('superElement.title')}</span>
              </button>
            </span>
          )}
          {tab === 'drifts' && (
            <span className="m-struct-overlay__aux">
              <button type="button" onClick={() => onOpenSuperView('memo-material')}>
                <span className="m-struct-overlay__aux-glyph" aria-hidden="true">☷</span>
                <span>{t('memoMaterial.super.title')}</span>
              </button>
            </span>
          )}
          <button
            type="button"
            className="m-struct-overlay__close"
            onClick={onClose}
            aria-label={t('findPanel.closeTitle')}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>
        <div className="m-context-workspace__pane m-struct-overlay__body">
          {tab === 'chapters' && (
            <ChapterPanel
              presentation="mobile"
              activeTarget={target}
              onPreviewTarget={onOpenTarget}
            />
          )}
          {tab === 'elements' && (
            <ElementPanel
              presentation="mobile"
              activeTarget={target}
              onPreviewTarget={onOpenTarget}
            />
          )}
          {tab === 'drifts' && (
            <DriftPanel
              presentation="mobile"
              activeTarget={target}
              onPreviewTarget={onOpenTarget}
            />
          )}
        </div>
      </div>
    </section>
  );
}
