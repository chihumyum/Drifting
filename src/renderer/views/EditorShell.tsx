import { ReactNode } from 'react';

import { type EditorShellView } from '../store/ui-store';

interface EditorShellProps {
  view: EditorShellView;
  children: ReactNode;
}

// Historically EditorShell did URL ↔ tab sync, selection mirroring, and a
// few view-specific state writes. That logic now lives at the Layout level in
// useSyncSplitFocusedUrl. Desktop editor lifetime is owned by EditorMainArea's
// persistent tab stage rather than child route elements; this pass-through
// remains for shared/mobile route configuration compatibility.
export function EditorShell({ view, children }: EditorShellProps) {
  void view;
  return <>{children}</>;
}
