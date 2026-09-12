import type { UseDriftPanelAnimResult } from '../../hooks/useDriftPanelAnim';

export interface GraphViewProps {
  graphUi: typeof import('./graph-ui-components');
  driftPanel: UseDriftPanelAnimResult;
}
