import { describe, expect, it } from 'vitest';
import {
  assertLegalMobileWorkspaceState,
  createInitialMobileWorkspaceUiState,
  mobileWorkspaceReducer,
  mobileWorkspaceStateIssues,
  resolveMobileWorkspaceBack,
  selectMobileUnifiedBarProjection,
  type MobileBackLayer,
  type MobileWorkspaceUiState,
} from './mobile-workspace-controller';

const TARGET = { entityType: 'node' as const, id: 'synthetic-chapter' };

function reduce(
  state: MobileWorkspaceUiState,
  action: Parameters<typeof mobileWorkspaceReducer>[1],
): MobileWorkspaceUiState {
  const next = mobileWorkspaceReducer(state, action);
  expect(mobileWorkspaceStateIssues(next)).toEqual([]);
  return next;
}

describe('Mobile V2 workspace controller', () => {
  it('starts at a legal read root', () => {
    const state = createInitialMobileWorkspaceUiState();
    expect(state).toEqual({
      surface: { kind: 'paper' },
      paperMode: { kind: 'read' },
      panel: 'none',
      transient: { kind: 'none' },
      keyboard: 'closed',
    });
    expect(() => assertLegalMobileWorkspaceState(state)).not.toThrow();
  });

  it('makes Overview and Super Views exclusive surfaces outside the paper session', () => {
    const overview = reduce(createInitialMobileWorkspaceUiState(), { type: 'show-overview' });
    expect(overview.surface).toEqual({ kind: 'overview' });

    const superView = reduce(overview, { type: 'show-super-view', view: 'graph' });
    expect(superView).toMatchObject({
      surface: { kind: 'super-view', view: 'graph' },
      panel: 'none',
      transient: { kind: 'none' },
    });
  });

  it('keeps the keyboard accessory independent from an existing context panel', () => {
    let state = reduce(createInitialMobileWorkspaceUiState(), { type: 'sync-editor', editing: true });
    state = reduce(state, { type: 'set-panel', panel: 'top-full' });
    expect(state).toMatchObject({
      surface: { kind: 'paper' },
      paperMode: { kind: 'edit', accessory: 'formatting' },
      panel: 'top-full',
      transient: { kind: 'none' },
      keyboard: 'open',
    });
  });

  it('preserves the owning panel under an entity preview sheet', () => {
    let state = reduce(createInitialMobileWorkspaceUiState(), {
      type: 'set-panel',
      panel: 'top-docked',
    });
    state = reduce(state, {
      type: 'set-transient',
      transient: { kind: 'entity-preview', target: TARGET },
    });
    expect(state.panel).toBe('top-docked');
    expect(state.transient).toEqual({ kind: 'entity-preview', target: TARGET });
  });

  it('rejects impossible combinations with actionable reasons', () => {
    const impossible: MobileWorkspaceUiState = {
      surface: { kind: 'overview' },
      paperMode: { kind: 'edit', accessory: 'formatting' },
      panel: 'bottom-full',
      transient: { kind: 'search', scope: 'project' },
      keyboard: 'open',
    };
    expect(mobileWorkspaceStateIssues(impossible)).toEqual(
      expect.arrayContaining([
        'non-paper surface cannot edit',
        'non-paper surface cannot own a panel',
        'non-paper surface cannot own a workspace transient',
        'non-paper surface cannot own the keyboard',
      ]),
    );
    expect(() => assertLegalMobileWorkspaceState(impossible)).toThrow(
      /Illegal mobile workspace state/,
    );
  });

  it('ignores keyboard-open requests without an input owner', () => {
    const root = createInitialMobileWorkspaceUiState();
    expect(reduce(root, { type: 'sync-keyboard', keyboard: 'open' })).toBe(root);
  });

  it('rejects the caret-less pseudo-edit state', () => {
    expect(
      mobileWorkspaceStateIssues({
        ...createInitialMobileWorkspaceUiState(),
        paperMode: { kind: 'edit', accessory: 'formatting' },
      }),
    ).toContain('edit mode requires a visible software keyboard');
  });
});

describe('Mobile V2 Back priority', () => {
  it('unwinds one layer per request in the frozen priority order', () => {
    const layers: MobileBackLayer[] = [];
    let state: MobileWorkspaceUiState = {
      surface: { kind: 'paper' },
      paperMode: { kind: 'read' },
      panel: 'bottom-full',
      transient: { kind: 'dialog', dialog: 'destructive' },
      keyboard: 'closed',
    };

    let result = resolveMobileWorkspaceBack(state, 'visible');
    layers.push(result.layer!);
    state = result.nextState;
    expect(state.panel).toBe('bottom-full');

    state = reduce(state, {
      type: 'set-transient',
      transient: { kind: 'entity-preview', target: TARGET },
    });
    result = resolveMobileWorkspaceBack(state, 'visible');
    layers.push(result.layer!);
    state = result.nextState;
    expect(state.panel).toBe('bottom-full');

    result = resolveMobileWorkspaceBack(state, 'visible');
    layers.push(result.layer!);
    state = result.nextState;
    expect(state.panel).toBe('bottom-docked');

    result = resolveMobileWorkspaceBack(state, 'visible');
    layers.push(result.layer!);
    state = result.nextState;
    expect(state.panel).toBe('none');

    expect(layers).toEqual(['dialog', 'transient', 'panel-full', 'panel-docked']);
  });

  it('leaves editing and its keyboard atomically without a caret-less intermediate state', () => {
    let state: MobileWorkspaceUiState = {
      surface: { kind: 'paper' },
      paperMode: { kind: 'edit', accessory: 'formatting' },
      panel: 'bottom-docked',
      transient: { kind: 'none' },
      keyboard: 'open',
    };

    const editMode = resolveMobileWorkspaceBack(state, 'visible');
    expect(editMode.layer).toBe('edit-mode');
    expect(editMode.effect).toBe('blur-editor');
    expect(editMode.nextState.paperMode).toEqual({ kind: 'read' });
    expect(editMode.nextState.keyboard).toBe('closed');
    expect(editMode.nextState.panel).toBe('bottom-docked');

    state = editMode.nextState;
    const panel = resolveMobileWorkspaceBack(state, 'visible');
    expect(panel.layer).toBe('panel-docked');
  });

  it('closes search before the panel and normalizes its keyboard', () => {
    const state: MobileWorkspaceUiState = {
      surface: { kind: 'paper' },
      paperMode: { kind: 'read' },
      panel: 'none',
      transient: { kind: 'search', scope: 'project' },
      keyboard: 'open',
    };
    const result = resolveMobileWorkspaceBack(state, 'visible');
    expect(result).toMatchObject({ layer: 'input', effect: 'none' });
    expect(result.nextState).toMatchObject({
      transient: { kind: 'none' },
      keyboard: 'closed',
    });
  });

  it('leaves the Project only for Android hardware Back at the read root', () => {
    const root = createInitialMobileWorkspaceUiState();
    expect(resolveMobileWorkspaceBack(root, 'visible').handled).toBe(false);
    expect(resolveMobileWorkspaceBack(root, 'keyboard').handled).toBe(false);
    expect(resolveMobileWorkspaceBack(root, 'android-hardware')).toMatchObject({
      handled: true,
      layer: 'project-root',
      effect: 'leave-project',
    });
  });

  it.each(['overview', 'super-view'] as const)('closes the %s root to the paper', (kind) => {
    const state: MobileWorkspaceUiState = {
      ...createInitialMobileWorkspaceUiState(),
      surface: kind === 'overview' ? { kind } : { kind, view: 'element' },
    };
    const result = resolveMobileWorkspaceBack(state, 'visible');
    expect(result.layer).toBe(kind);
    expect(result.nextState.surface).toEqual({ kind: 'paper' });
  });
});

describe('Mobile V2 unified bar projection', () => {
  it('keeps read-root chrome stable while a docked bottom panel moves the pill', () => {
    const root = createInitialMobileWorkspaceUiState();
    expect(selectMobileUnifiedBarProjection(root)).toEqual({
      visible: true,
      mode: 'read',
      leftAction: 'disabled',
      placement: 'safe-bottom',
    });
    expect(
      selectMobileUnifiedBarProjection({ ...root, panel: 'bottom-docked' }),
    ).toMatchObject({ leftAction: 'disabled', placement: 'above-bottom-panel' });
  });

  it('derives search, Agent input, edit, keyboard, and hidden surface states', () => {
    const root = createInitialMobileWorkspaceUiState();
    expect(
      selectMobileUnifiedBarProjection({
        ...root,
        transient: { kind: 'search', scope: 'paper' },
      }).mode,
    ).toBe('search');
    expect(
      selectMobileUnifiedBarProjection({ ...root, transient: { kind: 'agent-input' } }).mode,
    ).toBe('agent-input');
    expect(
      selectMobileUnifiedBarProjection({
        ...root,
        paperMode: { kind: 'edit', accessory: 'navigation' },
        keyboard: 'open',
      }),
    ).toMatchObject({ mode: 'edit', leftAction: 'dismiss-keyboard' });
    expect(
      selectMobileUnifiedBarProjection({ ...root, surface: { kind: 'overview' } }).visible,
    ).toBe(false);
  });
});
