/**
 * The phone's desk (docs/mobile-ui-foundation.md). One raised paper fills the
 * screen; everything else lies on the desk beneath it. Pushing the paper
 * right shows the left desk (chapters, elements, drifts), pushing it left
 * shows the right desk (review, library, stats, the Agent), lifting its foot
 * shows the Bottom Panel (timeline or plot planner). A Super View, search
 * and the project trash are laid over the whole desk.
 *
 * Back takes away one thing at a time, the last thing laid on first, and
 * never walks a page history: papers change through the dock.
 */

export type MobileSuperViewId = 'element' | 'graph' | 'memo-material';
export type MobileLeftPanel = 'nodes' | 'elements' | 'drift';
export type MobileRightPanel = 'review' | 'library' | 'stats' | 'companion';
export type MobileDrawer = 'none' | 'left' | 'right';
export type MobileBottomPane = 'timeline' | 'planner';
export type MobileBottomDetent = 'half' | 'full';
export type MobileSheet = 'none' | 'search' | 'trash' | 'tabs';
export type MobileKeyboardBar = 'tools' | 'format';

export const MOBILE_LEFT_PANELS: readonly MobileLeftPanel[] = ['nodes', 'elements', 'drift'];
export const MOBILE_RIGHT_PANELS: readonly MobileRightPanel[] = ['review', 'library', 'stats', 'companion'];
export const MOBILE_SUPER_VIEWS: readonly MobileSuperViewId[] = ['element', 'graph', 'memo-material'];

export interface MobileBottomState {
  pane: MobileBottomPane;
  detent: MobileBottomDetent;
}

export interface MobileDeskState {
  /** What the paper shows: an open document, or Project Home (no dock pill). */
  stage: 'paper' | 'home';
  drawer: MobileDrawer;
  left: MobileLeftPanel;
  right: MobileRightPanel;
  bottom: MobileBottomState | null;
  /** The pane the foot of the paper lifts to next time. */
  lastBottomPane: MobileBottomPane;
  superView: MobileSuperViewId | null;
  sheet: MobileSheet;
  /** A small sheet a tool opened over itself (a timeline chapter, a plot cell). */
  popover: string | null;
  /** The editor holds the caret: the keyboard and its bar are up. */
  writing: boolean;
  keyboardBar: MobileKeyboardBar;
}

export type MobileDeskAction =
  | { type: 'show-paper' }
  | { type: 'show-home' }
  | { type: 'open-drawer'; side: 'left' | 'right'; panel?: MobileLeftPanel | MobileRightPanel }
  | { type: 'close-drawer' }
  | { type: 'set-left-panel'; panel: MobileLeftPanel }
  | { type: 'set-right-panel'; panel: MobileRightPanel }
  | { type: 'open-bottom'; pane?: MobileBottomPane; detent?: MobileBottomDetent }
  | { type: 'set-bottom-detent'; detent: MobileBottomDetent }
  | { type: 'set-bottom-pane'; pane: MobileBottomPane }
  | { type: 'close-bottom' }
  | { type: 'open-super-view'; view: MobileSuperViewId }
  | { type: 'close-super-view' }
  | { type: 'open-sheet'; sheet: Exclude<MobileSheet, 'none'> }
  | { type: 'close-sheet' }
  | { type: 'sync-writing'; writing: boolean }
  | { type: 'set-keyboard-bar'; bar: MobileKeyboardBar }
  | { type: 'set-popover'; popover: string | null }
  | { type: 'replace'; state: MobileDeskState };

export interface MobileDeskPreferences {
  left: MobileLeftPanel;
  right: MobileRightPanel;
  lastBottomPane: MobileBottomPane;
}

export function createMobileDeskState(
  preferences: Partial<MobileDeskPreferences> = {},
  stage: MobileDeskState['stage'] = 'paper',
): MobileDeskState {
  return {
    stage,
    drawer: 'none',
    left: MOBILE_LEFT_PANELS.includes(preferences.left as MobileLeftPanel) ? preferences.left! : 'nodes',
    right: MOBILE_RIGHT_PANELS.includes(preferences.right as MobileRightPanel) ? preferences.right! : 'companion',
    bottom: null,
    lastBottomPane: preferences.lastBottomPane === 'planner' ? 'planner' : 'timeline',
    superView: null,
    sheet: 'none',
    popover: null,
    writing: false,
    keyboardBar: 'tools',
  };
}

/** Whatever lies over the paper is put away before the paper is written on. */
function cleared(state: MobileDeskState): MobileDeskState {
  return { ...state, drawer: 'none', bottom: null, sheet: 'none', superView: null, popover: null };
}

export function mobileDeskReducer(state: MobileDeskState, action: MobileDeskAction): MobileDeskState {
  switch (action.type) {
    case 'show-paper':
      return state.stage === 'paper' && state.drawer === 'none' ? state : { ...state, stage: 'paper', drawer: 'none' };
    case 'show-home':
      return { ...cleared(state), stage: 'home', writing: false, keyboardBar: 'tools' };
    case 'open-drawer': {
      const next: MobileDeskState = { ...state, drawer: action.side, bottom: null, sheet: 'none', writing: false, keyboardBar: 'tools' };
      if (action.side === 'left' && MOBILE_LEFT_PANELS.includes(action.panel as MobileLeftPanel)) next.left = action.panel as MobileLeftPanel;
      if (action.side === 'right' && MOBILE_RIGHT_PANELS.includes(action.panel as MobileRightPanel)) next.right = action.panel as MobileRightPanel;
      return next;
    }
    case 'close-drawer':
      return state.drawer === 'none' ? state : { ...state, drawer: 'none' };
    case 'set-left-panel':
      return state.left === action.panel ? state : { ...state, left: action.panel };
    case 'set-right-panel':
      return state.right === action.panel ? state : { ...state, right: action.panel };
    case 'open-bottom': {
      const pane = action.pane ?? state.lastBottomPane;
      return {
        ...state,
        drawer: 'none',
        sheet: 'none',
        writing: false,
        keyboardBar: 'tools',
        bottom: { pane, detent: action.detent ?? state.bottom?.detent ?? 'half' },
        lastBottomPane: pane,
      };
    }
    case 'set-bottom-detent':
      return state.bottom && state.bottom.detent !== action.detent
        ? { ...state, bottom: { ...state.bottom, detent: action.detent } }
        : state;
    case 'set-bottom-pane':
      return state.bottom
        ? { ...state, bottom: { ...state.bottom, pane: action.pane }, lastBottomPane: action.pane }
        : { ...state, lastBottomPane: action.pane };
    case 'close-bottom':
      return state.bottom ? { ...state, bottom: null, popover: null } : state;
    case 'open-super-view':
      return { ...state, drawer: 'none', sheet: 'none', writing: false, keyboardBar: 'tools', superView: action.view };
    case 'close-super-view':
      return state.superView ? { ...state, superView: null } : state;
    case 'open-sheet':
      return { ...state, sheet: action.sheet, keyboardBar: 'tools' };
    case 'close-sheet':
      return state.sheet === 'none' ? state : { ...state, sheet: 'none' };
    case 'sync-writing':
      if (state.writing === action.writing) return state;
      return action.writing
        ? { ...cleared(state), stage: 'paper', writing: true }
        : { ...state, writing: false, keyboardBar: 'tools' };
    case 'set-keyboard-bar':
      return state.keyboardBar === action.bar ? state : { ...state, keyboardBar: action.bar };
    case 'set-popover':
      return state.popover === action.popover ? state : { ...state, popover: action.popover };
    case 'replace':
      return action.state;
  }
}

export type MobileBackSource = 'visible' | 'keyboard' | 'android-hardware';

export type MobileBackLayer =
  | 'popover'
  | 'keyboard-bar'
  | 'sheet'
  | 'super-view'
  | 'writing'
  | 'bottom'
  | 'drawer'
  | 'paper-root'
  | 'home-root';

export interface MobileBackResolution {
  handled: boolean;
  layer: MobileBackLayer | null;
  nextState: MobileDeskState;
  effect: 'none' | 'blur-editor' | 'show-home' | 'leave-project';
}

/**
 * Back takes away the last thing laid on the desk: a tool's small sheet, the format pill, then a
 * sheet, a Super View, the keyboard, the Bottom Panel, a drawer. At the
 * paper's root Android's Back goes to Project Home and from there leaves the
 * book; Escape on a hardware keyboard stops at the paper.
 */
export function resolveMobileDeskBack(state: MobileDeskState, source: MobileBackSource): MobileBackResolution {
  const done = (layer: MobileBackLayer, nextState: MobileDeskState, effect: MobileBackResolution['effect'] = 'none'): MobileBackResolution => ({
    handled: true,
    layer,
    nextState,
    effect,
  });
  if (state.popover) return done('popover', { ...state, popover: null });
  if (state.writing && state.keyboardBar === 'format') return done('keyboard-bar', { ...state, keyboardBar: 'tools' });
  if (state.sheet !== 'none') return done('sheet', { ...state, sheet: 'none' });
  if (state.superView) return done('super-view', { ...state, superView: null });
  if (state.writing) return done('writing', { ...state, writing: false, keyboardBar: 'tools' }, 'blur-editor');
  if (state.bottom) return done('bottom', { ...state, bottom: null, popover: null });
  if (state.drawer !== 'none') return done('drawer', { ...state, drawer: 'none' });
  if (source === 'keyboard') return { handled: false, layer: null, nextState: state, effect: 'none' };
  if (state.stage === 'paper') return done('paper-root', { ...state, stage: 'home' }, 'show-home');
  if (source === 'android-hardware') return done('home-root', state, 'leave-project');
  return { handled: false, layer: null, nextState: state, effect: 'none' };
}

const PREFERENCES_KEY = 'drifting.mobile.desk.v1';

export function readMobileDeskPreferences(storage: Pick<Storage, 'getItem'> | null, projectId: string): Partial<MobileDeskPreferences> {
  try {
    const raw = storage?.getItem(`${PREFERENCES_KEY}:${projectId}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<MobileDeskPreferences>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writeMobileDeskPreferences(storage: Pick<Storage, 'setItem'> | null, projectId: string, state: MobileDeskState): void {
  try {
    storage?.setItem(
      `${PREFERENCES_KEY}:${projectId}`,
      JSON.stringify({ left: state.left, right: state.right, lastBottomPane: state.lastBottomPane } satisfies MobileDeskPreferences),
    );
  } catch {
    // A full or blocked store only loses the remembered panels.
  }
}
