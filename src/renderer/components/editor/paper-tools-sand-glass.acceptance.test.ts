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
  it('lays one short swipe of its owner-coloured sand under the reading location and bolds the path above it', () => {
    const css = reviewCss();
    const rail = source('src/renderer/components/editor/EditorOutlineRail.tsx');
    const sand = rule(css, '.editor__toc-tag-sand');
    expect(sand).toContain("url('../assets/design/sand/hl.png')");
    expect(sand).toContain('height: 5px;');
    expect(sand).toContain('width: min(calc(100% + 4px), 2.8em);');
    expect(sand).toContain('var(--toc-sand, hsl(var(--ink-3)))');
    expect(sand).toContain('mix-blend-mode: var(--pigment-blend);');
    expect(rule(css, '.editor__toc-tag.is-primary > .editor__toc-tag-sand')).toContain('opacity: var(--pigment);');
    expect(rule(css, ".editor__toc-tag.is-primary[data-sand='draw'] > .editor__toc-tag-sand")).toContain('animation: toc-sand-draw 0.38s');
    const path = rule(css, '.editor__toc-tag.is-active-path:not(.is-primary)');
    expect(path).toContain('font-weight: 600;');
    // No accent anywhere on the rail: not the reading location, its path, numbers or revealed rows.
    for (const [selector, body] of rules(css, ['.editor__toc-tag', '.editor__toc-tag-num', '.editor__toc-reveal-item'])) {
      expect(body, selector).not.toContain('--accent');
    }
    // Acts in the serif structure face, no dash before them, no branch dot after anything.
    expect(rule(css, '.editor__toc-tag--l1')).toContain('font-family: var(--font-structure, var(--font-sans));');
    expect(css).not.toContain('.editor__toc-tag--l1::before');
    expect(css).not.toContain('.editor__toc-tag-branch');
    expect(rail).not.toContain('editor__toc-tag-branch');
    // The sand takes the entry's own colour, else its nearest ancestor's, else the editor's.
    expect(rail).toContain('outlineEntryColor(flat, primaryId) ?? color');
    expect(rail).toContain("'--toc-sand': sandColor");
    expect(rail).toContain("data-sand={primary && sandDrawn ? 'draw' : undefined}");
    expect(rail).toContain('className="menu-surface menu-surface--compact editor__toc-omission-reveal');
    expect(rail).toContain('className={`menu-surface__item editor__toc-reveal-item');
    expect(source('src/renderer/views/NodeEditorView.tsx')).toContain('color={mainStoryline?.color || undefined}');
    expect(source('src/renderer/views/AllChaptersEditorView.tsx')).toContain(
      "color: storylineById.get(primaryStorylineByNode[n.id] ?? '')?.color || undefined",
    );
    expect(source('src/renderer/views/StorylineEditorView.tsx')).toContain('color={currentStoryline.color || undefined}');
    expect(source('src/renderer/views/CategoryEditorView.tsx')).toContain('color={curCategory.color || undefined}');
  });

  it('floats the selection bar in as a glass long pill whose formats pill is its sibling, never its child', () => {
    const bar = source('src/renderer/features/editor/editor-selection-bar.ts');
    const css = reviewCss();
    expect(bar).toContain('bar.className = `${BAR_CLASS} editor-selection-bar glass glass--rest glass--surface`;');
    expect(bar).toContain("element.className = 'editor-selection-bar__item glass';");
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
    expect(bar).toContain('const SETTLE_MS = 180;');
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
    // Small glass takes the dense patch; the paused phone keeps the desk surface.
    expect(rule(css, '.editor-selection-bar > .glass:nth-of-type(4n + 1)')).toContain('--glass-gx: -96px;');
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

  it('shares the dock under the paper between the Bottom Timeline and the focused chapter’s plot planner', () => {
    const workspace = source('src/renderer/shells/desktop/DesktopWorkspace.tsx');
    const swap = source('src/renderer/shells/desktop/BottomDockSwap.tsx');
    const node = source('src/renderer/views/NodeEditorView.tsx');
    const dock = source('src/renderer/components/editor/PlotPlannerDock.tsx');
    const store = source('src/renderer/store/ui-store.ts');
    expect(workspace).toContain("plotPlannerOpen ? 'planner' : bottomTimelineHidden ? null : 'timeline'");
    expect(workspace).toContain('<TimelineDrawer open={dockPane !== null}>');
    expect(workspace).toContain('ref={setPlotPlannerSlot}');
    expect(swap).toContain("const PANES: readonly BottomDockPane[] = ['timeline', 'planner'];");
    expect(swap).toContain('duration: SIDEBAR_PUSH_MS, easing: SIDEBAR_PUSH_EASING');
    expect(swap).toContain("prefers-reduced-motion: reduce");
    // Only the focused editor portals its own chapter's grid into the dock.
    expect(node).toContain('plotPlannerOpen && isCommandActive && isActiveNodeReady && plotPlannerSlot &&');
    expect(node).toContain('createPortal(');
    expect(node).not.toContain('a top dock between the bar and the prose');
    // Opening one closes the other.
    expect(store).toContain('{ plotPlannerOpen: true, bottomTimelineHidden: true }');
    expect(store).toContain('{ bottomTimelineHidden: false, plotPlannerOpen: false }');
    // Resized by its top edge; its header names the chapter beside its mark.
    expect(dock).toContain('dockBottom - (e.clientY - grabOffsetRef.current)');
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
    expect(grid).toContain('className="pl-head__text glass glass--field"');
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
      '横着抹短短一道干笔砂',
      '## 滚动标记',
      '每颗印按它的 key 固定取六枚之一',
      '## 情节规划',
      '情节规划和 Bottom Timeline 共用稿纸下面同一个位置，二选一',
      '叠在一起的玻璃各管各的',
      '选区浮条不在其中',
    ]) {
      expect(docs, phrase).toContain(phrase);
    }
  });
});
