import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { designSystemDocs } from '../../../components/design-system-docs.test-support';
import { HOME_CREATE_KINDS } from './home-create';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function block(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

describe('Project Home with creating in it', () => {
  it('retires the 新建… tab: no create tab, no /new surface, no completion transition', () => {
    const uiStore = source('src/renderer/store/ui-store.ts');
    const editorMain = source('src/renderer/components/editor/EditorMainArea.tsx');
    const routes = source('src/renderer/app/AppRoutes.tsx');

    expect(uiStore).toContain('export type AnyTab = LeafTab | SplitTab;');
    expect(uiStore).not.toContain('openCreateTab');
    // Old storage may still hold one; reading it drops it.
    expect(uiStore).toContain("if (tab.kind === 'create') return;");
    expect(editorMain).not.toContain('DesktopUniversalCreateView');
    expect(routes).toContain('<Route path="new" element={<Navigate to=".." replace />} />');
  });

  it('keeps the dock plus after the expanded pills, outside their overflow, and sends it Home', () => {
    const topTimeline = source('src/renderer/components/topBars/TopTimeline/TopTimeline.tsx');
    const shell = source('src/styles/desktop-shell.css');

    expect(topTimeline).toContain('className="top-timeline-create-button glass glass--rest glass--round"');
    expect(topTimeline).toContain('{expanded && <button');
    expect(topTimeline).toContain('const TAB_STRIP_START_PADDING = DOCK_ROUND_GLASS_SIZE + 5;');
    expect(topTimeline).toContain('const TAB_STRIP_END_PADDING = DOCK_ROUND_GLASS_SIZE + 5;');
    expect(topTimeline).toContain(
      'containerWidth - TAB_STRIP_START_PADDING - TAB_STRIP_END_PADDING - totalGaps',
    );
    // The lock and the plus sit either side of the pills' scroller, never in it.
    expect(topTimeline.indexOf('{expanded && leading}')).toBeLessThan(topTimeline.indexOf('ref={containerRef}'));
    expect(topTimeline.indexOf('className="top-timeline-create-button')).toBeGreaterThan(
      topTimeline.indexOf('    </div>\n\n    {expanded && <button'),
    );
    expect(shell).toContain(
      '.workspace-tab-dock__lock,\n.workspace-tab-dock .top-timeline-create-button {\n  position: relative;\n  pointer-events: auto;',
    );
    expect(topTimeline).toContain("if (event.animationName === 'dock-pill-grow') reveal();");
    // Home has no pill: the plus is lit while Home shows, and goes there.
    expect(topTimeline).toContain('aria-pressed={homeShowing}');
    expect(topTimeline).toContain("navigateToHome({ intent: 'new' })");
  });

  it('opens the create row from anywhere with ⌘N', () => {
    const shortcuts = source('src/renderer/store/shortcuts-store.ts');
    const handler = source('src/renderer/shells/desktop/useDesktopGlobalShortcuts.ts');
    const navigator = source('src/renderer/shells/desktop/navigation/useDesktopWorkspaceNavigator.ts');

    expect(shortcuts).toContain("id: 'newEntity'");
    expect(shortcuts).toContain("defaultAccelerator: 'Mod+N'");
    expect(handler).toContain('matchesAccelerator(event, bindings.newEntity)');
    expect(handler).toContain("navigator.showProjectHome({ intent: 'new' });");
    expect(navigator).toContain("state.markProjectHomeEntry(options?.intent ?? 'home');");
  });

  it('flows the work, then the create row, then the Agent, floating one of the last two per arrival', () => {
    const home = source('src/renderer/views/ProjectDashboard.tsx');
    const css = source('src/styles/dashboard.css');

    expect(home.indexOf('<HomeWork />')).toBeLessThan(home.indexOf('<HomeCreateTiles model={create} />'));
    expect(home.indexOf('<HomeCreateTiles model={create} />')).toBeLessThan(home.indexOf('<HomeAgentFlow'));
    expect(home).toContain("const next: Floating = intent === 'new' ? 'new' : 'agent';");
    expect(home).toContain('<HomeCreateFloat model={create} />');
    expect(home).toContain('<HomeAgentFloat agent={agent} />');
    // The floating set rests where the CSS puts it; its section waits, empty.
    expect(home).toContain('const FLOAT_INSET = 26;');
    expect(block(css, '.dash-float {', '@keyframes dash-float-in')).toContain('bottom: 26px;');
    expect(block(css, '.dash-sec.is-ghost {', '.dash-sec__head {')).toContain('opacity: 0;');
    // Nothing frames the floating set; each control carries its own fill.
    expect(block(css, '.dash-float {', '@keyframes dash-float-in')).not.toContain('box-shadow');
    expect(css).toContain('.dash-float :is(.home-create__orb, .home-create__pick, .home-agent__mini) {');
  });

  it('creates without naming: places stack above the kind under the pointer; no place, no step', () => {
    const tiles = source('src/renderer/shells/desktop/project-home/HomeCreate.tsx');
    const model = source('src/renderer/shells/desktop/project-home/useHomeCreate.tsx');
    const css = source('src/styles/dashboard.css');
    const picks = block(css, '.home-create__picks {', '.home-create__slot:is(');

    expect(HOME_CREATE_KINDS).toEqual(['chapter', 'drift', 'element', 'storyline', 'category', 'material']);
    expect(picks).toContain('bottom: 100%;');
    expect(picks).toContain('left: 50%;');
    expect(picks).toContain('transform: translateX(-50%);');
    // One column straight above the kind, every pill as wide as the widest.
    expect(picks).toContain('flex-direction: column;');
    expect(picks).toContain('align-items: stretch;');
    expect(picks).not.toContain('flex-wrap');
    // The pointer opens them, and so does focus the keyboard brought; the
    // focus Home places on arrival (or after Escape) stays quiet.
    expect(css).toContain(
      '.home-create__slot:is(:hover, .is-open) > .home-create__picks,\n.home-create:not(.is-quiet) .home-create__slot:has(:focus-visible) > .home-create__picks {',
    );
    expect(css).not.toContain(':focus-within) > .home-create__picks');
    const home = source('src/renderer/views/ProjectDashboard.tsx');
    expect(home.indexOf('hush();')).toBeLessThan(home.indexOf('kind.focus({ preventScroll: true });'));
    expect(tiles).toContain('model.hush();');
    expect(tiles).toContain('onKeyDown: model.wake,');
    // The floating rounds hold only the mark; the name comes up under them.
    const orb = block(tiles, 'className="home-create__orb glass glass--rest glass--round"', '</Slot>');
    expect(orb).toContain('<Mark kind={entry.kind}');
    expect(orb).toContain('<span className="home-create__label" aria-hidden="true">{entry.label}</span>');
    expect(css).toContain(
      '.home-create__slot:hover > .home-create__label,\n.home-create:not(.is-quiet) .home-create__slot:has(:focus-visible) > .home-create__label {',
    );
    // A kind with nothing to choose creates on click.
    expect(tiles).toContain('else entry.create();');
    expect(model).toContain("if (sortedStorylines.length === 0) return null;");
    expect(model).toContain('if (groups.length === 0) return null;');
  });

  it('documents the merged Home and the retired tab', () => {
    const docs = designSystemDocs();
    const architecture = source('docs/renderer-ui-architecture.md');

    expect(docs).toContain('## 作品主页');
    expect(docs).toContain('「新建…」占位标签已退场');
    expect(architecture).toContain('## Project Home create');
  });
});
