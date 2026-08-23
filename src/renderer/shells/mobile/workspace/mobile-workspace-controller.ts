import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';

export type MobileSuperViewId = 'element' | 'graph' | 'memo-material';

export type MobileWorkspaceSurface =
  | { kind: 'paper' }
  | { kind: 'overview' }
  | { kind: 'super-view'; view: MobileSuperViewId };

export type MobilePaperMode =
  | { kind: 'read' }
  | { kind: 'edit'; accessory: 'navigation' | 'formatting' };

export type MobileWorkspacePanel =
  | 'none'
  | 'top-docked'
  | 'top-full'
  | 'bottom-docked'
  | 'bottom-full';

export type MobileWorkspaceTransient =
  | { kind: 'none' }
  | { kind: 'search'; scope: 'paper' | 'project' }
  | { kind: 'agent-input' }
  | { kind: 'popover'; id: string }
  | { kind: 'bar-sheet'; sheet: 'outline' | 'comments' | 'actions' }
  | { kind: 'paper-status' }
  | { kind: 'entity-preview'; target: WorkspaceTarget }
  | { kind: 'dialog'; dialog: 'project-trash' | 'destructive' | 'native' };

export type MobileKeyboardState = 'closed' | 'open';

export interface MobileWorkspaceUiState {
  surface: MobileWorkspaceSurface;
  paperMode: MobilePaperMode;
  panel: MobileWorkspacePanel;
  transient: MobileWorkspaceTransient;
  keyboard: MobileKeyboardState;
}

export type MobileWorkspaceAction =
  | { type: 'show-paper' }
  | { type: 'show-overview' }
  | { type: 'show-super-view'; view: MobileSuperViewId }
  | { type: 'open-project-trash' }
  | { type: 'set-panel'; panel: MobileWorkspacePanel }
  | { type: 'set-transient'; transient: MobileWorkspaceTransient }
  | { type: 'sync-editor'; editing: boolean }
  | { type: 'set-editor-accessory'; accessory: 'navigation' | 'formatting' }
  | { type: 'sync-keyboard'; keyboard: MobileKeyboardState }
  | { type: 'replace'; state: MobileWorkspaceUiState };

export type MobileBackSource = 'visible' | 'keyboard' | 'android-hardware';

export type MobileBackLayer =
  | 'dialog'
  | 'transient'
  | 'input'
  | 'keyboard'
  | 'panel-full'
  | 'panel-docked'
  | 'super-view'
  | 'overview'
  | 'edit-mode'
  | 'project-root';

export interface MobileBackResolution {
  handled: boolean;
  layer: MobileBackLayer | null;
  nextState: MobileWorkspaceUiState;
  effect: 'none' | 'blur-editor' | 'leave-project';
}

export interface MobileUnifiedBarProjection {
  visible: boolean;
  mode: 'read' | 'edit' | 'search' | 'agent-input';
  leftAction: 'disabled' | 'back' | 'dismiss-keyboard';
  placement: 'safe-bottom' | 'above-bottom-panel';
}

const PAPER_SURFACE: MobileWorkspaceSurface = { kind: 'paper' };
const READ_MODE: MobilePaperMode = { kind: 'read' };
const NO_TRANSIENT: MobileWorkspaceTransient = { kind: 'none' };

export function createInitialMobileWorkspaceUiState(): MobileWorkspaceUiState {
  return {
    surface: PAPER_SURFACE,
    paperMode: READ_MODE,
    panel: 'none',
    transient: NO_TRANSIENT,
    keyboard: 'closed',
  };
}

function resetToSurface(surface: MobileWorkspaceSurface): MobileWorkspaceUiState {
  return {
    ...createInitialMobileWorkspaceUiState(),
    surface,
  };
}

function transientOwnsInput(transient: MobileWorkspaceTransient): boolean {
  return transient.kind === 'search' || transient.kind === 'agent-input';
}

function panelSide(panel: MobileWorkspacePanel): 'top' | 'bottom' | null {
  if (panel.startsWith('top-')) return 'top';
  if (panel.startsWith('bottom-')) return 'bottom';
  return null;
}

export function mobileWorkspaceStateIssues(state: MobileWorkspaceUiState): string[] {
  const issues: string[] = [];
  const atPaper = state.surface.kind === 'paper';

  if (!atPaper && state.paperMode.kind !== 'read') issues.push('non-paper surface cannot edit');
  if (!atPaper && state.panel !== 'none') issues.push('non-paper surface cannot own a panel');
  if (!atPaper && state.transient.kind !== 'none' && state.transient.kind !== 'dialog') {
    issues.push('non-paper surface cannot own a workspace transient');
  }
  if (!atPaper && state.keyboard !== 'closed') {
    issues.push('non-paper surface cannot own the keyboard');
  }
  if (
    state.paperMode.kind === 'edit' &&
    state.transient.kind !== 'none' &&
    state.transient.kind !== 'bar-sheet' &&
    state.transient.kind !== 'dialog'
  ) {
    issues.push('editing only permits the controlled bar sheet transient');
  }
  if (state.paperMode.kind === 'edit' && state.keyboard !== 'open') {
    issues.push('edit mode requires a visible software keyboard');
  }
  if (
    state.transient.kind === 'dialog' &&
    state.transient.dialog === 'project-trash' &&
    (state.paperMode.kind !== 'read' || state.panel !== 'none' || state.keyboard !== 'closed')
  ) {
    issues.push('the full-screen Project Trash surface owns a clean read root');
  }
  if (transientOwnsInput(state.transient) && state.panel !== 'none') {
    issues.push('search and Agent input cannot coexist with a panel');
  }
  if (
    state.keyboard === 'open' &&
    state.paperMode.kind !== 'edit' &&
    !transientOwnsInput(state.transient)
  ) {
    issues.push('an open keyboard requires edit, search, or Agent input ownership');
  }

  return issues;
}

export function assertLegalMobileWorkspaceState(state: MobileWorkspaceUiState): void {
  const issues = mobileWorkspaceStateIssues(state);
  if (issues.length > 0) throw new Error(`Illegal mobile workspace state: ${issues.join('; ')}`);
}

function checked(state: MobileWorkspaceUiState): MobileWorkspaceUiState {
  if (import.meta.env.DEV) assertLegalMobileWorkspaceState(state);
  return state;
}

export function mobileWorkspaceReducer(
  state: MobileWorkspaceUiState,
  action: MobileWorkspaceAction,
): MobileWorkspaceUiState {
  switch (action.type) {
    case 'show-paper':
      return resetToSurface(PAPER_SURFACE);
    case 'show-overview':
      return resetToSurface({ kind: 'overview' });
    case 'show-super-view':
      return resetToSurface({ kind: 'super-view', view: action.view });
    case 'open-project-trash':
      return checked({
        ...createInitialMobileWorkspaceUiState(),
        transient: { kind: 'dialog', dialog: 'project-trash' },
      });
    case 'set-panel':
      return checked({
        ...state,
        surface: PAPER_SURFACE,
        paperMode: state.paperMode.kind === 'edit' ? state.paperMode : READ_MODE,
        panel: action.panel,
        transient: NO_TRANSIENT,
        keyboard: state.paperMode.kind === 'edit' ? 'open' : 'closed',
      });
    case 'set-transient': {
      if (
        action.transient.kind === 'dialog' &&
        action.transient.dialog === 'project-trash'
      ) {
        return checked({
          ...createInitialMobileWorkspaceUiState(),
          transient: action.transient,
        });
      }
      if (action.transient.kind === 'dialog') {
        return checked({ ...state, transient: action.transient });
      }
      if (action.transient.kind === 'none') {
        return checked({ ...state, transient: NO_TRANSIENT });
      }
      if (
        action.transient.kind === 'entity-preview' ||
        action.transient.kind === 'paper-status' ||
        action.transient.kind === 'popover'
      ) {
        return checked({
          ...state,
          surface: PAPER_SURFACE,
          paperMode: READ_MODE,
          transient: action.transient,
          keyboard: 'closed',
        });
      }
      if (action.transient.kind === 'bar-sheet') {
        return checked({
          ...state,
          surface: PAPER_SURFACE,
          paperMode: READ_MODE,
          panel: 'none',
          transient: action.transient,
          keyboard: 'closed',
        });
      }
      return checked({
        ...state,
        surface: PAPER_SURFACE,
        paperMode: READ_MODE,
        panel: 'none',
        transient: action.transient,
        keyboard: 'closed',
      });
    }
    case 'sync-editor':
      if (!action.editing) {
        if (state.paperMode.kind === 'read' && state.keyboard === 'closed') return state;
        return checked({ ...state, paperMode: READ_MODE, keyboard: 'closed' });
      }
      if (
        state.surface.kind !== 'paper' ||
        state.transient.kind !== 'none'
      ) {
        return state;
      }
      return checked({
        ...state,
        paperMode: { kind: 'edit', accessory: 'formatting' },
        keyboard: 'open',
      });
    case 'set-editor-accessory':
      if (state.paperMode.kind !== 'edit') return state;
      return checked({
        ...state,
        paperMode: {
          kind: 'edit',
          accessory: action.accessory,
        },
      });
    case 'sync-keyboard':
      if (action.keyboard === 'closed' && state.paperMode.kind === 'edit') {
        return checked({ ...state, paperMode: READ_MODE, keyboard: 'closed' });
      }
      if (
        action.keyboard === 'open' &&
        state.paperMode.kind !== 'edit' &&
        !transientOwnsInput(state.transient)
      ) {
        return state;
      }
      if (state.keyboard === action.keyboard) return state;
      return checked({ ...state, keyboard: action.keyboard });
    case 'replace':
      return checked(action.state);
  }
}

function resolution(
  layer: MobileBackLayer,
  nextState: MobileWorkspaceUiState,
  effect: MobileBackResolution['effect'] = 'none',
): MobileBackResolution {
  return { handled: true, layer, nextState: checked(nextState), effect };
}

/** Resolve exactly one author-visible layer. Super View child layers consume the
 * shared back request before this root resolver runs. */
export function resolveMobileWorkspaceBack(
  state: MobileWorkspaceUiState,
  source: MobileBackSource,
): MobileBackResolution {
  if (state.transient.kind === 'dialog') {
    return resolution('dialog', { ...state, transient: NO_TRANSIENT });
  }
  if (
    state.transient.kind === 'popover' ||
    state.transient.kind === 'paper-status' ||
    state.transient.kind === 'entity-preview' ||
    state.transient.kind === 'bar-sheet'
  ) {
    return resolution('transient', { ...state, transient: NO_TRANSIENT });
  }
  if (state.paperMode.kind === 'edit') {
    return resolution(
      'edit-mode',
      { ...state, paperMode: READ_MODE, keyboard: 'closed' },
      'blur-editor',
    );
  }
  if (transientOwnsInput(state.transient)) {
    return resolution('input', {
      ...state,
      transient: NO_TRANSIENT,
      keyboard: 'closed',
    });
  }
  if (state.keyboard === 'open') {
    return resolution('keyboard', { ...state, keyboard: 'closed' });
  }
  if (state.panel.endsWith('-full')) {
    const side = panelSide(state.panel);
    return resolution('panel-full', {
      ...state,
      panel: side === 'top' ? 'top-docked' : 'bottom-docked',
    });
  }
  if (state.panel.endsWith('-docked')) {
    return resolution('panel-docked', { ...state, panel: 'none' });
  }
  if (state.surface.kind === 'super-view') {
    return resolution('super-view', createInitialMobileWorkspaceUiState());
  }
  if (state.surface.kind === 'overview') {
    return resolution('overview', createInitialMobileWorkspaceUiState());
  }
  if (source === 'android-hardware') {
    return resolution('project-root', state, 'leave-project');
  }
  return { handled: false, layer: null, nextState: state, effect: 'none' };
}

export function selectMobileUnifiedBarProjection(
  state: MobileWorkspaceUiState,
): MobileUnifiedBarProjection {
  const visible = state.surface.kind === 'paper' && state.transient.kind !== 'dialog';
  const mode =
    state.transient.kind === 'search'
      ? 'search'
      : state.transient.kind === 'agent-input'
        ? 'agent-input'
        : state.paperMode.kind === 'edit'
          ? 'edit'
          : 'read';
  const atReadRoot = mode === 'read' && state.transient.kind === 'none';

  return {
    visible,
    mode,
    leftAction:
      state.keyboard === 'open'
        ? 'dismiss-keyboard'
        : atReadRoot
          ? 'disabled'
          : 'back',
    placement: state.panel === 'bottom-docked' ? 'above-bottom-panel' : 'safe-bottom',
  };
}
