import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Render the real shell/header wiring against a deterministic store snapshot.
// Panel bodies are synthetic so this acceptance never opens a local database.
vi.mock('../../store/ui-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/ui-store')>();
  type UiState = ReturnType<typeof actual.useUiStore.getState>;
  return {
    ...actual,
    useUiStore: Object.assign(
      <T,>(select: (state: UiState) => T) => select(actual.useUiStore.getState()),
      actual.useUiStore,
    ),
    useProjectTabs: () => ({ activeTabKey: null, openTabs: [] }),
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../hooks/useProjectNavigation', () => ({
  useProjectNavigation: () => ({ projectId: 'synthetic-project' }),
}));
vi.mock('../../store/data-store', () => ({
  useDataStore: (select: (s: { bookNodes: [] }) => unknown) => select({ bookNodes: [] }),
}));
vi.mock('../../store/agent-activity-store', () => ({
  useAgentActivityStore: (select: (s: {
    active: Record<string, never>; touched: Record<string, never>;
  }) => unknown) =>
    select({ active: {}, touched: {} }),
}));
vi.mock('../../store/use-data-store-fields', () => ({
  useDataStoreFields: () => ({
    bookNodes: [], bookActs: [], bookElements: [], storylines: [], bookElementCategories: [],
    storylineNodeMapping: {}, primaryStorylineByNode: {},
  }),
}));
vi.mock('../../components/leftBars/LeftSidebarSubHeader', () => ({
  LeftSidebarSubHeader: ({ panel }: { panel: string }) =>
    createElement('div', { 'data-toolbar': panel }),
}));
vi.mock('../../components/leftBars/ChapterPanel', () => ({ ChapterPanel: () => 'chapters' }));
vi.mock('../../components/leftBars/ElementPanel', () => ({ ElementPanel: () => 'elements' }));
vi.mock('../../components/leftBars/DriftPanel', () => ({ DriftPanel: () => 'drifts' }));
vi.mock('../../components/rightBars/ReviewPanel', () => ({ ReviewPanel: () => 'review' }));
vi.mock('../../features/library/LibraryPanel', () => ({ LibraryPanel: () => 'library' }));
vi.mock('../../features/stats/EntityStatsContent', () => ({ EntityStatsContent: () => 'stats' }));
vi.mock('../../features/agent/desktop/DesktopAgentPanel', () => ({ DesktopAgentPanel: () => 'agent' }));

import { useUiStore } from '../../store/ui-store';
import { DesktopLeftSidebar } from './DesktopLeftSidebar';
import { DesktopRightSidebar } from './DesktopRightSidebar';
import { useLeftSidebarPanelWidth } from '../../hooks/useLeftSidebarPanelWidth';
import { SidebarPaneContext } from '../../lib/sidebar-pane-context';

const state = () => useUiStore.getState();

describe('desktop sidebar rendered acceptance', () => {
  beforeEach(() => useUiStore.setState(useUiStore.getInitialState(), true));

  it('renders every left tab in each pane, with no disabled tabs and an independent toolbar', () => {
    state().setSidebarSplitAvailable('left', true);
    state().toggleLeftSidebarTab('secondary', 'elements');
    const html = renderToStaticMarkup(createElement(DesktopLeftSidebar));
    expect(html.match(/leftbar-tab-tray/g)).toHaveLength(2);
    expect(html.match(/app-panel-tab--label/g)).toHaveLength(6);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(4);
    expect(html).not.toContain('disabled=""');
    expect(html.match(/data-sidebar-pane="[^"]+"/g)).toEqual([
      'data-sidebar-pane="primary"', 'data-sidebar-pane="secondary"',
    ]);
    expect(html.match(/data-toolbar="elements"/g)).toHaveLength(2);
    expect(html.match(/role="separator"/g)).toHaveLength(1);
  });

  it('renders all four right tabs above each pane and allows two Agent instances', () => {
    state().setSidebarSplitAvailable('right', true);
    state().toggleRightSidebarTab('primary', 'companion');
    state().toggleRightSidebarTab('secondary', 'companion');
    const html = renderToStaticMarkup(createElement(DesktopRightSidebar));
    expect(html.match(/rightbar-tab-tray/g)).toHaveLength(2);
    expect(html.match(/app-panel-tab--label/g)).toHaveLength(8);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(6);
    expect(html).not.toContain('disabled=""');
    expect(html.match(/data-sidebar-panel="companion"/g)).toHaveLength(2);
  });

  it('keeps the surviving pane identity and exposes an explicit restore-split action', () => {
    state().setSidebarSplitAvailable('right', true);
    state().toggleRightSidebarTab('primary', 'library');
    const single = renderToStaticMarkup(createElement(DesktopRightSidebar));
    expect(single.match(/data-sidebar-panel="[^"]+"/g)).toEqual(['data-sidebar-panel="stats"']);
    expect(single).toContain('data-sidebar-pane="secondary"');
    expect(single.match(/rightbar-tab-tray/g)).toHaveLength(1);
    expect(single).not.toContain('role="separator"');
    expect(single).toContain('aria-label="sidebarLayout.split"');
    state().setSidebarSplitAvailable('right', false);
    expect(renderToStaticMarkup(createElement(DesktopRightSidebar))).not.toContain('aria-label="sidebarLayout.split"');
  });

  it('bases duplicate left-panel density on pane identity rather than tab type', () => {
    state().setSidebarWidth('left', 601);
    state().setSidebarSplitAvailable('left', true);
    state().toggleLeftSidebarTab('secondary', 'elements');
    state().setLeftPanelSplitRatio(0.25);
    function Width() { return String(useLeftSidebarPanelWidth()); }
    const renderWidth = (paneId: 'primary' | 'secondary') => renderToStaticMarkup(
      createElement(SidebarPaneContext.Provider, { value: paneId }, createElement(Width)),
    );
    expect(renderWidth('primary')).toBe('150');
    expect(renderWidth('secondary')).toBe('450');
    state().toggleLeftSidebarTab('primary', 'elements');
    expect(renderWidth('secondary')).toBe('601');
  });
});
