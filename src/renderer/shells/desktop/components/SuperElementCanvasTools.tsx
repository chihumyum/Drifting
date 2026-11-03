import { useTranslation } from 'react-i18next';
import { GlassSlider } from '../../../components/ui/GlassSlider';
import type { ElementLayoutMode } from '../../../features/graph/element-relate-layout';

/**
 * The element overview's layout (群岛 or 关系), under its header on the
 * left of the canvas. The legend of the lines sits in the top-right corner
 * (SuperViewRelationLegend).
 */
export function SuperElementLayoutSwitch({ layout, onLayout }: {
  layout: ElementLayoutMode;
  onLayout: (layout: ElementLayoutMode) => void;
}) {
  const { t } = useTranslation();
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
    </div>
  );
}

/** The legend's first row on the element overview: the sand lines from the prose (正文同段). */
export function SuperElementLinesRow({ linesOn, linesCount, onToggleLines }: {
  linesOn: boolean;
  linesCount: number;
  onToggleLines: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="super-view-legend__row is-sand glass glass--small"
      data-se-lines=""
      aria-pressed={linesOn}
      title={t('superElement.isles.linesTitle')}
      onClick={onToggleLines}
    >
      <span className="super-view-legend__stroke" aria-hidden />
      <span className="super-view-legend__name">{t('superElement.isles.lines')}</span>
      <span className="super-view-legend__count">{linesCount}</span>
    </button>
  );
}
