import { useTranslation } from 'react-i18next';
import {
  SuperViewHeader,
  type SuperViewHeaderProps,
} from '../../../components/SuperViewHeader';
import { useUiStore } from '../../../store/ui-store';

type SuperViewId = 'element' | 'graph' | 'memo-material';

const SUPER_VIEW_OPTIONS: Array<{ id: SuperViewId; labelKey: string }> = [
  { id: 'element', labelKey: 'superElement.title' },
  { id: 'graph', labelKey: 'storyGraph.title' },
  { id: 'memo-material', labelKey: 'memoMaterial.super.title' },
];

/** Desktop-owned Super View navigation; the shared header stays store-free. */
export function DesktopSuperViewHeader({ leftSlot, ...props }: SuperViewHeaderProps) {
  const { t } = useTranslation();
  const activeSuperView = useUiStore((state) => state.activeSuperView);
  const setActiveSuperView = useUiStore((state) => state.setActiveSuperView);

  return (
    <SuperViewHeader
      {...props}
      leftSlot={
        <>
          <nav
            className="super-view-head__switcher super-view-head__no-drag"
            aria-label="Super views"
          >
            {SUPER_VIEW_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-current={activeSuperView === option.id ? 'page' : undefined}
                className="super-view-head__switcher-option"
                onClick={() => setActiveSuperView(option.id)}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </nav>
          {leftSlot}
        </>
      }
    />
  );
}
