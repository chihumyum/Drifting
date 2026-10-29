import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { designSystemDocs } from '../design-system-docs.test-support';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

/** Every rule whose selector names one of `classes` (whole class names), as [selector, body]. */
function rules(css: string, classes: string[]): Array<[string, string]> {
  const named = classes.map((name) => new RegExp(`${name.replace(/[.-]/g, '\\$&')}(?![\\w-])`));
  const found: Array<[string, string]> = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (named.some((name) => name.test(selector))) found.push([selector, match[2]]);
  }
  return found;
}

function rule(css: string, selector: string): string {
  const found = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find((match) => match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim() === selector);
  expect(found, `missing rule: ${selector}`).toBeTruthy();
  return found![2];
}

const reviewCss = () => source('src/styles/comments-review.css');
const FORMAT_GLYPHS = ['fmt-paragraph', 'fmt-h1', 'fmt-h2', 'fmt-h3', 'fmt-quote', 'fmt-bold', 'fmt-italic', 'fmt-underline', 'fmt-strike'];

describe('the manuscript tools in sand and glass', () => {
  it('marks the reading location with bold ink alone and keeps an unread chapter as quiet as a scene', () => {
    const css = reviewCss();
    const rail = source('src/renderer/components/editor/EditorOutlineRail.tsx');
    // No sand under the reading location any more: it and its path are bold ink.
    expect(css).not.toContain('.editor__toc-tag-sand');
    expect(css).not.toContain('toc-sand');
    expect(rail).not.toContain('editor__toc-tag-sand');
    expect(rail).not.toContain('data-sand');
    const path = rule(css, '.editor__toc-tag.is-active-path,\n.editor__toc-tag.is-primary');
    expect(path).toContain('color: hsl(var(--ink-1));');
    expect(path).toContain('font-weight: 600;');
    // A chapter out of view is no brighter than an act or a scene.
    expect(rule(css, '.editor__toc-tag--l2')).toContain('color: hsl(var(--ink-3));');
    expect(rule(css, '.editor__toc-tag--l1')).toContain('color: hsl(var(--ink-3));');
    expect(rule(css, '.editor__toc-tag--l3')).toContain('color: hsl(var(--ink-3));');
    // No accent anywhere on the rail: not the reading location, its path, numbers or revealed rows.
    for (const [selector, body] of rules(css, ['.editor__toc-tag', '.editor__toc-tag-num', '.editor__toc-reveal-item'])) {
      expect(body, selector).not.toContain('--accent');
    }
    // Acts in the serif structure face, no dash before them, no branch dot after anything.
    expect(rule(css, '.editor__toc-tag--l1')).toContain('font-family: var(--font-structure, var(--font-sans));');
    expect(css).not.toContain('.editor__toc-tag--l1::before');
    expect(css).not.toContain('.editor__toc-tag-branch');
    expect(rail).not.toContain('editor__toc-tag-branch');
    expect(rail).toContain('className="menu-surface menu-surface--compact editor__toc-omission-reveal');
    expect(rail).toContain('className={`menu-surface__item editor__toc-reveal-item');
  });

  it('floats the selection bar in as a glass long pill whose formats pill is its sibling, never its child', () => {
    const bar = source('src/renderer/features/editor/editor-selection-bar.ts');
    const css = reviewCss();
    expect(bar).toContain('bar.className = `${BAR_CLASS} editor-selection-bar glass glass--rest glass--surface`;');
    expect(bar).toContain("element.className = 'editor-selection-bar__item glass glass--small';");
    expect(bar).toContain('formats.className = `${BAR_CLASS} editor-selection-bar editor-selection-bar__formats glass glass--rest glass--surface`;');
    // Decoupled: the formats pill goes onto the body beside the bar.
    expect(bar).toContain('bar.append(format);');
    expect(bar).not.toContain('bar.append(format, formats);');
    expect(bar).toContain('document.body.append(bar, formats);');
    expect(bar).toContain('if (!this.bar?.contains(target) && !this.formats?.contains(target)) this.close();');
    expect(bar).toContain("this.formats?.remove(); this.formats = null;");
    // Formats are round glass buttons, each a sand glyph, named for the screen reader.
    expect(bar).toContain("element.className = 'editor-selection-bar__format glass glass--round';");
    expect(bar).toContain("element.setAttribute('aria-pressed', item.isActive?.(this.editor) ? 'true' : 'false');");
    expect(bar).toContain("format.setAttribute('aria-expanded', 'true');");
    for (const glyph of FORMAT_GLYPHS) expect(bar).toContain(`'${glyph}'`);
    expect(bar).toContain('}, SELECTION_BAR_SETTLE_MS);');
    const pill = rule(css, '.editor-selection-bar');
    expect(pill).toContain('flex-direction: row;');
    expect(pill).toContain('border-radius: 20px;');
    expect(pill).toContain('background: var(--glass-fill);');
    expect(pill).toContain('animation: editor-selection-bar-in 0.16s');
    expect(pill).not.toContain('box-shadow');
    expect(pill).not.toContain('--menu-surface');
    expect(rule(css, '.editor-selection-bar__item')).toContain('border-radius: 14px;');
    expect(rule(css, '.editor-selection-bar__format')).toContain('border-radius: 50%;');
    expect(rule(css, '.editor-selection-bar__formats.is-open')).toContain('visibility: visible;');
    // Small glass takes the dense patch (`glass--small`, `glass--round`); the
    // paused phone keeps the desk surface.
    expect(css).not.toContain('.editor-selection-bar > .glass:nth-of-type');
    expect(rule(css, "html[data-shell-mode='mobile'] .editor-selection-bar")).toContain('background: var(--menu-surface-bg);');
  });

  it('presses every scroll tick as a sand seal that deepens under the pointer and fades when it goes', () => {
    const css = reviewCss();
    const markers = source('src/renderer/components/editor/EditorScrollMarkers.tsx');
    const seal = rule(css, '.editor__scrollmap-tick::before');
    expect(seal).toContain('var(--seal-mask');
    expect(seal).toContain('transform: rotate(var(--seal-turn, 0deg));');
    expect(seal).toContain('mix-blend-mode: var(--pigment-blend);');
    expect(seal).toContain('animation: scrollmap-seal-arrive 0.34s');
    for (let shape = 0; shape < 6; shape++) {
      expect(rule(css, `.editor__scrollmap-tick--seal-${shape}`)).toContain(`sand/blob-${shape}.png`);
    }
    expect(rule(css, '.editor__scrollmap-tick:hover::before')).toContain('filter: brightness(0.8) saturate(1.2);');
    expect(rule(css, '.editor__scrollmap-tick.is-leaving::before')).toContain('opacity: 0;');
    // Colours ride --tick-c into the sand; no tick is a solid block any more.
    for (const [selector, body] of rules(css, ['.editor__scrollmap-tick'])) {
      expect(body, selector).not.toMatch(/background:\s*hsl\(var\(--(?:story|comment|rule)/);
      expect(body, selector).not.toContain('box-shadow');
    }
    expect(markers).toContain('const seal = scrollMarkerSeal(tick.key);');
    expect(markers).toContain('editor__scrollmap-tick--seal-${seal.shape}');
    expect(markers).toContain("'--seal-turn': `${seal.turn}deg`");
    expect(markers).toContain("${leaving ? ' is-leaving' : ''}");
    expect(markers).toContain('const LEAVE_MS = 300;');
  });

  it('shares one Bottom Panel shell — height, border, handle and header row — between the timeline and the focused chapter’s plot planner', () => {
    const workspace = source('src/renderer/shells/desktop/DesktopWorkspace.tsx');
    const panel = source('src/renderer/components/workspaceChrome/BottomPanel.tsx');
    const timeline = source('src/renderer/shells/desktop/views/DesktopBottomTimeline.tsx');
    const node = source('src/renderer/views/NodeEditorView.tsx');
    const dock = source('src/renderer/components/editor/PlotPlannerDock.tsx');
    const store = source('src/renderer/store/ui-store.ts');
    const shellCss = source('src/styles/desktop-shell.css');
    // The planner hides itself (the panel closes) while no chapter is in front.
    expect(workspace).toContain('const chapterInFront = useChapterInFront(projectId);');
    expect(workspace).toContain("? (chapterInFront ? 'planner' : null)");
    expect(workspace).not.toContain('plotGrid.noChapter');
    // A departing planner leaves an inert copy, so the grid goes with the panel.
    const slot = source('src/renderer/components/editor/plot-grid/plot-planner-slot.ts');
    expect(dock).toContain('return () => leavePlotPlannerGhost(root);');
    expect(slot).toContain('ghost.inert = true;');
    expect(slot).toContain('to.scrollTop = from.scrollTop;');
    expect(workspace).toContain('<TimelineDrawer open={dockPane !== null}>');
    expect(workspace).toContain('<BottomPanel show={dockPane ?? lastPane}>');
    expect(workspace).toContain('ref={setPlotPlannerSlot}');
    expect(existsSync(resolve(process.cwd(), 'src/renderer/shells/desktop/BottomDockSwap.tsx'))).toBe(false);
    // The shell keeps one remembered height (the timeline's old key) and the top-edge handle.
    expect(panel).toContain("const HEIGHT_STORAGE_KEY = 'timeline-total-height';");
    expect(panel).toContain('resizing.bottom - event.clientY + resizing.grab');
    expect(panel).toContain('<div className="bottom-panel__resize" onMouseDown={startResize} />');
    expect(store).not.toContain('plotPlannerHeight: state.plotPlannerHeight');
    expect(timeline).not.toContain('btl__resize');
    expect(timeline).not.toContain('localStorage.setItem(TIMELINE_HEIGHT_STORAGE_KEY');
    expect(dock).not.toContain('plot-planner__resize');
    expect(dock).not.toContain('plotPlannerHeight');
    // Swapping pushes the whole pane, header included, up or down past the
    // still border, on the sidebar panels' heavy-ice push, outlined in glass.
    expect(panel).toContain("const PANES: readonly BottomPanelPane[] = ['timeline', 'planner'];");
    expect(panel).toContain('transform: `translateY(${move.from}px)`');
    expect(panel).toContain('duration: PUSH_MS, easing: PUSH_EASING');
    expect(panel).toContain('trackGlassFlow(strip,');
    expect(panel).toContain('flow-line flow-line--h bottom-panel__outline-top');
    expect(panel).toContain("prefers-reduced-motion: reduce");
    expect(panel).not.toContain('translateX(');
    expect(shellCss).toContain('.bottom-panel.is-pushing > .bottom-panel__panes {\n  overflow: hidden;');
    // One header row for both, styled once.
    expect(timeline).toContain('<BottomPanelHeader');
    expect(dock).toContain('<BottomPanelHeader');
    expect(workspace).toContain('<BottomPanelHeader');
    expect(source('src/styles/bottom-timeline.css')).not.toContain('.btl__head {');
    expect(source('src/styles/plot-planner.css')).not.toContain('.plot-planner__header');
    // Only the focused editor portals its own chapter's grid into the panel,
    // and keeps it there while the planner pane leaves.
    expect(node).toContain('isVisible && isCommandActive && isActiveNodeReady && plotPlannerSlot &&');
    expect(node).toContain('createPortal(');
    expect(node).not.toContain('a top dock between the bar and the prose');
    // Opening one closes the other.
    expect(store).toContain('{ plotPlannerOpen: true, bottomTimelineHidden: true }');
    expect(store).toContain('{ bottomTimelineHidden: false, plotPlannerOpen: false }');
    // Its header names the chapter beside its mark.
    expect(dock).toContain('<KindMark kind="chapter" seed={nodeId} color={color} />');
    expect(dock).toContain('<span className="plot-planner__chapter">');
  });

  it('draws the desktop plot grid as lanes of paper slips with no wash, shadow or accent', () => {
    const css = source('src/styles/plot-planner.css');
    const grid = source('src/renderer/components/editor/PlotGrid.tsx');
    const planner = rule(css, '.plot-planner');
    expect(planner).toContain('background: var(--workspace-ui-bg);');
    expect(planner).not.toContain('box-shadow');
    expect(planner).not.toContain('border-bottom');
    expect(grid).toContain('className="pl-cell glass glass--rest glass--field"');
    expect(grid).toContain('className="pl-head__text glass glass--field glass--small"');
    expect(grid).toContain("data-ph={t('plotGrid.emptyCell')}");
    expect(rule(css, ".planner-wrap[data-presentation='desktop'] .pl-head--row")).toContain(
      'font-family: var(--font-structure, var(--font-sans));',
    );
    expect(rule(css, ".planner-wrap[data-presentation='desktop'] .pl-cell")).toContain('border-radius: 2px;');
    expect(rule(css, ".planner-wrap[data-presentation='desktop'] tbody tr + tr .pl-cell-td")).toContain(
      'inset 0 0.5px 0 var(--workspace-ui-bg)',
    );
    // Everything the desktop shows: no hover or focus wash, no shadow but the lane lines, no accent.
    const desktop = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map((match) => [match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(), match[2]] as const)
      .filter(([selector]) => !selector.includes("data-presentation='mobile'") && !selector.startsWith('.pl-cell--tap'));
    for (const [selector, body] of desktop) {
      expect(body, selector).not.toContain('--accent');
      if (/:hover|:focus/.test(selector)) expect(body, selector).not.toMatch(/background(?:-color)?:/);
      expect(body, selector).not.toMatch(/box-shadow:\s*inset 0 \d+px \d+px/);
    }
    expect(rule(css, '.pl-size-badge')).not.toContain('var(--ink-1)');
    // The phone keeps its hairline table.
    expect(rule(css, ".planner-wrap[data-presentation='mobile'] .pl-cell")).toContain('border-right: 1px solid hsl(var(--rule-strong));');
  });

  it('draws the format glyphs with the same sand brush and registers them as brush icons', () => {
    const brush = source('src/renderer/components/ui/BrushIcon.tsx');
    const materials = source('src/styles/materials.css');
    const generator = source('scripts/design-assets/brushicons.py');
    for (const glyph of FORMAT_GLYPHS) {
      expect(existsSync(resolve(process.cwd(), `src/assets/design/icons/${glyph}.png`)), glyph).toBe(true);
      expect(brush).toContain(`| '${glyph}'`);
      expect(materials).toContain(`.brush-icon--${glyph} {`);
      expect(generator).toContain(`"${glyph}": (`);
    }
  });

  it('keeps the design system documents in step', () => {
    const docs = designSystemDocs();
    for (const phrase of [
      '## 选区浮条',
      '一级与二级各管各的',
      '## 大纲 rail',
      '当前阅读位置只靠字变明显',
      '整列章名不会抢眼',
      '## 滚动标记',
      '每颗印按它的 key 固定取六枚之一',
      '## 情节规划',
      '情节规划和 Bottom Timeline 共用稿纸下面同一个 Bottom Panel，二选一',
      'Bottom Panel 是一个共享的壳子',
      '时间线整块向上推出顶边，情节规划从下面同时升上来',
      '当前不是章节时情节规划自己隐藏',
      '网格在原处留下一份静止、不可操作的副本',
      '叠在一起的玻璃各管各的',
      '选区浮条不在其中',
    ]) {
      expect(docs, phrase).toContain(phrase);
    }
  });
});
