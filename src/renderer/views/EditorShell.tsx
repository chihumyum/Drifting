import { ReactNode } from 'react';

import { type EditorShellView } from '../store/ui-store';

interface EditorShellProps {
  view: EditorShellView;
  children: ReactNode;
}

// Historically EditorShell did URL ↔ tab sync, selection mirroring, and a
// few view-specific state writes. That logic now lives at the Layout level
// in useSyncSplitFocusedUrl so it works uniformly in single-pane and split
// modes (the matched route's Outlet doesn't render under a split tab, which
// used to leave EditorShell unmounted). The component is preserved as a
// thin pass-through so route configurations don't need restructuring.
export function EditorShell({ view, children }: EditorShellProps) {
  void view;
  return <>{children}</>;
}
