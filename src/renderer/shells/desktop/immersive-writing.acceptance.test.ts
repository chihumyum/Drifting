import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getDefaultAccelerator } from '../../store/shortcuts-store';
import { useSettingsStore } from '../../store/settings-store';
import { sidebarShown, useUiStore } from '../../store/ui-store';
import { PREFERENCE_KEYS } from '../../features/preference-sync/preference-fields';
import { designSystemDocs } from '../../components/design-system-docs.test-support';
import { immersivePeekAt } from './useImmersiveWriting';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const css = () => source('src/styles/immersive-writing.css');
const selectors = (text: string) =>
  [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)].map((match) => match[1].trim());

describe('immersive writing (docs/editor/immersive-writing.md)', () => {
  afterEach(() => useUiStore.setState({ immersiveWriting: false, immersiveWritingByTyping: false, activeSuperView: 'none' }));

  it('opens from its own incense right of the toolbar or ⌘⇧↩, and Esc leaves', () => {
    const bar = source('src/renderer/components/editor/EditorTopBar.tsx');
    // Out of the pill, the corner's last control: timeline toggle, pill, incense.
    const corner = bar.slice(bar.indexOf('<div className="editor-corner">'), bar.indexOf('function OutlineRailToggle'));
    expect(corner).toMatch(/\{hostsTimelineToggle && <TimelineToggle \/>\}\s+<div className="editor-bar/);
    expect(corner).toMatch(/<\/div>\s+\{hostsTimelineToggle && <ImmersiveWritingControl \/>\}\s+<\/div>\s+\);\s+\}/);
    const pill = corner.slice(corner.indexOf('role="toolbar"'), corner.indexOf('{hostsTimelineToggle && <ImmersiveWritingControl />}'));
    expect(pill).not.toContain('Immersive');
    const control = source('src/renderer/components/workspaceChrome/ImmersiveWriting.tsx');
    expect(control).toContain('icon={<BrushIcon name="incense" />}');
    expect(control).toContain('className="workspace-immersive-toggle glass--rest"');
    expect(source('scripts/design-assets/brushicons.py')).toContain('"incense": (incense, 9101)');
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
    for (const chrome of ['.workspace-sidebar-toggles', '.workspace-tab-dock', '.editor-corner > *', '.immersive-writing-control', '.workspace-timeline-toggle--stage.ghost-icon-button']) {
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
    for (const untouched of ['editor__toc-rail', 'sticky-note-rail', 'comment-rail', 'editor__margin', 'outlineRailMode', 'setOutlineRailMode', 'commentToggle', 'comment-highlight']) {
      expect(immersion, untouched).not.toContain(untouched);
    }
  });

  it('brings back the dock and traffic lights at the top edge and the pressed incense in the stage corner', () => {
    const exit = { left: 1236, top: 752, right: 1264, bottom: 780 };
    expect(immersivePeekAt(600, 20, exit)).toBe('top');
    expect(immersivePeekAt(1200, 770, exit)).toBe('corner');
    expect(immersivePeekAt(1000, 770, exit)).toBeNull();
    expect(immersivePeekAt(600, 400, null)).toBeNull();
    expect(css()).toContain(".desktop-app-shell[data-immersive][data-immersive-peek='top'] .workspace-tab-dock");
    expect(css()).toContain(".desktop-app-shell[data-immersive][data-immersive-peek='corner'] .immersive-writing-control--stage {");
    // Immersed, the way out is the stage's own, in its lower-right corner,
    // not the editor corner's button left of the (now hidden) toolbar.
    const control = source('src/renderer/components/workspaceChrome/ImmersiveWriting.tsx');
    expect(control).toContain('<div className="immersive-writing-control immersive-writing-control--stage">');
    expect(control).toContain('<ImmersiveWritingToggle immersive />');
    expect(source('src/renderer/shells/desktop/useImmersiveWriting.ts'))
      .toContain("root.querySelector<HTMLElement>('.immersive-writing-control--stage')");
    const stage = selectors(css()).indexOf('.immersive-writing-control--stage');
    expect(stage).toBeGreaterThanOrEqual(0);
    expect(css()).toMatch(/\.immersive-writing-control--stage \{\s+position: absolute;\s+z-index: 20;\s+right: 16px;\s+bottom: calc\(16px \+ var\(--glass-tray-padding\)\);/);
    expect(source('src/renderer/shells/desktop/useImmersiveWriting.ts')).toContain("setTrafficLightsHidden(next !== 'top')");
    expect(source('src-tauri/src/lib.rs')).toContain('commands::window_set_traffic_lights_hidden,');
    const commands = source('src-tauri/src/commands.rs');
    // Changing the buttons' alpha relays the title bar out at once and loses
    // the inset, so their frames are put back in the same turn.
    expect(commands).toContain('button.setAlphaValue(if hidden { 0.0 } else { 1.0 });');
    const command = commands.slice(commands.indexOf('pub fn window_set_traffic_lights_hidden'));
    expect(command.indexOf('button.setFrameOrigin(origin);')).toBeGreaterThan(command.indexOf('button.setAlphaValue('));
    expect(command.indexOf('view.setFrame(frame);')).toBeGreaterThan(command.indexOf('button.setAlphaValue('));
    expect(commands.slice(commands.indexOf('pub fn window_set_traffic_lights_hidden'))
      .slice(0, 900)).not.toContain('setHidden');
    expect(source('src/renderer/platform/contracts.ts'))
      .toContain('window_set_traffic_lights_hidden: { args: { hidden: boolean }; result: void };');
  });

  it('keeps the caret on the typing line and fades every other block without touching the editor', () => {
    expect(source('src/renderer/hooks/useTypewriterScrolling.ts')).toContain('const enabled = typewriterMode || immersive;');
    // Immersion uses the typing line position, so the desktop keeps it adjustable.
    expect(source('src/renderer/features/settings/panels/PreferenceSettingsPanels.tsx'))
      .toContain('disabled={!typewriterMode && !desktop}');
    expect(css()).toMatch(/::highlight\(drifting-immersive-dim\) \{\s+color: hsl\(var\(--ink-1\) \/ 0\.26\);/);
    const focus = source('src/renderer/features/immersive-writing/paragraph-focus.ts');
    expect(focus).toContain("export const IMMERSIVE_DIM_HIGHLIGHT = 'drifting-immersive-dim';");
    for (const editorWrite of ['dispatch(', 'Decoration', 'setNodeMarkup', 'classList', 'setAttribute']) {
      expect(focus, editorWrite).not.toContain(editorWrite);
    }
  });

  it('begins with typing in the paper when 打字时自动沉浸 is on, and a press off the text ends only such a sitting', () => {
    // The setting: off until the author turns it on, follows the account,
    // and sits first in the editor's FLOW section, on the desktop only.
    expect(useSettingsStore.getState().autoImmersiveWriting).toBe(false);
    expect(PREFERENCE_KEYS).toContain('autoImmersiveWriting');
    const panel = source('src/renderer/features/settings/panels/PreferenceSettingsPanels.tsx');
    const flow = panel.slice(panel.indexOf('hint="FLOW"'), panel.indexOf("label={t('settings.editor.typewriter_mode')}"));
    expect(flow).toMatch(/\{desktop && \(\s+<SettingsRow\s+label=\{t\('settings\.editor\.auto_immersive'\)\}/);
    expect(flow).toContain('on={autoImmersiveWriting}');
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'pt-BR']) {
      const editor = JSON.parse(source(`src/renderer/locales/${locale}.json`)).settings.editor;
      expect(editor.auto_immersive, locale).toBeTruthy();
      expect(editor.auto_immersive_desc, locale).toMatch(/Esc|Échap/);
    }

    // How the sitting began is kept beside it, never persisted, and cleared with it.
    useUiStore.getState().setImmersiveWriting(true, true);
    expect(useUiStore.getState().immersiveWritingByTyping).toBe(true);
    useUiStore.getState().setImmersiveWriting(false);
    expect(useUiStore.getState().immersiveWritingByTyping).toBe(false);
    useUiStore.getState().setImmersiveWriting(true);
    expect(useUiStore.getState().immersiveWritingByTyping).toBe(false);
    useUiStore.getState().setImmersiveWriting(true, true);
    useUiStore.getState().setActiveSuperView('graph');
    expect(useUiStore.getState().immersiveWritingByTyping).toBe(false);
    const store = source('src/renderer/store/ui-store.ts');
    const partialize = store.slice(store.indexOf('partialize: (state) => ({'));
    expect(partialize.slice(0, partialize.indexOf('}),'))).not.toContain('immersiveWritingByTyping');

    // Typing: text, Enter, or a composition's commit in the stage's editor;
    // after ProseMirror's own handling, with the caret left where it is.
    const hook = source('src/renderer/shells/desktop/useImmersiveWriting.ts');
    expect(hook).toContain("if (!auto || immersive || !root) return undefined;");
    for (const listen of ["addEventListener('input', onInput, true)", "addEventListener('compositionend', onCompositionEnd, true)", "addEventListener('keydown', onKeyDown, true)"]) {
      expect(hook, listen).toContain(listen);
    }
    expect(hook).toContain("isStageEditorTarget(target, root.querySelector('.desktop-workspace-stage'))");
    expect(hook).toContain('enterImmersiveWriting({ byTyping: true })');
    const actions = source('src/renderer/components/workspaceChrome/immersive-writing.ts');
    expect(actions).toContain('if (!byTyping) keepWriting();');
    expect(actions).toContain('!editor.view.composing && stage.contains(dom) && dom.contains(target)');

    // A press elsewhere ends only a sitting typing began, and lands as usual.
    expect(hook).toContain('if (!immersive || !byTyping || !root) return undefined;');
    expect(hook).toContain('leaveImmersiveWriting({ refocus: false })');
    const press = hook.slice(hook.indexOf('const onPointerDown'), hook.indexOf("window.addEventListener('pointerdown'"));
    expect(press).not.toContain('preventDefault');
  });

  it('is written down in the editor and workspace contracts', () => {
    const doc = source('docs/editor/immersive-writing.md');
    for (const term of ['⌘⇧↩', 'Esc', '批注', '大纲', 'CSS Custom Highlight', '打字机', '红绿灯', '打字时自动沉浸', '点正文以外']) {
      expect(doc, term).toContain(term);
    }
    expect(designSystemDocs()).toContain('沉浸写作');
  });
});
