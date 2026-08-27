import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MobilePaperRail } from './mobile-paper-rail';

/** The paper tools bar. Tapping the tab bar's ⁂ entry raises this floating
 * pill in its place (the tab bar shrinks back to its three structure
 * entries): 大纲/批注 toggle the in-paper editor rails, 搜索/统计/情节 hand
 * off to their surfaces. The bar stays raised until its own × collapses it
 * back into the tab. */
export function MobilePaperToolsBar({
  hidden = false,
  openRails,
  onToggleRail,
  onClose,
  onOpenStats,
  onOpenSearch,
  onOpenPlot,
}: {
  hidden?: boolean;
  openRails: Record<MobilePaperRail, boolean>;
  onToggleRail: (rail: MobilePaperRail) => void;
  onClose: () => void;
  onOpenStats: () => void;
  onOpenSearch: () => void;
  onOpenPlot: () => void;
}) {
  const { t } = useTranslation();
  const toggles: Array<[MobilePaperRail, string]> = [
    ['toc', t('mobileWorkspace.toolsFace.outline', { defaultValue: '大纲' })],
    ['comments', t('mobileWorkspace.toolsFace.comments', { defaultValue: '批注' })],
  ];
  const entries = [
    [t('mobileWorkspace.search.open', { defaultValue: '搜索' }), onOpenSearch],
    [t('rightSidebar.tabs.stats', { defaultValue: '统计' }), onOpenStats],
    [t('editorTopBar.actions.plotPlanner', { defaultValue: '情节' }), onOpenPlot],
  ] as const;
  return (
    <aside
      className="m-paper-toolsbar"
      data-debug-id="mobile-paper-toolsbar"
      data-hidden={hidden ? 'true' : 'false'}
      aria-hidden={hidden ? 'true' : undefined}
      aria-label={t('mobileWorkspace.paperTools', { defaultValue: '本纸' })}
    >
      <span className="m-paper-toolsbar__glyph" aria-hidden="true">⁂</span>
      {toggles.map(([rail, label]) => (
        <button
          key={rail}
          type="button"
          tabIndex={hidden ? -1 : undefined}
          aria-pressed={openRails[rail]}
          onClick={() => onToggleRail(rail)}
        >
          {label}
        </button>
      ))}
      {entries.map(([label, run]) => (
        <button key={label} type="button" tabIndex={hidden ? -1 : undefined} onClick={run}>
          {label}
        </button>
      ))}
      <button
        type="button"
        className="m-paper-toolsbar__close"
        tabIndex={hidden ? -1 : undefined}
        onClick={onClose}
        aria-label={t('findPanel.closeTitle')}
      >
        <X size={15} aria-hidden="true" />
      </button>
    </aside>
  );
}
