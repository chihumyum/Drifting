import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal('window', { localStorage: globalThis.localStorage });
});

import { useUiStore } from './ui-store';

const state = () => useUiStore.getState();

const tabs = (side: 'left' | 'right') => state().desktopSidebarTabs[side].panes.map((pane) => pane.tab);

describe('desktop sidebar store acceptance', () => {
  beforeEach(() => useUiStore.setState(useUiStore.getInitialState(), true));

  it('closes and reopens either single sidebar with its last selection intact', () => {
    state().setSidebarOpen('left', true);
    state().setSidebarOpen('right', true);
    state().toggleLeftSidebarTab('primary', 'elements');
    expect(state().sidebars.left.isOpen).toBe(false);
    expect(state().sidebars.right.isOpen).toBe(true);
    state().toggleRightSidebarTab('primary', 'library');
    expect(state().sidebars.right.isOpen).toBe(false);
    state().toggleSidebar('left');
    state().toggleSidebar('right');
    expect(state().sidebars.left.isOpen).toBe(true);
    expect(tabs('left')).toEqual(['elements']);
    expect(tabs('right')).toEqual(['library']);
  });

  it('preserves a wide single pane and its stable identity through closing, reopening and persistence', () => {
    state().setSidebarOpen('right', true);
    state().setSidebarSplitAvailable('right', true);
    state().toggleRightSidebarTab('primary', 'library');
    state().toggleRightSidebarTab('secondary', 'stats');
    expect(state().sidebars.right.isOpen).toBe(false);
    state().toggleSidebar('right');
    state().setSidebarSplitAvailable('right', true);
    expect(tabs('right')).toEqual(['stats']);
    expect(state().desktopSidebarTabs.right.panes[0].id).toBe('secondary');
    const options = useUiStore.persist.getOptions();
    const restored = options.merge!(options.partialize!(state()), useUiStore.getInitialState());
    expect(restored.desktopSidebarTabs.right).toEqual(state().desktopSidebarTabs.right);
    state().splitSidebar('right');
    expect(tabs('right')).toEqual(['stats', 'companion']);
    expect(state().desktopSidebarTabs.right.panes.map((pane) => pane.id)).toEqual(['secondary', 'primary']);
  });

  it('switches both sidebars independently, permits duplicates and narrows to the focused pane', () => {
    state().setSidebarSplitAvailable('left', true);
    state().setSidebarSplitAvailable('right', true);
    state().toggleLeftSidebarTab('secondary', 'elements');
    state().toggleRightSidebarTab('primary', 'stats');
    expect(tabs('left')).toEqual(['elements', 'elements']);
    expect(tabs('right')).toEqual(['stats', 'stats']);
    state().toggleRightSidebarTab('secondary', 'companion');
    state().focusSidebarPane('right', 'primary');
    state().setSidebarSplitAvailable('right', false);
    expect(tabs('right')).toEqual(['stats']);
    expect(state().rightPanelGroup).toBe('content');
    expect(tabs('left')).toEqual(['elements', 'elements']);
  });

  it('reveals Agent in the focused pane without reordering, and reuses it on subsequent navigation', () => {
    state().setSidebarSplitAvailable('right', true);
    state().setRightPanelGroup('agent');
    expect(tabs('right')).toEqual(['companion', 'stats']);
    state().focusSidebarPane('right', 'secondary');
    state().setRightPanelGroup('agent');
    expect(tabs('right')).toEqual(['companion', 'stats']);
    expect(state().desktopSidebarTabs.right.focusedPane).toBe('primary');
    state().setActiveRightPanel('review');
    expect(tabs('right')).toEqual(['review', 'stats']);
  });

  it('restores older single-tab and shared-row preferences without losing selections', () => {
    const restored = useUiStore.persist.getOptions().merge!({
      activeLeftPanel: 'drift', rightPanelGroup: 'agent', activeRightPanel: 'review',
      desktopSidebarTabs: { right: { tabs: ['review', 'companion'], focused: 'companion', canSplit: true } },
    }, useUiStore.getInitialState());
    useUiStore.setState(restored, true);
    expect(tabs('left')).toEqual(['drift']);
    expect(tabs('right')).toEqual(['review', 'companion']);
    expect(state().desktopSidebarTabs.right.focusedPane).toBe('secondary');
    state().setSidebarSplitAvailable('left', true);
    expect(tabs('left')).toEqual(['drift', 'nodes']);
  });

  it('persists duplicate tabs and independent divider ratios', () => {
    state().setSidebarSplitAvailable('right', true);
    state().toggleRightSidebarTab('secondary', 'library');
    state().setLeftPanelSplitRatio(0.3);
    state().setRightPanelSplitRatio(0.7);
    const options = useUiStore.persist.getOptions();
    const restored = options.merge!(options.partialize!(state()), useUiStore.getInitialState());
    expect(restored.desktopSidebarTabs.right).toEqual(state().desktopSidebarTabs.right);
    expect(restored.leftPanelSplitRatio).toBe(0.3);
    expect(restored.rightPanelSplitRatio).toBe(0.7);
    state().setLeftPanelSplitRatio(-1);
    state().setRightPanelSplitRatio(2);
    expect(state().leftPanelSplitRatio).toBe(0.2);
    expect(state().rightPanelSplitRatio).toBe(0.8);
  });
});
