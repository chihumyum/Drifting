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
      overlay: 'none',
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
      overlay: 'none',
      transient: { kind: 'none' },
    });
  });

  it('opens formatting on edit entry and preserves an already chosen accessory', () => {
    const state = reduce(paperRoot(), { type: 'sync-editor', editing: true });
    expect(state).toMatchObject({
      paperMode: { kind: 'edit', accessory: 'formatting' }, keyboard: 'open',
    });
    const navigation = reduce(state, { type: 'set-editor-accessory', accessory: 'navigation' });
    expect(navigation.paperMode).toEqual({ kind: 'edit', accessory: 'navigation' });
    expect(reduce(navigation, { type: 'sync-editor', editing: true })).toBe(navigation);
  });

  it('claims the paper for an entity preview sheet', () => {
    let state = reduce(paperRoot(), { type: 'set-overlay', overlay: 'chapters' });
    state = reduce(state, {
      type: 'set-transient',
      transient: { kind: 'entity-preview', target: TARGET },
    });
    expect(state.overlay).toBe('none');
    expect(state.transient).toEqual({ kind: 'entity-preview', target: TARGET });
  });

  it('rejects impossible combinations with actionable reasons', () => {
    const impossible: MobileWorkspaceUiState = {
      surface: { kind: 'overview', returnTo: 'paper' },
      paperMode: { kind: 'edit', accessory: 'formatting' },
      overlay: 'none',
      transient: { kind: 'search', scope: 'project', returnTo: { kind: 'read' } },
      keyboard: 'open',
    };
    expect(mobileWorkspaceStateIssues(impossible)).toEqual(
      expect.arrayContaining([
        'non-paper surface cannot edit',
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
      type: 'open-search',
      scope: 'paper',
    });
    expect(readingSearch).toMatchObject({
      paperMode: { kind: 'read' },
      transient: { kind: 'search', scope: 'paper', returnTo: { kind: 'read' } },
      keyboard: 'closed',
    });
    expect(reduce(readingSearch, { type: 'sync-keyboard', keyboard: 'open' })).toMatchObject({
      paperMode: { kind: 'read' },
      transient: { kind: 'search', scope: 'paper', returnTo: { kind: 'read' } },
      keyboard: 'open',
    });

    const editing = reduce(paperRoot(), { type: 'sync-editor', editing: true });
    const editingSearch = reduce(editing, {
      type: 'open-search',
      scope: 'paper',
    });
    expect(editingSearch).toMatchObject({
      paperMode: { kind: 'read' },
      transient: {
        kind: 'search',
        scope: 'paper',
        returnTo: { kind: 'edit', accessory: 'formatting' },
      },
      keyboard: 'open',
    });
    expect(reduce(editingSearch, { type: 'sync-editor', editing: false })).toBe(editingSearch);
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
      overlay: 'tools',
      transient: { kind: 'dialog', dialog: 'destructive' },
      keyboard: 'closed',
    };

    let result = resolveMobileWorkspaceBack(state, 'visible');
    layers.push(result.layer!);
    state = result.nextState;
    expect(state.overlay).toBe('tools');

    result = resolveMobileWorkspaceBack(state, 'visible');
    layers.push(result.layer!);
    state = result.nextState;
    expect(state.overlay).toBe('none');

    result = resolveMobileWorkspaceBack(state, 'visible');
    layers.push(result.layer!);
    expect(result.effect).toBe('navigate-project-home');

    expect(layers).toEqual(['dialog', 'overlay', 'paper-root']);
  });

  it('unwinds formatting before leaving editing and its keyboard', () => {
    const state: MobileWorkspaceUiState = {
      surface: { kind: 'paper' },
      paperMode: { kind: 'edit', accessory: 'formatting' },
      overlay: 'none',
      transient: { kind: 'none' },
      keyboard: 'open',
    };

    const accessory = resolveMobileWorkspaceBack(state, 'visible');
    expect(accessory.layer).toBe('editor-accessory');
    expect(accessory.effect).toBe('none');
    expect(accessory.nextState.paperMode).toEqual({ kind: 'edit', accessory: 'navigation' });
    expect(accessory.nextState.keyboard).toBe('open');

    const editMode = resolveMobileWorkspaceBack(accessory.nextState, 'visible');
    expect(editMode.layer).toBe('edit-mode');
    expect(editMode.effect).toBe('blur-editor');
    expect(editMode.nextState.paperMode).toEqual({ kind: 'read' });
    expect(editMode.nextState.keyboard).toBe('closed');
  });

  it('closes read-owned search first and normalizes its keyboard', () => {
    const state: MobileWorkspaceUiState = {
      surface: { kind: 'paper' },
      paperMode: { kind: 'read' },
      overlay: 'none',
      transient: { kind: 'search', scope: 'project', returnTo: { kind: 'read' } },
      keyboard: 'open',
    };
    const result = resolveMobileWorkspaceBack(state, 'visible');
    expect(result).toMatchObject({ layer: 'input', effect: 'blur-input' });
    expect(result.nextState).toMatchObject({
      transient: { kind: 'none' },
      keyboard: 'closed',
    });
  });

  it('returns edit-owned search to the focused editor and open keyboard', () => {
    let state = reduce(paperRoot(), { type: 'sync-editor', editing: true });
    state = reduce(state, { type: 'open-search', scope: 'paper' });
    state = reduce(state, { type: 'sync-keyboard', keyboard: 'open' });

    const result = resolveMobileWorkspaceBack(state, 'visible');
    expect(result).toMatchObject({
      layer: 'input',
      effect: 'focus-editor',
      nextState: {
        paperMode: { kind: 'edit', accessory: 'formatting' },
        transient: { kind: 'none' },
        keyboard: 'open',
      },
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

  it.each(['overview', 'super-view', 'voice'] as const)(
    'returns the %s root to its origin',
    (kind) => {
      const state: MobileWorkspaceUiState = {
        ...paperRoot(),
        surface:
          kind === 'super-view'
            ? { kind, view: 'element', returnTo: 'paper' }
            : { kind, returnTo: 'paper' },
      };
      const result = resolveMobileWorkspaceBack(state, 'visible');
      expect(result.layer).toBe(kind);
      expect(result.nextState.surface).toEqual({ kind: 'paper' });
    },
  );
});

describe('Voice surface (fullscreen voice-Agent face)', () => {
  it('captures the launch origin so collapse returns there', () => {
    const fromHome = reduce(createInitialMobileWorkspaceUiState(), { type: 'show-voice' });
    expect(fromHome.surface).toEqual({ kind: 'voice', returnTo: 'project-home' });

    const fromPaper = reduce(paperRoot(), { type: 'show-voice' });
    expect(fromPaper.surface).toEqual({ kind: 'voice', returnTo: 'paper' });

    expect(resolveMobileWorkspaceBack(fromHome, 'visible').nextState.surface).toEqual({
      kind: 'project-home',
    });
    expect(resolveMobileWorkspaceBack(fromPaper, 'android-hardware').nextState.surface).toEqual({
      kind: 'paper',
    });
  });

  it('is idempotent and keeps its origin across repeat requests', () => {
    const voice = reduce(paperRoot(), { type: 'show-voice' });
    expect(reduce(voice, { type: 'show-voice' })).toBe(voice);
  });

  it('refuses launcher overlays while the voice face owns the screen', () => {
    const voice = reduce(createInitialMobileWorkspaceUiState(), { type: 'show-voice' });
    expect(reduce(voice, { type: 'set-overlay', overlay: 'chapters' }).overlay).toBe('none');
    expect(selectMobileUnifiedBarProjection(voice).visible).toBe(false);
  });
});

describe('Mobile V2 unified bar projection', () => {
  it('keeps read-root chrome stable while a docked bottom panel moves the pill', () => {
    const root = paperRoot();
    expect(selectMobileUnifiedBarProjection(root)).toEqual({
      visible: true,
      mode: 'read',
      leftAction: 'back',
    });
  });

  it('derives search, Agent input, edit, keyboard, and hidden surface states', () => {
    const root = paperRoot();
    expect(
      selectMobileUnifiedBarProjection({
        ...root,
        transient: { kind: 'search', scope: 'paper', returnTo: { kind: 'read' } },
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

describe('Launcher overlays (bottom tab bar and the paper tool face)', () => {
  it('opens a structure overlay from Project Home and closes it on back', () => {
    let state = reduce(createInitialMobileWorkspaceUiState(), {
      type: 'set-overlay',
      overlay: 'chapters',
    });
    expect(state.overlay).toBe('chapters');
    expect(state.surface).toEqual({ kind: 'project-home' });

    const back = resolveMobileWorkspaceBack(state, 'visible');
    expect(back.layer).toBe<MobileBackLayer>('overlay');
    state = back.nextState;
    expect(state.overlay).toBe('none');
    expect(state.surface).toEqual({ kind: 'project-home' });
  });

  it('confines the tool face to the paper surface', () => {
    const home = reduce(createInitialMobileWorkspaceUiState(), {
      type: 'set-overlay',
      overlay: 'tools',
    });
    expect(home.overlay).toBe('none');

    const paper = reduce(paperRoot(), { type: 'set-overlay', overlay: 'tools' });
    expect(paper.overlay).toBe('tools');
  });

  it('closes the overlay when editing, search, or a transient claims the paper', () => {
    let state = reduce(paperRoot(), { type: 'set-overlay', overlay: 'elements' });
    expect(reduce(state, { type: 'sync-editor', editing: true }).overlay).toBe('none');
    expect(reduce(state, { type: 'open-search', scope: 'paper' }).overlay).toBe('none');
    state = reduce(state, {
      type: 'set-transient',
      transient: { kind: 'entity-preview', target: TARGET },
    });
    expect(state.overlay).toBe('none');
  });

  it('collapses editing back to read before an overlay may open', () => {
    let state = reduce(paperRoot(), { type: 'sync-editor', editing: true });
    state = reduce(state, { type: 'set-overlay', overlay: 'drifts' });
    expect(state).toMatchObject({
      overlay: 'drifts',
      paperMode: { kind: 'read' },
      keyboard: 'closed',
    });
  });

  it('hides the unified bar while an overlay owns the screen', () => {
    const state = reduce(paperRoot(), { type: 'set-overlay', overlay: 'tools' });
    expect(selectMobileUnifiedBarProjection(state).visible).toBe(false);
  });

  it('refuses a launcher overlay on a super view surface', () => {
    const superView = reduce(createInitialMobileWorkspaceUiState(), {
      type: 'show-super-view',
      view: 'graph',
    });
    expect(reduce(superView, { type: 'set-overlay', overlay: 'chapters' }).overlay).toBe('none');
  });
});

describe('persistent paper tools', () => {
  it('keeps reading and planning tools visible and closes a secondary to the toolbar', () => {
    const root = paperRoot();
    expect(selectMobileUnifiedBarProjection(root)).toMatchObject({ visible: true, mode: 'read' });
    for (const overlay of ['plot', 'timeline'] as const) {
      const tool = reduce(root, { type: 'set-overlay', overlay });
      expect(selectMobileUnifiedBarProjection(tool).visible).toBe(true);
      expect(resolveMobileWorkspaceBack(tool, 'visible').nextState.overlay).toBe('none');
    }
  });
  it('opens Agent without an IME from reading and transfers editing keyboard ownership', () => {
    const root = paperRoot();
    const readAgent = reduce(root, { type: 'open-agent' });
    expect(readAgent.keyboard).toBe('closed');
    expect(selectMobileUnifiedBarProjection(readAgent).mode).toBe('agent-input');
    expect(resolveMobileWorkspaceBack(readAgent, 'visible').nextState).toEqual(root);
    const editing = reduce(root, { type: 'sync-editor', editing: true });
    const agent = reduce(editing, { type: 'open-agent' });
    expect(agent.keyboard).toBe('open');
    expect(reduce(agent, { type: 'sync-editor', editing: false })).toEqual(agent);
    const back = resolveMobileWorkspaceBack(agent, 'visible');
    expect(back.effect).toBe('focus-editor'); expect(back.nextState).toEqual(editing);
  });
});


it('exits read-owned Plot together with its input keyboard', () => {
  const plot = reduce(paperRoot(), { type: 'set-overlay', overlay: 'plot' });
  const typing = reduce(plot, { type: 'sync-keyboard', keyboard: 'open' });
  expect(typing.keyboard).toBe('open');
  const back = resolveMobileWorkspaceBack(typing, 'visible');
  expect(back.effect).toBe('blur-input');
  expect(back.nextState.overlay).toBe('none');
  expect(back.nextState.keyboard).toBe('closed');
  expect(reduce(typing, { type: 'set-overlay', overlay: 'none' }).keyboard).toBe('closed');
});


describe('toolbar workspace edit suspension', () => {
  it.each(['plot', 'timeline'] as const)('restores the original formatting mode after %s', (overlay) => {
    const editing = reduce(reduce(paperRoot(), { type: 'sync-editor', editing: true }),
      { type: 'set-editor-accessory', accessory: 'formatting' });
    const tool = reduce(editing, { type: 'set-overlay', overlay });
    expect(tool.paperMode.kind).toBe('read');
    expect(tool.keyboard).toBe('open');
    // Native blur/IME callbacks and stale editor focus cannot erase the origin.
    expect(reduce(tool, { type: 'sync-editor', editing: false })).toEqual(tool);
    expect(reduce(tool, { type: 'sync-editor', editing: true })).toEqual(tool);
    expect(reduce(tool, { type: 'sync-keyboard', keyboard: 'closed' }).toolReturnTo).toEqual(editing.paperMode);
    const back = resolveMobileWorkspaceBack(tool, 'visible');
    expect(back.nextState).toEqual(editing);
    expect(back.effect).toBe('focus-editor');
    expect(reduce(tool, { type: 'set-overlay', overlay: 'none' })).toEqual(editing);
  });

  it('returns Plot input directly to the suspended prose editor', () => {
    const editing = reduce(paperRoot(), { type: 'sync-editor', editing: true });
    const tool = reduce(editing, { type: 'set-overlay', overlay: 'plot' });
    const typing = reduce(tool, { type: 'sync-keyboard', keyboard: 'open' });
    const dismiss = resolveMobileWorkspaceBack(typing, 'android-hardware');
    expect(dismiss.effect).toBe('focus-editor');
    expect(dismiss.nextState).toEqual(editing);
  });

  it('retains the original editor across secondary tools and Agent', () => {
    const editing = reduce(paperRoot(), { type: 'sync-editor', editing: true });
    const plot = reduce(editing, { type: 'set-overlay', overlay: 'plot' });
    const timeline = reduce(plot, { type: 'set-overlay', overlay: 'timeline' });
    expect(resolveMobileWorkspaceBack(timeline, 'visible').nextState).toEqual(editing);
    const agent = reduce(timeline, { type: 'open-agent' });
    const back = resolveMobileWorkspaceBack(agent, 'visible');
    expect(back.effect).toBe('focus-editor');
    expect(back.nextState).toEqual(editing);
  });

  it('never revives editing after leaving the paper or opening a structure overlay', () => {
    const editing = reduce(paperRoot(), { type: 'sync-editor', editing: true });
    const tool = reduce(editing, { type: 'set-overlay', overlay: 'timeline' });
    expect(reduce(tool, { type: 'show-paper' })).toEqual(paperRoot());
    const structure = reduce(tool, { type: 'set-overlay', overlay: 'chapters' });
    expect(structure.toolReturnTo).toBeUndefined();
    expect(resolveMobileWorkspaceBack(structure, 'visible').nextState).toEqual(paperRoot());
  });
});


describe('accessory destination Back contract', () => {
  for (const source of ['visible', 'keyboard', 'android-hardware'] as const) {
    for (const origin of ['read', 'edit'] as const) {
      for (const keyboard of ['closed', 'open'] as const) {
        it.each(['agent', 'search', 'plot', 'timeline'] as const)(
          `${source}: ${origin} → %s (${keyboard} keyboard) → origin in one Back`,
          (tool) => {
            let root = paperRoot();
            if (origin === 'edit') {
              root = reduce(reduce(root, { type: 'sync-editor', editing: true }),
                { type: 'set-editor-accessory', accessory: 'navigation' });
            }
            let active = reduce(root, tool === 'agent' ? { type: 'open-agent' }
              : tool === 'search' ? { type: 'open-search', scope: 'paper' }
                : { type: 'set-overlay', overlay: tool });
            active = reduce(active, { type: 'sync-keyboard', keyboard });
            // Delayed prose blur while another tool owns input cannot erase origin.
            active = reduce(active, { type: 'sync-editor', editing: false });
            const back = resolveMobileWorkspaceBack(active, source);
            expect(back.nextState).toEqual(root);
            expect(back.effect).toBe(origin === 'edit' ? 'focus-editor'
              : keyboard === 'open' ? 'blur-input' : 'none');
            expect(selectMobileUnifiedBarProjection(back.nextState).mode).toBe(origin);
            if (origin === 'edit') {
              const dismiss = resolveMobileWorkspaceBack(back.nextState, source);
              expect(dismiss.layer).toBe('edit-mode');
              expect(dismiss.effect).toBe('blur-editor');
              expect(dismiss.nextState).toEqual(paperRoot());
            }
          },
        );
      }
    }
  }
});
