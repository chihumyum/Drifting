import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RelationKindMenu } from '../../../components/ui/RelationKindMenu';
import type { SuperViewRelationCanvas } from '../../../features/graph/super-view-relation-menu-model';
import { useSuperViewRelationControl } from './useSuperViewRelationControl';

/**
 * The legend of the lines a graph-style Super View draws, in the top-right
 * corner of its content (2026-11-03: the header no longer holds them). A row
 * is the line's own stroke, its name and how many the canvas draws; pressing
 * it shows or hides that kind of line. The last row opens the relation
 * types' definitions (the 全部 menu). `lead` puts the view's own lines first
 * (the element overview's 正文同段).
 */
export function SuperViewRelationLegend({ canvas, lead, style }: {
  canvas: SuperViewRelationCanvas;
  lead?: ReactNode;
  style?: CSSProperties;
}) {
  const { t } = useTranslation();
  const relations = useSuperViewRelationControl(canvas);
  const [menuOpen, setMenuOpen] = useState(false);
  const editRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="super-view-legend" data-super-view-legend="" style={style}>
      <div className="super-view-legend__rows glass glass--rest" role="group" aria-label={t('edgeKindManager.legendLabel')}>
        {lead}
        {relations.model.relationTypeIdOrder.filter((relationTypeId) => relations.drawnCounts.has(relationTypeId)).map((relationTypeId) => {
          const label = relations.labelOf(relationTypeId);
          const shown = !relations.hiddenRelationTypeIds.has(relationTypeId);
          return (
            <button
              key={relationTypeId}
              type="button"
              className="super-view-legend__row glass glass--small"
              aria-pressed={shown}
              title={shown ? t('storyGraph.edge.hideKind', { label }) : t('storyGraph.edge.showKind', { label })}
              style={{ '--legend-c': relations.resolveRelationTypeColor(relationTypeId) } as CSSProperties}
              onClick={() => relations.toggleRelationTypeId(relationTypeId)}
            >
              <span className="super-view-legend__stroke" aria-hidden />
              <span className="super-view-legend__name">{label}</span>
              <span className="super-view-legend__count">{relations.drawnCounts.get(relationTypeId)}</span>
            </button>
          );
        })}
        <button
          ref={editRef}
          type="button"
          className="super-view-legend__row is-edit glass glass--small"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={t('edgeKindManager.openAllTitle')}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="super-view-legend__name">{t('edgeKindManager.editTypes')}</span>
          <span className="super-view-legend__count">{relations.typeCount}</span>
        </button>
      </div>
      <RelationKindMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={editRef}
        {...relations.menuProps}
      />
    </div>
  );
}
