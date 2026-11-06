import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { SuperViewRelationCanvas } from '../../../features/graph/super-view-relation-menu-model';
import { FilterChip } from '../../../components/ui/FilterChip';
import { HeaderChipStrip } from '../../../components/ui/HeaderChipStrip';
import { RelationKindMenu } from '../../../components/ui/RelationKindMenu';
import { useSuperViewRelationControl } from './useSuperViewRelationControl';

export function DesktopSuperViewRelationControl({ canvas, lead }: {
  canvas: SuperViewRelationCanvas;
  /** The canvas's own line controls, first in the 全部 menu. */
  lead?: ReactNode;
}) {
  const { t } = useTranslation();
  const {
    model, headerRelationTypeIds, labelOf, resolveRelationTypeColor, hiddenRelationTypeIds, toggleRelationTypeId,
    driftPanelOpen, typeCount, menuProps,
  } = useSuperViewRelationControl(canvas);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // The relation types are chips and 全部 is a word toggle.

  return (
    <>
      <HeaderChipStrip>
        {headerRelationTypeIds.map((relationTypeId) => {
          const label = labelOf(relationTypeId);
          const active = !hiddenRelationTypeIds.has(relationTypeId);
          return (
            <FilterChip
              key={relationTypeId}
              look="glass"
              size="sm"
              activeStyle="solid"
              active={active}
              markerColor={resolveRelationTypeColor(relationTypeId)}
              drift={driftPanelOpen && model.driftDerivedRelationTypeIds.has(relationTypeId)}
              onClick={() => toggleRelationTypeId(relationTypeId)}
              title={
                active
                  ? t('storyGraph.edge.hideKind', { label })
                  : t('storyGraph.edge.showKind', { label })
              }
            >
              {label}
            </FilterChip>
          );
        })}
      </HeaderChipStrip>
      <div
        className="relation-kind-menu-anchor super-view-head__no-drag"
        data-tauri-drag-region="false"
      >
        <button
          ref={buttonRef}
          type="button"
          className="ui-word-toggle glass glass--rest glass--small"
          onClick={() => setOpen((current) => !current)}
          title={t('edgeKindManager.openAllTitle')}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span>{t('edgeKindManager.all')}</span>
          <span className="ui-word-toggle__count">{typeCount}</span>
        </button>
        <RelationKindMenu
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={buttonRef}
          {...menuProps}
          relationTypeGroups={{
            usedTypes: model.usedTypes,
            availableTypes: model.availableTypes,
            otherTypes: model.otherTypes,
          }}
          lead={lead}
        />
      </div>
    </>
  );
}
