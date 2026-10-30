import { useSuperViewPreloadIntent } from '../../../features/graph/deferred-graph-modules';
import { useTranslation } from 'react-i18next';
import { SuperViewHeader, type SuperViewHeaderProps } from '../../../components/SuperViewHeader';
import { GlassSlider } from '../../../components/ui/GlassSlider';
import { useSuperViewNavigation } from '../../../hooks/useSuperViewNavigation';
import { getPlatformRuntime } from '../../../platform/runtime';
import { DesktopSuperViewRelationControl } from './DesktopSuperViewRelationControl';
import { SUPER_VIEW_OPTIONS, type SuperViewId } from '../super-view-options';

/** Desktop-owned Super View navigation; the shared header stays store-free. */
export function DesktopSuperViewHeader(props: Omit<SuperViewHeaderProps, 'navigationSlot'>) {
  const { t } = useTranslation();
  const { active: activeSuperView, setActive: setActiveSuperView } = useSuperViewNavigation();
  const { rightSlot, ...headerProps } = props;
  const graphIntent = useSuperViewPreloadIntent('graph');
  const elementIntent = useSuperViewPreloadIntent('element');
  const memoIntent = useSuperViewPreloadIntent('memo-material');
  const relationCanvas =
    activeSuperView === 'element' || activeSuperView === 'graph' ? activeSuperView : null;
  const intentOf = (id: SuperViewId) =>
    id === 'graph' ? graphIntent : id === 'element' ? elementIntent : memoIntent;

  // Desktop switches views with the glass slider (one of three); the paused
  // mobile shell keeps its segmented switcher.
  const navigation = getPlatformRuntime().isMobileShell ? (
    <nav
      className="super-view-head__switcher super-view-head__no-drag"
      aria-label={t('mobileWorkspace.superView.navigation')}
    >
      {SUPER_VIEW_OPTIONS.map((option) => (
        <button
          key={option.id}
          {...intentOf(option.id)}
          type="button"
          aria-current={activeSuperView === option.id ? 'page' : undefined}
          className="super-view-head__switcher-option"
          onClick={() => setActiveSuperView(option.id)}
        >
          {t(option.labelKey)}
        </button>
      ))}
    </nav>
  ) : (
    <nav className="super-view-head__views super-view-head__no-drag" data-tauri-drag-region="false">
      <GlassSlider
        ariaLabel={t('mobileWorkspace.superView.navigation')}
        value={activeSuperView ?? 'graph'}
        onChange={(view) => setActiveSuperView(view)}
        options={SUPER_VIEW_OPTIONS.map((option) => ({
          value: option.id,
          label: <span {...intentOf(option.id)}>{t(option.labelKey)}</span>,
        }))}
      />
    </nav>
  );

  return (
    <SuperViewHeader
      {...headerProps}
      navigationSlot={navigation}
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
