import type { ComponentType } from 'react';
import type { GraphViewProps } from '../features/graph/graph-ui-components.types';
import { useDriftPanelAnim } from '../hooks/useDriftPanelAnim';

export function GraphCardFixture({ View, graphUi }: {
  View: ComponentType<GraphViewProps>;
  graphUi: GraphViewProps['graphUi'];
}) {
  return <View graphUi={graphUi} driftPanel={useDriftPanelAnim()} />;
}
