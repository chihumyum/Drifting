/** A preparing surface needs layout before reveal. Retained dormant surfaces
 * keep their editor/undo owner while browsers can skip their rendering tree. */
export function editorSurfaceContentVisibility(visible: boolean, preparing: boolean): 'visible' | 'hidden' {
  return visible || preparing ? 'visible' : 'hidden';
}
