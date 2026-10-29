import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { designSystemDocs } from '../design-system-docs.test-support';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('sand in prose (desktop)', () => {
  it('draws comment anchors in sand on the desktop and keeps the mobile wash', () => {
    const mount = source('src/renderer/components/editor/CommentAnchorHighlights.tsx');
    expect(mount).toMatch(/isMobileShell\s*\?\s*new CommentHighlightPainter\(scrollEl\)\s*:\s*new CommentSandPainter\(scrollEl\)/);
    expect(mount).toContain('painter.update(comments, activeId, selected)');
    expect(mount).toContain('painter.dispose()');
    expect(mount).toContain('const presented = isVisible || isPreparing;');
  });

  it('paints on a text-free layer after the page, never in the prose', () => {
    const painter = source('src/renderer/lib/comment-sand.ts');
    expect(painter).not.toMatch(/CSS\.highlights|Decoration\.|contenteditable/i);
    expect(painter).toContain("layer.setAttribute('aria-hidden', 'true')");
    expect(painter).toContain("closest<HTMLElement>('.editor__spread')");
    // After the page, so it can blend with the words (WebKit does not blend a
    // link's sand with a layer beneath the prose).
    expect(painter).toContain('el.append(layer)');
    // Its own nodes never count as prose mutations.
    expect(painter).toContain('target.closest(`.${LAYER_CLASS}`)');
    // Geometry follows the prose on the next frame; anchors re-resolve on the debounce.
    expect(painter).toContain('requestAnimationFrame(');
    expect(painter).toContain('RESOLVE_DELAY_MS = 150');
    // Only rows near the viewport are measured, and nothing listens to scroll.
    expect(painter).toContain('new IntersectionObserver(');
    expect(painter).toContain("NEAR_MARGIN = '100% 0px'");
    expect(painter).not.toContain("addEventListener('scroll'");
    // Measures text only, so block children cannot report the full column.
    expect(painter).toContain('NodeFilter.SHOW_TEXT');
    // A selection draws again; going fades as a whole.
    expect(painter).toContain("clipPath: 'inset(0 100% 0 0)'");
    expect(painter).toContain("dataset.state = 'gone'");
    expect(painter).toContain('SAND_FADE_MS');
  });

  it('blends the layer with the words and eases every change of state', () => {
    const css = source('src/styles/comments-review.css');
    const layer = rule(css, '.comment-sand-layer');
    expect(layer).toContain('pointer-events: none');
    expect(layer).toContain('user-select: none');
    // No stacking context, or the blend would see nothing beneath.
    expect(layer).not.toMatch(/z-index|contain:|opacity|isolation/);
    expect(css).not.toContain(":root:not([data-shell-mode='mobile']) .editor__spread {");
    const sand = rule(css, '.comment-sand');
    // Like pigment over the words: every word keeps its own colour.
    expect(sand).toContain('mix-blend-mode: var(--prose-sand-layer-blend)');
    expect(sand).toContain('transition: opacity var(--motion-sand-shift)');
    expect(sand).toContain('animation: comment-sand-arrive var(--motion-sand-fade)');
    expect(rule(css, ".comment-sand[data-state='gone']")).toContain('opacity: 0');
    expect(rule(css, ".comment-sand[data-state='hot']")).toContain('--comment-sand-hot');
    // At rest the swash is light enough to read through; pointing at its card
    // turns it to a sparser swash of the same grains, only a little stronger.
    expect(rule(css, '.comment-sand')).toContain('--comment-sand-rest: 0.27;');
    expect(rule(css, '.comment-sand')).toContain('--comment-sand-hot: 0.61;');
    expect(rule(css, '.comment-sand--todo')).toContain('--comment-sand-rest: 0.29;');
    expect(rule(css, '.comment-sand--todo')).toContain('--comment-sand-hot: 0.66;');
    expect(rule(css, '.comment-sand__line::before')).toContain("url('../assets/design/sand/hl.png')");
    expect(css).toMatch(/\n\.comment-sand__line::after \{[^}]*url\('\.\.\/assets\/design\/sand\/hl-hot\.png'\)[^}]*opacity: 0;/);
    expect(rule(css, ".comment-sand[data-state='hot'] .comment-sand__line::before")).toContain('opacity: 0');
    expect(rule(css, ".comment-sand[data-state='hot'] .comment-sand__line::after")).toContain('opacity: 1');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.comment-sand,\s*\.comment-sand__line::before,\s*\.comment-sand__line::after \{\s*transition: none;\s*animation: none;/);
    // The mobile wash stays.
    expect(css).toContain('::highlight(comment-hl-manual) {');
  });

  it('selects a comment from its card, its scroll tick or by writing it', () => {
    for (const path of ['src/renderer/features/comments/ReviewItemCard.tsx', 'src/renderer/features/library/TodoCard.tsx']) {
      const card = source(path);
      expect(card, path).toMatch(/if \(sand\) selectCommentHighlight\(\w+\.id\);/);
      expect(card, path).toContain('{ flash: !sand }');
    }
    expect(source('src/renderer/components/editor/EditorScrollMarkers.tsx'))
      .toContain("tick.key.startsWith('c:') && !getPlatformRuntime().isMobileShell");
    expect(source('src/renderer/components/editor/StickyNoteRail.tsx'))
      .toContain('if (glass) selectCommentHighlight(created.id);');
    expect(source('src/renderer/lib/comment-sand.ts')).toContain('clearSelectedCommentHighlight()');
  });

  it('draws entity links with one dry underline in their colour', () => {
    const css = source('src/styles/index.css');
    const link = rule(css, ":root:not([data-shell-mode='mobile']) .entity-link");
    expect(link).toContain('var(--prose-sand-ul)');
    expect(link).toContain('box-decoration-break: clone');
    expect(link).toContain('mix-blend-mode: var(--prose-sand-blend)');
    expect(link).toContain('transition: --prose-sand-a var(--motion-sand-shift)');
    expect(link).toContain('max(100%, 194px) 7px');
    // The cover turns to the page colour, so an isolated group shows nothing extra.
    expect(link).toContain('background-blend-mode: normal, var(--prose-sand-cover-blend), normal, normal');
    expect(rule(css, ":root:not([data-shell-mode='mobile']) .entity-link:hover")).toContain('--prose-sand-a: 0.95');
    expect(rule(css, ":root:not([data-shell-mode='mobile'])[data-entity-link-band-style='dots'] .entity-link"))
      .toContain('var(--prose-sand-ul-loose)');
    expect(rule(css, ":root:not([data-shell-mode='mobile'])[data-entity-link-style='hover'] .entity-link"))
      .toContain('--prose-sand-a: 0');
    // The mobile band stays.
    expect(rule(css, '.entity-link')).toContain('linear-gradient(');
  });

  it('keeps the colourless covers generated and the material tokens per theme', () => {
    for (const name of ['ul-cover', 'ul-cover-dark', 'ul-loose-cover', 'ul-loose-cover-dark']) {
      expect(existsSync(resolve(process.cwd(), `src/assets/design/sand/${name}.png`)), name).toBe(true);
      expect(source('scripts/design-assets/README.md')).toContain(`sand/${name}.png`);
    }
    const materials = source('src/styles/materials.css');
    // Agent changes are coloured ink now, not loose sand.
    expect(existsSync(resolve(process.cwd(), 'src/assets/design/sand/hl-loose-cover.png'))).toBe(false);
    expect(materials).not.toContain('--prose-sand-hl-loose');
    expect(materials).toContain('@property --prose-sand-a');
    expect(materials).toContain('--prose-sand-blend: darken;');
    expect(materials).toContain('--prose-sand-blend: lighten;');
    expect(materials).toContain('--prose-sand-cover-blend: multiply;');
    expect(materials).toContain('--prose-sand-cover-blend: screen;');
    expect(materials).toContain('--prose-sand-layer-blend: multiply;');
    expect(materials).toContain('--prose-sand-layer-blend: screen;');
    expect(materials).toContain("--prose-sand-ul: url('../assets/design/sand/ul-cover-dark.png');");
  });

  it('anchors to the copy of a whole-book chapter that is shown', () => {
    const lookup = source('src/renderer/lib/comment-highlight.ts');
    expect(lookup).toContain("el.closest('[aria-hidden=\"true\"]') !== null");
    expect(source('src/renderer/lib/comment-sand.ts')).toContain("attributeFilter: ['aria-hidden']");
  });

  it('documents the migration in the design system', () => {
    const docs = designSystemDocs();
    expect(docs).toContain('### 砂笔进正文');
    expect(docs).toContain('comment-sand.ts');
    expect(docs).toContain('covergen.py');
    expect(docs).not.toContain('砂笔还没进正文');
    expect(source('docs/design-system/acceptance.md')).toContain('comment-sand.acceptance.test.ts');
  });
});
