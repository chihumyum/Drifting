import { useSuperViewPreloadIntent } from '../../../features/graph/deferred-graph-modules';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { SuperViewHeader, type SuperViewHeaderProps } from '../../../components/SuperViewHeader';
import { GlassSlider } from '../../../components/ui/GlassSlider';
import { useSuperViewNavigation } from '../../../hooks/useSuperViewNavigation';
import { CJK_TEXT } from '../../../lib/interface-typography';
import { DesktopSuperViewRelationControl } from './DesktopSuperViewRelationControl';
import { SUPER_VIEW_OPTIONS, type SuperViewId } from '../super-view-options';
import { PUSH_EASING, PUSH_MS } from '../../../lib/motion';

// The switch's glass rides the push that brings the chosen view in
// (DesktopSuperViewStage), landing with it, as under a sidebar's panel tabs.
const SWITCH_TRAVEL = { ms: PUSH_MS, easing: PUSH_EASING };

/** Desktop-owned Super View navigation; the shared header stays store-free. */
export function DesktopSuperViewHeader(props: Omit<SuperViewHeaderProps, 'navigationSlot'> & {
  /** The view's own line controls, first in the relation menu (全部). */
  relationMenuLead?: ReactNode;
  /** False: the view keeps its relation types in its own canvas (the element overview's legend). */
  relationControl?: boolean;
}) {
  const { t } = useTranslation();
  const { active: activeSuperView, setActive: setActiveSuperView } = useSuperViewNavigation();
  const { rightSlot, relationMenuLead, relationControl = true, ...headerProps } = props;
  const graphIntent = useSuperViewPreloadIntent('graph');
  const elementIntent = useSuperViewPreloadIntent('element');
  const memoIntent = useSuperViewPreloadIntent('memo-material');
  const relationCanvas =
    relationControl && (activeSuperView === 'element' || activeSuperView === 'graph') ? activeSuperView : null;
  const intentOf = (id: SuperViewId) =>
    id === 'graph' ? graphIntent : id === 'element' ? elementIntent : memoIntent;

  // Views switch with the glass slider (one of three). Each view draws its own
  // header, so switching replaces this slider: the handoff key lets the next
  // view's slider pick the glass up under the view just left and slide it over.
  const navigation = (
    <nav className="super-view-head__views super-view-head__no-drag" data-tauri-drag-region="false">
      <GlassSlider
        ariaLabel={t('mobileWorkspace.superView.navigation')}
        handoff="super-view-switch"
        travel={SWITCH_TRAVEL}
        value={activeSuperView ?? 'graph'}
        onChange={(view) => setActiveSuperView(view)}
        options={SUPER_VIEW_OPTIONS.map((option) => {
          const label = t(option.labelKey);
          return {
            value: option.id,
            label: (
              <span {...intentOf(option.id)} data-script={CJK_TEXT.test(label) ? 'cjk' : undefined}>
                {label}
              </span>
            ),
          };
        })}
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
            {relationCanvas && <DesktopSuperViewRelationControl canvas={relationCanvas} lead={relationMenuLead} />}
          </>
        ) : undefined
      }
    />
  );
}
