declare module 'virtual:story-graph' {
  export function loadStoryGraph(): Promise<typeof import('./shells/desktop/views/DesktopStoryGraphView')>;
}
declare module 'virtual:element-graph' {
  export function loadElementGraph(): Promise<typeof import('./shells/desktop/views/DesktopSuperElementView')>;
}
declare module 'virtual:graph-ui' {
  export function loadGraphUi(): Promise<typeof import('./features/graph/graph-ui-components')>;
}
declare module 'virtual:memo-material' {
  export function loadMemoMaterial(): Promise<typeof import('./shells/desktop/views/DesktopSuperMemoMaterialView')>;
}
