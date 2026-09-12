import { deferredEntryPlugin } from './deferred-entry';

export function deferredSuperViewsPlugins() {
  return [
    deferredEntryPlugin({ id: 'virtual:graph-ui', entry: 'src/renderer/features/graph/graph-ui-components.ts',
      name: 'graph-ui', exportName: 'loadGraphUi', attemptParam: 'graph-attempt' }),
    deferredEntryPlugin({ id: 'virtual:story-graph', entry: 'src/renderer/shells/desktop/views/DesktopStoryGraphView.tsx',
      name: 'story-graph', exportName: 'loadStoryGraph', attemptParam: 'graph-attempt' }),
    deferredEntryPlugin({ id: 'virtual:element-graph', entry: 'src/renderer/shells/desktop/views/DesktopSuperElementView.tsx',
      name: 'element-graph', exportName: 'loadElementGraph', attemptParam: 'graph-attempt' }),
  ];
}
