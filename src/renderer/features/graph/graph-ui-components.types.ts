import type { ComponentType, CSSProperties, ReactNode } from 'react';
import type { UseDriftPanelAnimResult } from '../../hooks/useDriftPanelAnim';
import type { SuperViewRelationCanvas } from './super-view-relation-menu-model';

export interface GraphViewProps {
  graphUi: typeof import('./graph-ui-components');
  driftPanel: UseDriftPanelAnimResult;
  /** The desktop legend of the lines, owned by the shell: both bodies draw
   *  it, so importing it from either would split it into a cold chunk. */
  SuperViewRelationLegend: ComponentType<{ canvas: SuperViewRelationCanvas; lead?: ReactNode; style?: CSSProperties }>;
}
