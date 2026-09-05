import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';

export type MobileSuperViewId = 'element' | 'graph' | 'memo-material';

export type MobileWorkspaceSurface =
  | { kind: 'project-home' }
  | { kind: 'paper' }
  | { kind: 'overview'; returnTo: 'project-home' | 'paper' }
  | { kind: 'super-view'; view: MobileSuperViewId; returnTo: 'project-home' | 'paper' }
  | { kind: 'voice'; returnTo: 'project-home' | 'paper' };

export type MobilePaperMode =
  | { kind: 'read' }
  | { kind: 'edit'; accessory: 'navigation' | 'formatting' };

export type MobileSearchReturnMode = MobilePaperMode;

/** Structure launchers, the right panel, paper switches, and toolbar workspaces. */
export type MobileWorkspaceOverlay =
  | 'none'
  | 'chapters'
  | 'elements'
  | 'drifts'
  | 'tools'
  | 'paper-tools'
  | 'plot'
  | 'timeline';

export type MobileWorkspaceTransient =
  | { kind: 'none' }
  | {
      kind: 'search';
      scope: 'paper' | 'project';
      returnTo: MobileSearchReturnMode;
    }
  | { kind: 'agent-input'; returnTo?: MobilePaperMode }
  | { kind: 'popover'; id: string }
  | { kind: 'entity-preview'; target: WorkspaceTarget }
  | { kind: 'dialog'; dialog: 'project-trash' | 'destructive' | 'native' };

export type MobileKeyboardState = 'closed' | 'open';

export interface MobileWorkspaceUiState {
  surface: MobileWorkspaceSurface;
  paperMode: MobilePaperMode;
  overlay: MobileWorkspaceOverlay;
  transient: MobileWorkspaceTransient;
  keyboard: MobileKeyboardState;
}

export type MobileWorkspaceAction =
  | { type: 'show-paper' }
  | { type: 'show-project-home' }
  | { type: 'show-overview' }
  | { type: 'show-super-view'; view: MobileSuperViewId }
  | { type: 'show-voice' }
  | { type: 'open-project-trash' }
  | { type: 'set-overlay'; overlay: MobileWorkspaceOverlay }
  | { type: 'open-search'; scope: 'paper' | 'project' }
  | { type: 'open-agent' }
  | {
      type: 'set-transient';
      transient: Exclude<MobileWorkspaceTransient, { kind: 'search' }>;
    }
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
  | 'overlay'
  | 'super-view'
  | 'voice'
  | 'overview'
  | 'editor-accessory'
  | 'edit-mode'
  | 'paper-root'
  | 'project-root';

export interface MobileBackResolution {
  handled: boolean;
  layer: MobileBackLayer | null;
  nextState: MobileWorkspaceUiState;
  effect:
    | 'none'
    | 'blur-editor'
    | 'blur-input'
    | 'focus-editor'
    | 'navigate-project-home'
    | 'leave-project';
}

export interface MobileUnifiedBarProjection {
  visible: boolean;
  mode: 'read' | 'edit' | 'search' | 'agent-input';
  leftAction: 'back';
}

const PAPER_SURFACE: MobileWorkspaceSurface = { kind: 'paper' };
const READ_MODE: MobilePaperMode = { kind: 'read' };
const NO_TRANSIENT: MobileWorkspaceTransient = { kind: 'none' };

export function createInitialMobileWorkspaceUiState(): MobileWorkspaceUiState {
  return {
    surface: { kind: 'project-home' },
    paperMode: READ_MODE,
    overlay: 'none',
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

function returnSurfaceFor(surface: MobileWorkspaceSurface): 'project-home' | 'paper' {
  if (surface.kind === 'project-home') return 'project-home';
  if (
    surface.kind === 'overview' ||
    surface.kind === 'super-view' ||
    surface.kind === 'voice'
  ) {
    return surface.returnTo;
  }
  return 'paper';
}

function transientOwnsInput(transient: MobileWorkspaceTransient): boolean {
  return transient.kind === 'search' || transient.kind === 'agent-input';
}

export function mobileWorkspaceStateIssues(state: MobileWorkspaceUiState): string[] {
  const issues: string[] = [];
  const atPaper = state.surface.kind === 'paper';

  if (!atPaper && state.paperMode.kind !== 'read') issues.push('non-paper surface cannot edit');
  if (state.overlay !== 'none') {
    if (state.surface.kind === 'super-view') {
      issues.push('a super view cannot host a launcher overlay');
    }
    if (
      (state.overlay === 'tools' ||
        state.overlay === 'paper-tools' ||
        state.overlay === 'plot' || state.overlay === 'timeline') &&
      !atPaper
    ) {
      issues.push('the tool faces belong to the paper surface');
    }
    if (state.overlay !== 'paper-tools') {
      if (state.paperMode.kind !== 'read') issues.push('a launcher overlay requires read mode');
      if (state.keyboard !== 'closed' && state.overlay !== 'plot') {
        issues.push('a launcher overlay requires a closed keyboard');
      }
      if (state.transient.kind !== 'none' && state.transient.kind !== 'dialog') {
        issues.push('a launcher overlay cannot coexist with a workspace transient');
      }
    }
  }
  if (!atPaper && state.transient.kind !== 'none' && state.transient.kind !== 'dialog') {
    issues.push('non-paper surface cannot own a workspace transient');
  }
  if (!atPaper && state.keyboard !== 'closed') {
    issues.push('non-paper surface cannot own the keyboard');
  }
  if (
    state.paperMode.kind === 'edit' &&
    state.transient.kind !== 'none' &&
    state.transient.kind !== 'dialog'
  ) {
    issues.push('editing permits no workspace transient beyond a dialog');
  }
  if (state.paperMode.kind === 'edit' && state.keyboard !== 'open') {
    issues.push('edit mode requires a visible software keyboard');
  }
  if (
    state.transient.kind === 'dialog' &&
    state.transient.dialog === 'project-trash' &&
    (state.paperMode.kind !== 'read' || state.keyboard !== 'closed')
  ) {
    issues.push('the full-screen Project Trash surface owns a clean read root');
  }
  if (
    state.keyboard === 'open' &&
    state.paperMode.kind !== 'edit' &&
    !transientOwnsInput(state.transient) && state.overlay !== 'plot'
  ) {
    issues.push('an open keyboard requires edit, search, plot, or Agent input ownership');
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
    case 'show-project-home':
      return resetToSurface({ kind: 'project-home' });
    case 'show-overview':
      return resetToSurface({
        kind: 'overview',
        returnTo: returnSurfaceFor(state.surface),
      });
    case 'show-super-view':
      return resetToSurface({
        kind: 'super-view',
        view: action.view,
        returnTo: returnSurfaceFor(state.surface),
      });
    case 'show-voice':
      if (state.surface.kind === 'voice') return state;
      return resetToSurface({
        kind: 'voice',
        returnTo: returnSurfaceFor(state.surface),
      });
    case 'open-project-trash':
      return checked({
        ...createInitialMobileWorkspaceUiState(),
        transient: { kind: 'dialog', dialog: 'project-trash' },
      });
    case 'set-overlay': {
      if (action.overlay === 'none') {
        if (state.overlay === 'none') return state;
        return checked({ ...state, overlay: 'none', keyboard: state.overlay === 'plot' ? 'closed' : state.keyboard });
      }
      if (state.surface.kind === 'super-view' || state.surface.kind === 'voice') return state;
      if (
        (action.overlay === 'tools' ||
          action.overlay === 'paper-tools' ||
          action.overlay === 'plot' || action.overlay === 'timeline') &&
        state.surface.kind !== 'paper'
      ) {
        return state;
      }
      return checked({
        ...state,
        paperMode: READ_MODE,
        overlay: action.overlay,
        transient: NO_TRANSIENT,
        keyboard: 'closed',
      });
    }
    case 'open-search':
    case 'open-agent':
      if (state.surface.kind !== 'paper' || state.transient.kind !== 'none') return state;
      return checked({
        ...state,
        surface: PAPER_SURFACE,
        paperMode: READ_MODE,
        overlay: state.overlay === 'paper-tools' ? 'paper-tools' : 'none',
        transient: action.type === 'open-agent'
          ? { kind: 'agent-input', returnTo: state.paperMode }
          : { kind: 'search', scope: action.scope, returnTo: state.paperMode },
        // Editing already owns a visible IME. Search transfers that same input
        // session to its field; declaring a closed intermediate frame would
        // collapse the shared paper geometry before the field can take focus.
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
        action.transient.kind === 'popover'
      ) {
        return checked({
          ...state,
          surface: PAPER_SURFACE,
          paperMode: READ_MODE,
          overlay: state.overlay === 'paper-tools' ? 'paper-tools' : 'none',
          transient: action.transient,
          keyboard: 'closed',
        });
      }
      return checked({
        ...state,
        surface: PAPER_SURFACE,
        paperMode: READ_MODE,
        overlay: state.overlay === 'paper-tools' ? 'paper-tools' : 'none',
        transient: action.transient,
        keyboard: 'closed',
      });
    }
    case 'sync-editor':
      if (action.editing && state.paperMode.kind === 'edit') return state;
      if (!action.editing) {
        // Search and Agent input own their own keyboard while the paper remains
        // read-only. A delayed editor blur must not close that input keyboard.
        if (state.paperMode.kind === 'read') return state;
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
        overlay: state.overlay === 'paper-tools' ? 'paper-tools' : 'none',
        paperMode: { kind: 'edit', accessory: 'navigation' },
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
        !transientOwnsInput(state.transient) && state.overlay !== 'plot'
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
  void source;
  if (state.transient.kind === 'dialog') {
    return resolution('dialog', { ...state, transient: NO_TRANSIENT });
  }
  if (
    state.transient.kind === 'popover' ||
    state.transient.kind === 'entity-preview'
  ) {
    return resolution('transient', { ...state, transient: NO_TRANSIENT });
  }
  if (state.transient.kind === 'search' || state.transient.kind === 'agent-input') {
    const returnTo = state.transient.returnTo ?? READ_MODE;
    const returnToEditing = returnTo.kind === 'edit';
    return resolution(
      'input',
      {
        ...state,
        paperMode: returnTo,
        transient: NO_TRANSIENT,
        keyboard: returnToEditing ? 'open' : 'closed',
      },
      returnToEditing ? 'focus-editor' : 'none',
    );
  }
  if (state.paperMode.kind === 'edit' && state.paperMode.accessory === 'formatting') {
    return resolution('editor-accessory', {
      ...state,
      paperMode: { kind: 'edit', accessory: 'navigation' },
    });
  }
  if (state.paperMode.kind === 'edit') {
    return resolution(
      'edit-mode',
      { ...state, paperMode: READ_MODE, keyboard: 'closed' },
      'blur-editor',
    );
  }
  if (state.keyboard === 'open') {
    return resolution('keyboard', { ...state, keyboard: 'closed' }, 'blur-input');
  }

  if (state.overlay !== 'none') {
    return resolution('overlay', { ...state, overlay: 'none' });
  }
  if (state.surface.kind === 'voice') {
    return resolution(
      'voice',
      resetToSurface(
        state.surface.returnTo === 'project-home' ? { kind: 'project-home' } : PAPER_SURFACE,
      ),
    );
  }
  if (state.surface.kind === 'super-view') {
    return resolution(
      'super-view',
      resetToSurface(
        state.surface.returnTo === 'project-home' ? { kind: 'project-home' } : PAPER_SURFACE,
      ),
    );
  }
  if (state.surface.kind === 'overview') {
    return resolution(
      'overview',
      resetToSurface(
        state.surface.returnTo === 'project-home' ? { kind: 'project-home' } : PAPER_SURFACE,
      ),
    );
  }
  if (state.surface.kind === 'paper') {
    return resolution(
      'paper-root',
      resetToSurface({ kind: 'project-home' }),
      'navigate-project-home',
    );
  }
  if (state.surface.kind === 'project-home') {
    return resolution('project-root', state, 'leave-project');
  }
  return { handled: false, layer: null, nextState: state, effect: 'none' };
}

export function selectMobileUnifiedBarProjection(
  state: MobileWorkspaceUiState,
): MobileUnifiedBarProjection {
  // Paper switches and toolbar workspaces retain the persistent tool strip.
  const visible =
    state.surface.kind === 'paper' &&
    state.transient.kind !== 'dialog' &&
    (state.overlay === 'none' || state.overlay === 'paper-tools' || state.overlay === 'plot' || state.overlay === 'timeline');
  const mode =
    state.transient.kind === 'search'
      ? 'search'
      : state.transient.kind === 'agent-input'
        ? 'agent-input'
        : state.paperMode.kind === 'edit'
          ? 'edit'
          : 'read';
  return {
    visible,
    mode,
    leftAction: 'back',
  };
}
