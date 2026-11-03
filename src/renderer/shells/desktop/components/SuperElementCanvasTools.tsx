import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassSlider } from '../../../components/ui/GlassSlider';
import { RelationKindMenu } from '../../../components/ui/RelationKindMenu';
import type { ElementLayoutMode } from '../../../features/graph/element-relate-layout';
import { useSuperViewRelationControl } from './useSuperViewRelationControl';

/**
 * The element overview's canvas corner, under its header on the left: the
 * layout (群岛 or 关系) and the legend of the lines on the canvas. A legend
 * row is the line's own stroke, its name and how many there are; pressing it
 * shows or hides that kind of line. The last row opens the relation types'
 * definitions (the 全部 menu the header used to hold).
 */
export function SuperElementCanvasTools({ layout, onLayout, linesOn, linesCount, onToggleLines }: {
  layout: ElementLayoutMode;
  onLayout: (layout: ElementLayoutMode) => void;
  linesOn: boolean;
  linesCount: number;
  onToggleLines: () => void;
}) {
  const { t } = useTranslation();
  const relations = useSuperViewRelationControl('element');
  // The desktop canvas draws relations between elements only (it has no
  // chapter band), so the legend counts those and lists the kinds it draws.
  const drawn = useMemo(() => {
    const counts = new Map<string, number>();
    for (const relation of relations.model.canvasRelations) {
      if (relation.fromKind !== 'element' || relation.toKind !== 'element') continue;
      counts.set(relation.relationTypeId, (counts.get(relation.relationTypeId) ?? 0) + 1);
    }
    return counts;
  }, [relations.model.canvasRelations]);
  const [menuOpen, setMenuOpen] = useState(false);
  const editRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="se-tools" data-se-tools="">
      <GlassSlider
        className="se-tools__layout"
        value={layout}
        onChange={onLayout}
        ariaLabel={t('superElement.layout.label')}
        options={[
          { value: 'isles', label: t('superElement.layout.isles') },
          { value: 'relate', label: t('superElement.layout.relate') },
        ]}
      />
      <div className="se-legend glass glass--rest" role="group" aria-label={t('superElement.legend.label')}>
        <button
          type="button"
          className="se-legend__row is-sand glass glass--small"
          data-se-lines=""
          aria-pressed={linesOn}
          title={t('superElement.isles.linesTitle')}
          onClick={onToggleLines}
        >
          <span className="se-legend__stroke" aria-hidden />
          <span className="se-legend__name">{t('superElement.isles.lines')}</span>
          <span className="se-legend__count">{linesCount}</span>
        </button>
        {relations.model.relationTypeIdOrder.filter((relationTypeId) => drawn.has(relationTypeId)).map((relationTypeId) => {
          const label = relations.labelOf(relationTypeId);
          const shown = !relations.hiddenRelationTypeIds.has(relationTypeId);
          return (
            <button
              key={relationTypeId}
              type="button"
              className="se-legend__row glass glass--small"
              aria-pressed={shown}
              title={shown ? t('storyGraph.edge.hideKind', { label }) : t('storyGraph.edge.showKind', { label })}
              style={{ '--se-legend-c': relations.resolveRelationTypeColor(relationTypeId) } as CSSProperties}
              onClick={() => relations.toggleRelationTypeId(relationTypeId)}
            >
              <span className="se-legend__stroke" aria-hidden />
              <span className="se-legend__name">{label}</span>
              <span className="se-legend__count">{drawn.get(relationTypeId)}</span>
            </button>
          );
        })}
        <button
          ref={editRef}
          type="button"
          className="se-legend__row is-edit glass glass--small"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={t('edgeKindManager.openAllTitle')}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="se-legend__name">{t('superElement.legend.editTypes')}</span>
          <span className="se-legend__count">{relations.typeCount}</span>
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
