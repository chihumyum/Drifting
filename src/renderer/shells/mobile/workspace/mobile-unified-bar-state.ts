import type { MobileWorkspacePanel } from './mobile-workspace-controller';

export function nextMobilePanelForBar(
  current: MobileWorkspacePanel,
  side: 'top' | 'bottom',
): MobileWorkspacePanel {
  const docked = `${side}-docked` as MobileWorkspacePanel;
  const full = `${side}-full` as MobileWorkspacePanel;
  if (current === docked) return full;
  if (current === full) return 'none';
  return docked;
}
