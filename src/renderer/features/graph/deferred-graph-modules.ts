import { loadStoryGraph } from 'virtual:story-graph';
import { loadElementGraph } from 'virtual:element-graph';
import { loadGraphUi } from 'virtual:graph-ui';
import { loadMemoMaterial } from 'virtual:memo-material';
import { useDeferredModuleIntent } from '../../hooks/useDeferredModuleIntent';
import { createDeferredModule } from '../../lib/deferred-module';

const graphUiModule = createDeferredModule(loadGraphUi);
async function graphUi() {
  await graphUiModule.load();
  const snapshot = graphUiModule.getSnapshot();
  if (snapshot.status === 'ready') return snapshot.value;
  throw snapshot.status === 'error' ? snapshot.error : new Error('Graph UI loading did not settle');
}
export const superViewModules = {
  graph: createDeferredModule(async () => ({ graphUi: await graphUi(), View: (await loadStoryGraph()).DesktopStoryGraphView })),
  element: createDeferredModule(async () => ({ graphUi: await graphUi(), View: (await loadElementGraph()).DesktopSuperElementView })),
};

// The library workbench shares navigation, but needs no graph UI or canvas.
export const memoMaterialModule = createDeferredModule(async () => (await loadMemoMaterial()).DesktopSuperMemoMaterialView);

export function useSuperViewPreloadIntent(view: string | null) {
  return useDeferredModuleIntent(view === 'memo-material' ? memoMaterialModule
    : view === 'graph' || view === 'element' ? superViewModules[view] : undefined);
}
