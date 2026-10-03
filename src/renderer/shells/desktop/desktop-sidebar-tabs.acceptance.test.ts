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
    useProjectTabs: (projectId: string) => actual.useUiStore.getState().tabsByProject[projectId]
      ?? { activeTabKey: null, openTabs: [] },
  };
});
vi.mock('../../store/sidebar-panel-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/sidebar-panel-store')>();
  type Session = ReturnType<typeof actual.useSidebarPanelSessionStore.getState>;
  return {
    ...actual,
    useSidebarPanelSessionStore: Object.assign(
      <T,>(select: (state: Session) => T) => select(actual.useSidebarPanelSessionStore.getState()),
      actual.useSidebarPanelSessionStore,
    ),
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../store/sidebar-metrics-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/sidebar-metrics-store')>();
  type Metrics = ReturnType<typeof actual.useSidebarMetricsStore.getState>;
  return { useSidebarMetricsStore: Object.assign(
    <T,>(select: (state: Metrics) => T) => select(actual.useSidebarMetricsStore.getState()),
    actual.useSidebarMetricsStore,
  ) };
});
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
    bookNodes: [
      { id: 'chapter-a', kind: 'chapter' },
      { id: 'chapter-b', kind: 'chapter' },
      { id: 'drift-a', kind: 'drift' },
      { id: 'drift-b', kind: 'drift' },
    ],
    bookActs: [], bookElements: [], storylines: [], bookElementCategories: [],
    storylineNodeMapping: {}, primaryStorylineByNode: {},
  }),
}));
vi.mock('../../components/leftBars/LeftSidebarSubHeader', () => ({
  LeftSidebarSubHeader: ({ panel }: { panel: string }) =>
    createElement('div', { 'data-toolbar': panel }),
}));
vi.mock('../../components/leftBars/ChapterPanel', () => ({ ChapterPanel: () => createElement(SelectionPanel, { panel: 'nodes' }) }));
vi.mock('../../components/leftBars/ElementPanel', () => ({ ElementPanel: () => createElement(SelectionPanel, { panel: 'elements' }) }));
vi.mock('../../components/leftBars/DriftPanel', () => ({ DriftPanel: () => createElement(SelectionPanel, { panel: 'drift' }) }));
vi.mock('../../components/rightBars/ReviewPanel', () => ({ ReviewPanel: () => 'review' }));
vi.mock('../../features/library/LibraryPanel', () => ({ LibraryPanel: () => 'library' }));
vi.mock('../../features/stats/EntityStatsContent', () => ({ EntityStatsContent: () => 'stats' }));
vi.mock('../../features/agent/desktop/DesktopAgentPanel', () => ({ DesktopAgentPanel: () => 'agent' }));

import { useUiStore } from '../../store/ui-store';
import { DesktopLeftSidebar } from './DesktopLeftSidebar';
import { DesktopRightSidebar } from './DesktopRightSidebar';
import { useLeftSidebarPanelWidth } from '../../hooks/useLeftSidebarPanelWidth';
import { SidebarPaneContext } from '../../lib/sidebar-pane-context';
import { useSidebarMetricsStore } from '../../store/sidebar-metrics-store';
import { useSidebarSelection } from '../../hooks/useSidebarPanelState';
import { sidebarPanelKey, useSidebarPanelSessionStore } from '../../store/sidebar-panel-store';
import type { WorkspaceTarget } from '../../features/workspace/navigation/workspace-target';
import type { LeftSidebarTab, SidebarPaneId } from '../../lib/sidebar-tabs';

const state = () => useUiStore.getState();
const projectId = 'synthetic-project';

// Exercise the real selection hook under the real desktop shell. Only entity
// rows are synthetic; no database or private manuscript is opened.
function SelectionPanel({ panel }: { panel: LeftSidebarTab }) {
  const legacy = panel === 'elements' ? state().elementUi.selectedId : state().nodeUi.selectedId;
  const [selection] = useSidebarSelection(legacy ? {
    entityType: panel === 'elements' ? 'element' : 'node', id: legacy,
  } : null);
  const ids = panel === 'nodes' ? ['chapter-a', 'chapter-b']
    : panel === 'drift' ? ['drift-a', 'drift-b'] : ['element-a', 'element-b'];
  const selected = selection && ids.includes(selection.id) ? selection.id : undefined;
  return createElement('div', { 'data-highlight': selected });
}

function remember(paneId: SidebarPaneId, tab: LeftSidebarTab, target: WorkspaceTarget) {
  useSidebarPanelSessionStore.getState().setSession(
    sidebarPanelKey({ projectId, side: 'left', paneId, tab }), 'selection', target, null,
  );
}

function showPanels(first: LeftSidebarTab, second: LeftSidebarTab) {
  useUiStore.setState({ desktopSidebarTabs: {
    ...state().desktopSidebarTabs,
    left: { panes: [{ id: 'primary', tab: first }, { id: 'secondary', tab: second }], focusedPane: 'primary', canSplit: true },
  } });
}

const highlights = () => renderToStaticMarkup(createElement(DesktopLeftSidebar)).match(/data-highlight="[^"]+"/g) ?? [];

describe('desktop sidebar rendered acceptance', () => {
  beforeEach(() => {
    useUiStore.setState(useUiStore.getInitialState(), true);
    useSidebarPanelSessionStore.setState({ session: {} });
    useSidebarMetricsStore.setState({ minimumWidths: { left: 216, right: 224 } });
  });

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
    expect(renderWidth('primary')).toBe('216');
    expect(renderWidth('secondary')).toBe('384');
    state().toggleLeftSidebarTab('primary', 'elements');
    expect(renderWidth('secondary')).toBe('601');
  });

  it('highlights only the current editor when widening restores another panel with old selection', () => {
    state().toggleLeftSidebarTab('primary', 'nodes');
    state().openEntityTab(projectId, { entityType: 'node', id: 'chapter-a' }, { preview: false });
    remember('primary', 'nodes', { entityType: 'node', id: 'chapter-a' });
    remember('secondary', 'drift', { entityType: 'node', id: 'drift-b' });
    state().openEntityTab(projectId, { entityType: 'node', id: 'drift-a' }, { preview: false });
    state().setSidebarSplitAvailable('left', true);
    state().toggleLeftSidebarTab('secondary', 'drift');
    expect(highlights()).toEqual(['data-highlight="drift-a"']);

    // Switching existing editor tabs must also update mounted sidebar views.
    state().setActiveTab(projectId, { entityType: 'node', id: 'chapter-a' });
    expect(highlights()).toEqual(['data-highlight="chapter-a"']);
    state().setActiveTab(projectId, { entityType: 'node', id: 'drift-a' });
    state().focusSidebarPane('left', 'secondary');
    state().setSidebarSplitAvailable('left', false);
    state().setSidebarSplitAvailable('left', true);
    expect(highlights()).toEqual(['data-highlight="drift-a"']);
  });

  it('ignores remembered node and element selections when their editor is not visible', () => {
    showPanels('nodes', 'elements');
    remember('primary', 'nodes', { entityType: 'node', id: 'chapter-a' });
    remember('secondary', 'elements', { entityType: 'element', id: 'element-a' });
    state().setNodeSelection('chapter-a');
    state().setElementSelection('element-a');
    state().openEntityTab(projectId, { entityType: 'element', id: 'element-b' });
    expect(highlights()).toEqual(['data-highlight="element-b"']);
    state().openEntityTab(projectId, { entityType: 'node', id: 'chapter-b' });
    expect(highlights()).toEqual(['data-highlight="chapter-b"']);
  });

  it('uses just one matching pane when both sidebar panes show the same entity type', () => {
    showPanels('nodes', 'nodes');
    remember('primary', 'nodes', { entityType: 'node', id: 'chapter-b' });
    remember('secondary', 'nodes', { entityType: 'node', id: 'chapter-b' });
    state().openEntityTab(projectId, { entityType: 'node', id: 'chapter-a' });
    expect(highlights()).toEqual(['data-highlight="chapter-a"']);
    state().focusSidebarPane('left', 'secondary');
    expect(highlights()).toEqual(['data-highlight="chapter-a"']);
    const html = renderToStaticMarkup(createElement(DesktopLeftSidebar));
    expect(html.indexOf('data-highlight="chapter-a"')).toBeGreaterThan(html.indexOf('data-sidebar-pane="secondary"'));
  });

  it('clears entity highlights on project home and when no matching entity row exists', () => {
    showPanels('nodes', 'elements');
    remember('primary', 'nodes', { entityType: 'node', id: 'chapter-a' });
    remember('secondary', 'elements', { entityType: 'element', id: 'element-a' });
    for (const target of [
      { entityType: 'storyline', id: 'storyline-a' },
      { entityType: 'category', id: 'category-a' },
      { entityType: 'all-chapters', id: 'all' },
      { entityType: 'node', id: 'missing-node' },
      { entityType: 'node', id: 'drift-a' },
    ] as const) {
      state().openEntityTab(projectId, target);
      expect(highlights()).toEqual([]);
    }
    state().setActiveTab(projectId, null);
    expect(highlights()).toEqual([]);
  });

  it('preserves split-editor pane selections but returns to one highlight after unsplitting', () => {
    showPanels('nodes', 'elements');
    remember('primary', 'nodes', { entityType: 'node', id: 'chapter-a' });
    remember('secondary', 'elements', { entityType: 'element', id: 'element-a' });
    const sessions = useSidebarPanelSessionStore.getState().session;
    state().openEntityTab(projectId, { entityType: 'node', id: 'chapter-a' });
    state().splitActiveWith(projectId, { entityType: 'element', id: 'element-a' }, 'right');
    expect(highlights()).toEqual(['data-highlight="chapter-a"', 'data-highlight="element-a"']);
    const active = state().tabsByProject[projectId].openTabs.find(tab => tab.kind === 'split');
    expect(active?.kind).toBe('split');
    if (active?.kind !== 'split') throw new Error('Expected a synthetic split editor');
    state().unsplitTab(projectId, active.id);
    expect(highlights()).toEqual(['data-highlight="element-a"']);
    expect(useSidebarPanelSessionStore.getState().session).toBe(sessions);
  });
});
