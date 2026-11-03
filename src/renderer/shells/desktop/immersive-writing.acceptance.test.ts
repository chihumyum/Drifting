import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getDefaultAccelerator } from '../../store/shortcuts-store';
import { sidebarShown, useUiStore } from '../../store/ui-store';
import { designSystemDocs } from '../../components/design-system-docs.test-support';
import { immersivePeekAt } from './useImmersiveWriting';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const css = () => source('src/styles/immersive-writing.css');
const selectors = (text: string) =>
  [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)].map((match) => match[1].trim());

describe('immersive writing (docs/editor/immersive-writing.md)', () => {
  afterEach(() => useUiStore.setState({ immersiveWriting: false, activeSuperView: 'none' }));

  it('opens from the first button of the paper toolbar or ⌘⇧↩, and Esc leaves', () => {
    const bar = source('src/renderer/components/editor/EditorTopBar.tsx');
    const toolbar = bar.slice(bar.indexOf('role="toolbar"'));
    expect(toolbar.indexOf('<ImmersiveWritingToggle />')).toBeGreaterThan(0);
    expect(toolbar.indexOf('<ImmersiveWritingToggle />')).toBeLessThan(toolbar.indexOf('plotPlannerToggle &&'));
    expect(source('src/renderer/components/workspaceChrome/ImmersiveWriting.tsx')).toContain('<BrushIcon name="tea" />');
    expect(getDefaultAccelerator('toggleImmersiveWriting')).toBe('Mod+Shift+Enter');
    expect(source('src/renderer/shells/desktop/useDesktopGlobalShortcuts.ts'))
      .toMatch(/bindings\.toggleImmersiveWriting\)\) \{\s+event\.preventDefault\(\);\s+toggleImmersiveWriting\(\);/);
    const hook = source('src/renderer/shells/desktop/useImmersiveWriting.ts');
    expect(hook).toContain("event.key === 'Escape'");
    expect(hook).toContain('event.defaultPrevented || event.isComposing');
  });

  it('withdraws the sidebars and the Bottom Panel over their own kept state, never persisted', () => {
    useUiStore.getState().setSidebarOpen('left', true);
    useUiStore.getState().setSidebarOpen('right', false);
    useUiStore.getState().setImmersiveWriting(true);
    const immersed = useUiStore.getState();
    expect([sidebarShown(immersed, 'left'), sidebarShown(immersed, 'right')]).toEqual([false, false]);
    expect([immersed.sidebars.left.isOpen, immersed.sidebars.right.isOpen]).toEqual([true, false]);
    useUiStore.getState().setImmersiveWriting(false);
    expect(sidebarShown(useUiStore.getState(), 'left')).toBe(true);

    expect(source('src/renderer/components/Sidebar.tsx')).toContain('(sidebarState?.isOpen ?? true) && !immersive');
    expect(source('src/renderer/shells/desktop/DesktopWorkspace.tsx'))
      .toMatch(/const dockPane: BottomPanelPane \| null = immersive\s+\? null/);
    const store = source('src/renderer/store/ui-store.ts');
    const partialize = store.slice(store.indexOf('partialize: (state) => ({'));
    expect(partialize.slice(0, partialize.indexOf('}),'))).not.toContain('immersiveWriting');
  });

  it('ends when a whole-book view covers the paper', () => {
    useUiStore.getState().setImmersiveWriting(true);
    useUiStore.getState().setActiveSuperView('graph');
    expect(useUiStore.getState().immersiveWriting).toBe(false);
  });

  it('fades the floating chrome and keeps a sync problem in sight', () => {
    const rules = selectors(css());
    for (const chrome of ['.workspace-sidebar-toggles', '.workspace-tab-dock', '.editor-corner', '.workspace-timeline-toggle--stage.ghost-icon-button']) {
      expect(rules.some((rule) => rule.includes(`.desktop-app-shell[data-immersive] ${chrome}`)), chrome).toBe(true);
    }
    expect(css()).toContain(".desktop-app-shell[data-immersive] .paper-sync-mark:not([data-state='problem'])");
    expect(source('src/renderer/shells/desktop/DesktopWorkspace.tsx')).toContain("data-immersive={immersive ? 'true' : undefined}");
  });

  it('leaves the comment and outline rails exactly as the author had them', () => {
    const immersion = [
      css(),
      source('src/renderer/shells/desktop/useImmersiveWriting.ts'),
      source('src/renderer/components/workspaceChrome/immersive-writing.ts'),
      source('src/renderer/components/workspaceChrome/ImmersiveWriting.tsx'),
      source('src/renderer/features/immersive-writing/paragraph-focus.ts'),
    ].join('\n');
    for (const untouched of ['editor__toc-rail', 'sticky-note-rail', 'outlineRailMode', 'setOutlineRailMode', 'commentToggle', 'comment-highlight']) {
      expect(immersion, untouched).not.toContain(untouched);
    }
  });

  it('brings back the dock and traffic lights at the top edge and the way out at the corner', () => {
    expect(immersivePeekAt(600, 20, 1280, 800)).toBe('top');
    expect(immersivePeekAt(1200, 760, 1280, 800)).toBe('corner');
    expect(immersivePeekAt(600, 400, 1280, 800)).toBeNull();
    expect(css()).toContain(".desktop-app-shell[data-immersive][data-immersive-peek='top'] .workspace-tab-dock");
    expect(css()).toContain(".desktop-app-shell[data-immersive-peek='corner'] .immersive-writing-corner");
    expect(source('src/renderer/shells/desktop/useImmersiveWriting.ts')).toContain("setTrafficLightsHidden(next !== 'top')");
    expect(source('src-tauri/src/lib.rs')).toContain('commands::window_set_traffic_lights_hidden,');
    expect(source('src-tauri/src/commands.rs')).toContain('button.setHidden(hidden);');
    expect(source('src/renderer/platform/contracts.ts'))
      .toContain('window_set_traffic_lights_hidden: { args: { hidden: boolean }; result: void };');
  });

  it('keeps the caret on the typing line and fades every other block without touching the editor', () => {
    expect(source('src/renderer/hooks/useTypewriterScrolling.ts')).toContain('const enabled = typewriterMode || immersive;');
    expect(css()).toMatch(/::highlight\(drifting-immersive-dim\) \{\s+color: hsl\(var\(--ink-1\) \/ 0\.26\);/);
    const focus = source('src/renderer/features/immersive-writing/paragraph-focus.ts');
    expect(focus).toContain("export const IMMERSIVE_DIM_HIGHLIGHT = 'drifting-immersive-dim';");
    for (const editorWrite of ['dispatch(', 'Decoration', 'setNodeMarkup', 'classList', 'setAttribute']) {
      expect(focus, editorWrite).not.toContain(editorWrite);
    }
  });

  it('is written down in the editor and workspace contracts', () => {
    const doc = source('docs/editor/immersive-writing.md');
    for (const term of ['⌘⇧↩', 'Esc', '批注', '大纲', 'CSS Custom Highlight', '打字机', '红绿灯']) {
      expect(doc, term).toContain(term);
    }
    expect(designSystemDocs()).toContain('沉浸写作');
  });
});
