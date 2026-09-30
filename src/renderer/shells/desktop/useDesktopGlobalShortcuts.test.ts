import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceNavigator, WorkspaceTarget } from '../../features/workspace/navigation/workspace-target';
import { CREATE_TAB_ID, tabKey, useUiStore } from '../../store/ui-store';
import { useShortcutsStore } from '../../store/shortcuts-store';
import { useDesktopGlobalShortcuts } from './useDesktopGlobalShortcuts';

const effects = vi.hoisted(() => ({ cleanups: [] as (() => void)[] }));
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: (effect: () => (() => void) | void) => {
    const cleanup = effect();
    if (cleanup) effects.cleanups.push(cleanup);
  },
  useRef: (current: unknown) => ({ current }),
}));
vi.mock('../../store/ui-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/ui-store')>();
  return {
    ...actual,
    useUiStore: Object.assign(
      (select: (state: ReturnType<typeof actual.useUiStore.getState>) => unknown) => select(actual.useUiStore.getState()),
      actual.useUiStore,
    ),
  };
});
vi.mock('../../platform/runtime', () => ({ getPlatformRuntime: () => ({ nativePlatform: 'macos' }) }));
vi.mock('../../lib/active-editor', () => ({ getActiveEditor: vi.fn(), saveActiveEditor: vi.fn() }));
vi.mock('../../services/yjs-local-durability.service', () => ({ flushAllYjsDocumentsLocally: vi.fn() }));

const projectId = 'shortcut-project';
const navigate = vi.fn();
const navigator: WorkspaceNavigator = {
  projectId,
  activate: vi.fn((target: WorkspaceTarget) => {
    useUiStore.getState().activateExistingTarget(projectId, target);
  }),
  open: vi.fn(), showProjectHome: vi.fn(), leaveDeletedTarget: vi.fn(),
};

function dispatch(overrides: Partial<KeyboardEvent>, prevented = false): KeyboardEvent {
  const event = new Event('keydown', { bubbles: true, cancelable: true }) as KeyboardEvent;
  const properties = {
    key: '', code: '', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false,
    isComposing: false, keyCode: 0, ...overrides,
  };
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(event, key, { value });
  }
  if (prevented) event.preventDefault();
  document.dispatchEvent(event);
  return event;
}

function activeKey() {
  return useUiStore.getState().tabsByProject[projectId]?.activeTabKey;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', new EventTarget());
  useShortcutsStore.getState().resetAll();
  useUiStore.setState({ tabsByProject: {}, activeSuperView: 'none' });
  for (const id of ['a', 'b', 'c']) {
    useUiStore.getState().openEntityTab(projectId, { entityType: 'node', id }, { preview: false });
  }
  useDesktopGlobalShortcuts({
    projectId, navigator, navigate, openFind: vi.fn(), openGlobalSearch: vi.fn(), closeWorkspaceTab: vi.fn(),
  });
});

afterEach(() => {
  for (const cleanup of effects.cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

describe('desktop top-tab keyboard acceptance', () => {
  it.each([
    [{ key: '{', code: 'BracketLeft', shiftKey: true }, ['b', 'a', 'c']],
    [{ key: '}', code: 'BracketRight', shiftKey: true }, ['a', 'b', 'c']],
    [{ key: 'ArrowLeft', altKey: true }, ['b', 'a', 'c']],
    [{ key: 'ArrowRight', altKey: true }, ['a', 'b', 'c']],
  ] as const)('cycles in visible order and wraps for %j', (keys, expected) => {
    for (const id of expected) {
      expect(dispatch(keys).defaultPrevented).toBe(true);
      expect(activeKey()).toBe(`node:${id}`);
    }
    expect(navigator.activate).toHaveBeenCalledTimes(3);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('selects the first/last tab from home and leaves an empty list alone', () => {
    useUiStore.getState().setActiveTab(projectId, null);
    dispatch({ key: '}', shiftKey: true });
    expect(activeKey()).toBe('node:a');
    useUiStore.getState().setActiveTab(projectId, null);
    dispatch({ key: '{', shiftKey: true });
    expect(activeKey()).toBe('node:c');
    useUiStore.setState({ tabsByProject: {} });
    expect(dispatch({ key: '}', shiftKey: true }).defaultPrevented).toBe(false);
    expect(navigator.activate).toHaveBeenCalledTimes(2);
  });

  it('activates the focused leaf of a split and routes to an existing create draft', () => {
    useUiStore.getState().splitActiveWith(projectId, { entityType: 'node', id: 'd' }, 'right');
    const splitKey = activeKey();
    useUiStore.getState().openCreateTab(projectId);
    dispatch({ key: '{', shiftKey: true });
    expect(navigator.activate).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'd' }));
    expect(activeKey()).toBe(splitKey);
    dispatch({ key: 'ArrowRight', altKey: true });
    expect(activeKey()).toBe(`create:${CREATE_TAB_ID}`);
    expect(navigate).toHaveBeenCalledWith(`/project/${projectId}/new`);
    expect(useUiStore.getState().tabsByProject[projectId].openTabs.map(tabKey)).toHaveLength(4);
  });

  it('keeps customized bindings alongside the bracket aliases', () => {
    useShortcutsStore.getState().setBinding('prevTab', 'Mod+Shift+P');
    dispatch({ key: 'P', shiftKey: true });
    expect(activeKey()).toBe('node:b');
    dispatch({ key: '{', shiftKey: true });
    expect(activeKey()).toBe('node:a');
  });

  it('does not switch on history, plain cursor keys, IME composition, or a consumed recording event', () => {
    for (const keys of [
      { key: '[', code: 'BracketLeft' },
      { key: 'ArrowLeft', metaKey: false },
      { key: 'ArrowRight', altKey: true, isComposing: true },
      { key: '{', shiftKey: true, keyCode: 229 },
    ]) {
      expect(dispatch(keys).defaultPrevented).toBe(false);
    }
    dispatch({ key: '}', shiftKey: true }, true);
    expect(navigator.activate).not.toHaveBeenCalled();
    expect(activeKey()).toBe('node:c');
  });

  it('captures ahead of editor keymaps and removes the listener on cleanup', () => {
    const add = vi.spyOn(document, 'addEventListener');
    for (const cleanup of effects.cleanups.splice(0)) cleanup();
    useDesktopGlobalShortcuts({
      projectId, navigator, navigate, openFind: vi.fn(), openGlobalSearch: vi.fn(), closeWorkspaceTab: vi.fn(),
    });
    expect(add).toHaveBeenCalledWith('keydown', expect.any(Function), { capture: true });
    const event = dispatch({ key: 'ArrowLeft', altKey: true });
    expect(event.defaultPrevented).toBe(true);
    for (const cleanup of effects.cleanups.splice(0)) cleanup();
    expect(dispatch({ key: 'ArrowLeft', altKey: true }).defaultPrevented).toBe(false);
    expect(navigator.activate).toHaveBeenCalledTimes(1);
  });
});
