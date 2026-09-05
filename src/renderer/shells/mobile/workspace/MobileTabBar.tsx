import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';

export type MobileTabBarTab = 'chapters' | 'elements' | 'drifts';

/** The persistent bottom launcher bar. The three entries mirror the desktop
 * left bar's vocabulary (chapters §, elements ◆, drifts ❦) and open the
 * near-full-screen structure overlays — this is a launcher, not a tab
 * switcher, so no entry ever carries a selected state. */
export function MobileTabBar({
  hidden = false,
  onOpen,
  onOpenPaperTools,
  paperToolsAnchorRef,
}: {
  hidden?: boolean;
  paperToolsAnchorRef?: RefObject<HTMLButtonElement | null>;
  onOpen: (tab: MobileTabBarTab) => void;
  /** Present only on paper: ⁂ opens its outline/sticky-note switches. */
  onOpenPaperTools?: () => void;
}) {
  const { t } = useTranslation();
  const tabs = [
    ['chapters', '§', t('leftSidebar.tabs.chapters')],
    ['elements', '◆', t('leftSidebar.tabs.elements')],
    ['drifts', '❦', t('leftSidebar.tabs.drifts')],
  ] as const;
  return (
    <nav
      className="m-tabbar"
      data-debug-id="mobile-tabbar"
      data-hidden={hidden ? 'true' : 'false'}
      aria-label={t('leftSidebar.title')}
      aria-hidden={hidden ? 'true' : undefined}
    >
      {tabs.map(([tab, glyph, label]) => (
        <button key={tab} type="button" tabIndex={hidden ? -1 : undefined} onClick={() => onOpen(tab)}>
          <span className="m-tabbar__glyph" aria-hidden="true">{glyph}</span>
          <span>{label}</span>
        </button>
      ))}
      {onOpenPaperTools && (
        <button
          type="button"
          tabIndex={hidden ? -1 : undefined}
          ref={paperToolsAnchorRef}
          onClick={onOpenPaperTools}
          data-debug-id="mobile-open-paper-tools"
        >
          <span className="m-tabbar__glyph" aria-hidden="true">⁂</span>
          <span>{t('mobileWorkspace.paperTools', { defaultValue: '本纸' })}</span>
        </button>
      )}
    </nav>
  );
}
