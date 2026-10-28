import { getPlatformRuntime } from '../../platform/runtime';

/**
 * The desk column's window-drag strip. The sidebar toggles float above it
 * (`WorkspaceSidebarToggles`), fixed in the window's top corners.
 */
export function WorkspaceCornerControls() {
  const runtime = getPlatformRuntime();
  return (
    <div
      className="workspace-window-strip"
      data-tauri-drag-region={runtime.desktopWindowControls ? 'deep' : undefined}
    />
  );
}
