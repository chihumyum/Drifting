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

const paperRoot = () =>
  mobileWorkspaceReducer(createInitialMobileWorkspaceUiState(), { type: 'show-paper' });

describe('Mobile V2 workspace controller', () => {
  it('starts at the legal Project Home root', () => {
    const state = createInitialMobileWorkspaceUiState();
    expect(state).toEqual({
      surface: { kind: 'project-home' },
      paperMode: { kind: 'read' },
      panel: 'none',
      transient: { kind: 'none' },
      keyboard: 'closed',
    });
    expect(() => assertLegalMobileWorkspaceState(state)).not.toThrow();
  });

  it('makes Overview and Super Views exclusive surfaces outside the paper session', () => {
    const overview = reduce(createInitialMobileWorkspaceUiState(), { type: 'show-overview' });
    expect(overview.surface).toEqual({ kind: 'overview', returnTo: 'project-home' });

    const superView = reduce(overview, { type: 'show-super-view', view: 'graph' });
    expect(superView).toMatchObject({
      surface: { kind: 'super-view', view: 'graph', returnTo: 'project-home' },
      panel: 'none',
      transient: { kind: 'none' },
    });
  });

  it('keeps the keyboard accessory independent from an existing context panel', () => {
    let state = reduce(paperRoot(), { type: 'sync-editor', editing: true });
    state = reduce(state, { type: 'set-panel', panel: 'top-full' });
    expect(state).toMatchObject({
      surface: { kind: 'paper' },
      paperMode: { kind: 'edit', accessory: 'navigation' },
      panel: 'top-full',
      transient: { kind: 'none' },
      keyboard: 'open',
    });
  });

  it('switches accessory levels without leaving edit mode or closing the keyboard', () => {
    let state = reduce(paperRoot(), { type: 'sync-editor', editing: true });
    expect(state).toMatchObject({
      paperMode: { kind: 'edit', accessory: 'navigation' },
      keyboard: 'open',
    });

    state = reduce(state, { type: 'set-editor-accessory', accessory: 'formatting' });
    expect(state).toMatchObject({
      paperMode: { kind: 'edit', accessory: 'formatting' },
      keyboard: 'open',
    });
  });

  it('preserves the owning panel under an entity preview sheet', () => {
    let state = reduce(paperRoot(), {
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
      surface: { kind: 'overview', returnTo: 'paper' },
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

  it('keeps Search input ownership out of paper edit mode', () => {
    const readingSearch = reduce(paperRoot(), {
      type: 'set-transient',
      transient: { kind: 'search', scope: 'paper' },
    });
    expect(readingSearch).toMatchObject({
      paperMode: { kind: 'read' },
      transient: { kind: 'search', scope: 'paper' },
      keyboard: 'closed',
    });
    expect(reduce(readingSearch, { type: 'sync-keyboard', keyboard: 'open' })).toMatchObject({
      paperMode: { kind: 'read' },
      transient: { kind: 'search', scope: 'paper' },
      keyboard: 'open',
    });

    const editing = reduce(paperRoot(), { type: 'sync-editor', editing: true });
    const editingSearch = reduce(editing, {
      type: 'set-transient',
      transient: { kind: 'search', scope: 'paper' },
    });
    expect(editingSearch).toMatchObject({
      paperMode: { kind: 'read' },
      transient: { kind: 'search', scope: 'paper' },
      keyboard: 'closed',
    });
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

  it('unwinds formatting before leaving editing and its keyboard', () => {
    let state: MobileWorkspaceUiState = {
      surface: { kind: 'paper' },
      paperMode: { kind: 'edit', accessory: 'formatting' },
      panel: 'bottom-docked',
      transient: { kind: 'none' },
      keyboard: 'open',
    };

    const accessory = resolveMobileWorkspaceBack(state, 'visible');
    expect(accessory.layer).toBe('editor-accessory');
    expect(accessory.effect).toBe('none');
    expect(accessory.nextState.paperMode).toEqual({ kind: 'edit', accessory: 'navigation' });
    expect(accessory.nextState.keyboard).toBe('open');
    expect(accessory.nextState.panel).toBe('bottom-docked');

    state = accessory.nextState;
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

  it('moves from a paper to Project Home, then from Home to the shelf', () => {
    const paper = paperRoot();
    expect(resolveMobileWorkspaceBack(paper, 'visible')).toMatchObject({
      handled: true,
      layer: 'paper-root',
      effect: 'navigate-project-home',
      nextState: { surface: { kind: 'project-home' } },
    });
    const home = createInitialMobileWorkspaceUiState();
    expect(resolveMobileWorkspaceBack(home, 'android-hardware')).toMatchObject({
      handled: true,
      layer: 'project-root',
      effect: 'leave-project',
    });
  });

  it.each(['overview', 'super-view'] as const)('returns the %s root to its origin', (kind) => {
    const state: MobileWorkspaceUiState = {
      ...paperRoot(),
      surface:
        kind === 'overview'
          ? { kind, returnTo: 'paper' }
          : { kind, view: 'element', returnTo: 'paper' },
    };
    const result = resolveMobileWorkspaceBack(state, 'visible');
    expect(result.layer).toBe(kind);
    expect(result.nextState.surface).toEqual({ kind: 'paper' });
  });
});

describe('Mobile V2 unified bar projection', () => {
  it('keeps read-root chrome stable while a docked bottom panel moves the pill', () => {
    const root = paperRoot();
    expect(selectMobileUnifiedBarProjection(root)).toEqual({
      visible: true,
      mode: 'read',
      leftAction: 'back',
      placement: 'safe-bottom',
    });
    expect(
      selectMobileUnifiedBarProjection({ ...root, panel: 'bottom-docked' }),
    ).toMatchObject({ leftAction: 'back', placement: 'above-bottom-panel' });
  });

  it('derives search, Agent input, edit, keyboard, and hidden surface states', () => {
    const root = paperRoot();
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
    ).toMatchObject({ mode: 'edit', leftAction: 'back' });
    expect(
      selectMobileUnifiedBarProjection({
        ...root,
        surface: { kind: 'overview', returnTo: 'paper' },
      }).visible,
    ).toBe(false);
  });
});
