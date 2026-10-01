import { afterEach, describe, expect, it } from 'vitest';
import { useUiStore } from './ui-store';
import { useSidebarPanelStore, useSidebarPanelSessionStore, sidebarPanelKey, type SidebarPanelScope } from './sidebar-panel-store';
import { resizeSidebarTabs, singleSidebarTab, LEFT_SIDEBAR_TABS } from '../lib/sidebar-tabs';

const initial = useSidebarPanelStore.getState();
const sessionInitial = useSidebarPanelSessionStore.getState();
const key = (patch: Partial<SidebarPanelScope> = {}) => sidebarPanelKey({ projectId: 'synthetic-project', side: 'left', paneId: 'primary', tab: 'elements', ...patch });
afterEach(() => {
  useSidebarPanelStore.setState(initial, true);
  useSidebarPanelSessionStore.setState(sessionInitial, true);
});

describe('independent sidebar panel acceptance', () => {
  it('isolates display preferences across panes, panel types, sides and projects', () => {
    const shared = useUiStore.getState();
    const store = useSidebarPanelStore.getState();
    store.setPreference(key(), 'elementSortMode', 'createdAt');
    store.setPreference(key({ paneId: 'secondary' }), 'elementSortMode', 'alphabet');
    store.setPreference(key(), 'elementPanelViewMode', 'compact');
    const saved = useSidebarPanelStore.getState().preferences;
    expect(saved[key()]).toMatchObject({ elementSortMode: 'createdAt', elementPanelViewMode: 'compact' });
    expect(saved[key({ paneId: 'secondary' })]).toEqual({ elementSortMode: 'alphabet' });
    for (const patch of [{ tab: 'nodes' as const }, { side: 'right' as const }, { projectId: 'synthetic-other' }]) expect(saved[key(patch)]).toBeUndefined();
    expect(useUiStore.getState()).toBe(shared);
  });

  it('keeps review scope and order separate for two Review tabs', () => {
    const a = key({ side: 'right', tab: 'review' });
    const b = key({ side: 'right', tab: 'review', paneId: 'secondary' });
    const store = useSidebarPanelStore.getState();
    store.setPreference(a, 'reviewScope', 'current'); store.setPreference(a, 'reviewSortMode', 'createdAt');
    store.setPreference(b, 'reviewScope', 'project'); store.setPreference(b, 'reviewSortMode', 'updatedAt');
    expect(useSidebarPanelStore.getState().preferences[a]).toEqual({ reviewScope: 'current', reviewSortMode: 'createdAt' });
    expect(useSidebarPanelStore.getState().preferences[b]).toEqual({ reviewScope: 'project', reviewSortMode: 'updatedAt' });
  });

  it('retains folds, selection, filter and scroll under stable pane identity after narrowing', () => {
    const secondary = key({ paneId: 'secondary' });
    const store = useSidebarPanelSessionStore.getState();
    store.setSession(secondary, 'collapsed', new Set(['synthetic-category']), new Set<string>());
    store.setSession(secondary, 'selection', { entityType: 'element', id: 'synthetic-element' }, null);
    store.setSession(secondary, 'filter', 'related', 'all');
    store.setSession(secondary, 'scrollTop', 180, 0);
    let tabs = resizeSidebarTabs(singleSidebarTab('elements'), true, LEFT_SIDEBAR_TABS);
    tabs = resizeSidebarTabs({ ...tabs, focusedPane: 'secondary' }, false, LEFT_SIDEBAR_TABS);
    expect(tabs.panes[0].id).toBe('secondary');
    tabs = resizeSidebarTabs(tabs, true, LEFT_SIDEBAR_TABS);
    expect(tabs.panes[0].id).toBe('secondary');
    const snapshot = useSidebarPanelSessionStore.getState().session;
    expect(snapshot[secondary]).toEqual({ collapsed: new Set(['synthetic-category']), selection: { entityType: 'element', id: 'synthetic-element' }, filter: 'related', scrollTop: 180 });
    expect(snapshot[key()]).toBeUndefined();
    expect(snapshot[key({ paneId: 'secondary', tab: 'nodes' })]).toBeUndefined();
    expect(useSidebarPanelStore.getState()).toBe(initial);
  });

  it('uses the latest local state for fold toggles and preserves an intentional null selection', () => {
    const store = useSidebarPanelSessionStore.getState();
    store.setSession(key(), 'collapsed', new Set(['one']), new Set<string>());
    store.setSession<Set<string>>(key(), 'collapsed', previous => new Set([...previous, 'two']), new Set());
    store.setSession<string | null>(key(), 'selection', null, 'old-selection');
    store.setSession<string | null>(key(), 'selection', previous => previous, 'old-selection');
    expect(useSidebarPanelSessionStore.getState().session[key()]).toEqual({ collapsed: new Set(['one', 'two']), selection: null });
  });

});
