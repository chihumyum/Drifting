import { useTranslation } from 'react-i18next';
import { GlassSlider } from '../../../components/ui/GlassSlider';
import type { ElementLayoutMode } from '../../../features/graph/element-relate-layout';

/**
 * The element overview's layout (关系 or 群岛), in its header just before
 * the counts. The legend of the lines sits in the canvas's top-right corner
 * (SuperViewRelationLegend).
 */
export function SuperElementLayoutSwitch({ layout, onLayout }: {
  layout: ElementLayoutMode;
  onLayout: (layout: ElementLayoutMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="se-layout-switch super-view-head__no-drag" data-tauri-drag-region="false">
      <GlassSlider
        className="se-layout-switch__slider"
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
