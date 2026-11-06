import { describe, expect, it } from 'vitest';
import {
  createMobileDeskState,
  mobileDeskReducer,
  readMobileDeskPreferences,
  resolveMobileDeskBack,
  writeMobileDeskPreferences,
  type MobileDeskAction,
  type MobileDeskState,
} from './mobile-desk-controller';

function run(state: MobileDeskState, ...actions: MobileDeskAction[]) {
  return actions.reduce(mobileDeskReducer, state);
}

describe('mobile desk controller', () => {
  it('opens on the paper with nothing laid over it', () => {
    const state = createMobileDeskState();
    expect(state).toMatchObject({ stage: 'paper', drawer: 'none', bottom: null, superView: null, sheet: 'none', writing: false });
    expect(state.left).toBe('nodes');
    expect(state.right).toBe('companion');
  });

  it('keeps one thing beside the paper at a time', () => {
    let state = run(createMobileDeskState(), { type: 'open-bottom' });
    expect(state.bottom).toEqual({ pane: 'timeline', detent: 'half' });
    state = run(state, { type: 'open-drawer', side: 'left', panel: 'elements' });
    expect(state.bottom).toBeNull();
    expect(state).toMatchObject({ drawer: 'left', left: 'elements' });
    state = run(state, { type: 'open-bottom', pane: 'planner' });
    expect(state.drawer).toBe('none');
    expect(state.lastBottomPane).toBe('planner');
  });

  it('puts everything away when the author starts writing', () => {
    const state = run(
      createMobileDeskState(),
      { type: 'open-drawer', side: 'right' },
      { type: 'sync-writing', writing: true },
    );
    expect(state).toMatchObject({ writing: true, drawer: 'none', bottom: null, stage: 'paper' });
  });

  it('ignores a drawer panel that belongs to the other side', () => {
    const state = run(createMobileDeskState(), { type: 'open-drawer', side: 'left', panel: 'review' });
    expect(state.left).toBe('nodes');
  });

  it('takes back the last thing laid on first', () => {
    let state = run(
      createMobileDeskState(),
      { type: 'sync-writing', writing: true },
      { type: 'set-keyboard-bar', bar: 'format' },
    );
    const layers: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const back = resolveMobileDeskBack(state, 'android-hardware');
      if (!back.handled) break;
      layers.push(`${back.layer}:${back.effect}`);
      state = back.nextState;
    }
    expect(layers).toEqual(['keyboard-bar:none', 'writing:blur-editor', 'paper-root:show-home', 'home-root:leave-project']);
  });

  it('closes a tool sheet before the tool', () => {
    let state = run(createMobileDeskState(), { type: 'open-bottom', pane: 'planner' }, { type: 'set-popover', popover: 'plot-cell' });
    expect(resolveMobileDeskBack(state, 'visible').layer).toBe('popover');
    state = resolveMobileDeskBack(state, 'visible').nextState;
    expect(resolveMobileDeskBack(state, 'visible').layer).toBe('bottom');
  });

  it('closes a Super View before the drawer beneath it, and Escape stops at the paper', () => {
    let state = run(createMobileDeskState(), { type: 'open-drawer', side: 'left' });
    state = { ...state, superView: 'graph' };
    expect(resolveMobileDeskBack(state, 'keyboard').layer).toBe('super-view');
    state = resolveMobileDeskBack(state, 'keyboard').nextState;
    expect(resolveMobileDeskBack(state, 'keyboard').layer).toBe('drawer');
    state = resolveMobileDeskBack(state, 'keyboard').nextState;
    expect(resolveMobileDeskBack(state, 'keyboard').handled).toBe(false);
  });

  it('remembers panels per book and survives a broken store', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    const state = run(createMobileDeskState(), { type: 'set-left-panel', panel: 'drift' }, { type: 'set-right-panel', panel: 'review' });
    writeMobileDeskPreferences(storage, 'p1', state);
    expect(createMobileDeskState(readMobileDeskPreferences(storage, 'p1'))).toMatchObject({ left: 'drift', right: 'review' });
    expect(readMobileDeskPreferences(storage, 'p2')).toEqual({});
    const broken = { getItem: () => { throw new Error('blocked'); } };
    expect(readMobileDeskPreferences(broken, 'p1')).toEqual({});
  });
});
