import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** The paper tools bar. Tapping the tab bar's ⁂ entry raises this floating
 * pill in its place (the tab bar shrinks back to its three structure
 * entries): every paper-bound tool in one row — 大纲/批注 rail sheets,
 * find-in-paper, 统计, and the 情节 face. */
export function MobilePaperToolsBar({
  hidden = false,
  onClose,
  onOpenStats,
  onOpenSheet,
  onOpenSearch,
  onOpenPlot,
}: {
  hidden?: boolean;
  onClose: () => void;
  onOpenStats: () => void;
  onOpenSheet: (sheet: 'outline' | 'comments' | 'actions') => void;
  onOpenSearch: () => void;
  onOpenPlot: () => void;
}) {
  const { t } = useTranslation();
  const entries = [
    [t('mobileWorkspace.toolsFace.outline', { defaultValue: '大纲' }), () => onOpenSheet('outline')],
    [t('mobileWorkspace.toolsFace.comments', { defaultValue: '批注' }), () => onOpenSheet('comments')],
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
