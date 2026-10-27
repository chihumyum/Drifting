import { getPlatformRuntime } from '../../platform/runtime';
import { useUiStore } from '../../store/ui-store';
import { SidebarToggleButton } from './WindowControlButtons';

/** The toggle of a closed sidebar, in its desk corner on the window's drag strip. */
export function WorkspaceCornerControls() {
  const runtime = getPlatformRuntime();
  const leftOpen = useUiStore((state) => state.sidebars.left.isOpen);
  const rightOpen = useUiStore((state) => state.sidebars.right.isOpen);
  return (
    <div
      className="workspace-window-strip"
      data-tauri-drag-region={runtime.desktopWindowControls ? 'deep' : undefined}
    >
      {!leftOpen && (
        <div
          className="workspace-corner-controls workspace-corner-controls--left"
          data-leading-inset={runtime.isMacDesktop ? 'true' : undefined}
        >
          <SidebarToggleButton side="left" />
        </div>
      )}
      {!rightOpen && (
        <div className="workspace-corner-controls workspace-corner-controls--right">
          <SidebarToggleButton side="right" />
        </div>
      )}
    </div>
  );
}
