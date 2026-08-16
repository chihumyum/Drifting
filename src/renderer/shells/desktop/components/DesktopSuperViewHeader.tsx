import { useTranslation } from 'react-i18next';
import { SuperViewHeader, type SuperViewHeaderProps } from '../../../components/SuperViewHeader';
import { useSuperViewNavigation } from '../../../hooks/useSuperViewNavigation';
import { DesktopSuperViewRelationControl } from './DesktopSuperViewRelationControl';

type SuperViewId = 'element' | 'graph' | 'memo-material';

const SUPER_VIEW_OPTIONS: Array<{ id: SuperViewId; labelKey: string }> = [
  { id: 'element', labelKey: 'superElement.title' },
  { id: 'graph', labelKey: 'storyGraph.title' },
  { id: 'memo-material', labelKey: 'memoMaterial.super.title' },
];

/** Desktop-owned Super View navigation; the shared header stays store-free. */
export function DesktopSuperViewHeader(props: Omit<SuperViewHeaderProps, 'navigationSlot'>) {
  const { t } = useTranslation();
  const { active: activeSuperView, setActive: setActiveSuperView } = useSuperViewNavigation();
  const { rightSlot, ...headerProps } = props;
  const relationCanvas =
    activeSuperView === 'element' || activeSuperView === 'graph' ? activeSuperView : null;

  return (
    <SuperViewHeader
      {...headerProps}
      navigationSlot={
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
      }
      rightSlot={
        rightSlot != null || relationCanvas ? (
          <>
            {rightSlot}
            {relationCanvas && <DesktopSuperViewRelationControl canvas={relationCanvas} />}
          </>
        ) : undefined
      }
    />
  );
}
