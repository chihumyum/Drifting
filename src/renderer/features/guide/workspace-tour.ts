import type { ShortcutActionId } from '../../store/shortcuts-store';

/** The guides a device remembers having shown (settings-storage `guidesSeen`). */
export const WORKSPACE_TOUR_ID = 'workspace-tour';

export interface GuideStep {
  id: string;
  /**
   * What the step points at. `first`: the first of these that shows on screen;
   * `union`: one ring around every match that shows. A step with nothing
   * showing is passed over (a collapsed sidebar, a page that is not open).
   */
  targets: readonly string[];
  pick: 'first' | 'union';
  titleKey: string;
  bodyKey: string;
  /**
   * Where to point while the control is put away, with what to say there:
   * a closed sidebar's own toggle. Opening it moves the ring onto the control.
   */
  fallback?: { targets: readonly string[]; bodyKey: string };
  /** Shortcuts written under the sentence, in the index face, no keycaps. */
  shortcuts?: readonly (ShortcutActionId | { accelerator: string })[];
}

/**
 * The first time a book opens on this device: where the book's parts live,
 * the whole-window views, making things, the timeline, the Agent and the way
 * back to the book's home page. Each step points at the control itself.
 */
export const WORKSPACE_TOUR: readonly GuideStep[] = [
  {
    id: 'panels',
    targets: ['.leftbar-tab-tray [data-panel-tab-label]'],
    pick: 'union',
    titleKey: 'guide.workspace.panels.title',
    bodyKey: 'guide.workspace.panels.body',
    fallback: {
      targets: ['.workspace-sidebar-toggle--left.workspace-sidebar-toggle--floating'],
      bodyKey: 'guide.workspace.panels.closedBody',
    },
  },
  {
    id: 'super-views',
    targets: ['.workspace-super-view-entry'],
    pick: 'first',
    titleKey: 'guide.workspace.superViews.title',
    bodyKey: 'guide.workspace.superViews.body',
  },
  {
    id: 'create',
    targets: ['.dash-sec--create'],
    pick: 'first',
    titleKey: 'guide.workspace.create.title',
    bodyKey: 'guide.workspace.create.body',
    shortcuts: ['newEntity'],
  },
  {
    id: 'timeline',
    targets: ['.workspace-timeline-toggle'],
    pick: 'first',
    titleKey: 'guide.workspace.timeline.title',
    bodyKey: 'guide.workspace.timeline.body',
    shortcuts: ['toggleBottomTimeline'],
  },
  {
    id: 'agent',
    targets: ['[data-guide-anchor="agent-tab"] [data-panel-tab-label]'],
    pick: 'first',
    titleKey: 'guide.workspace.agent.title',
    bodyKey: 'guide.workspace.agent.body',
    fallback: {
      targets: ['.workspace-sidebar-toggle--right.workspace-sidebar-toggle--floating'],
      bodyKey: 'guide.workspace.agent.closedBody',
    },
    shortcuts: [{ accelerator: 'Mod+Enter' }],
  },
  {
    id: 'home',
    targets: ['.sidebar-account-cell [data-guide-anchor="project-home"]', '.sidebar-account-cell .notification-pill'],
    pick: 'union',
    titleKey: 'guide.workspace.home.title',
    bodyKey: 'guide.workspace.home.body',
  },
];
