import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { designSystemDocs } from '../design-system-docs.test-support';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('Agent changes: in-place reveal and lingering colour', () => {
  it('plays every prose reveal in place on every shell', () => {
    const animator = source('src/renderer/components/editor/AgentEditAnimator.tsx');
    // No shell switch: the prose reveal is always the in-place overwrite.
    expect(animator).not.toContain('isMobileShell');
    expect(animator).not.toContain('getPlatformRuntime');
    expect(animator).not.toContain("'typewriter'");
    expect(animator).toContain('const total = useMemo(() => agentRevealSteps(agentRevealPieces(segs)), [segs]);');
    expect(animator).toContain('mode="overwrite"');
    expect(animator).not.toContain('mode={mode}');
    const text = source('src/renderer/components/editor/AgentRevealText.tsx');
    expect(text).toContain('agentRevealFrame(pieces, progress)');
    expect(text).toContain('`${classPrefix}__${run.mark}`');
    // Field reveals keep the typewriter (no mode passed).
    expect(source('src/renderer/components/editor/FieldReview.tsx')).not.toContain('mode=');
  });

  it('records what each revealed change wrote, on every shell', () => {
    const animator = source('src/renderer/components/editor/AgentEditAnimator.tsx');
    expect(animator).toMatch(/^\s*recordAgentRecentChange\(entityType, id, c\);$/m);
    const external = source('src/renderer/lib/external-edit-presentation.ts');
    expect(external).toMatch(/^\s*recordAgentRecentChange\(entityType, id, change\);$/m);
    expect(external).not.toContain('isMobileShell');
  });

  it('paints the marks as a colour without touching the prose and lets one go as soon as the pointer touches it', () => {
    const painter = source('src/renderer/lib/agent-recent-highlight.ts');
    expect(painter).toContain('highlights');
    expect(painter).not.toMatch(/classList|setAttribute\(|Decoration\./);
    expect(painter).not.toMatch(/DWELL|setTimeout\(\(\) => \{\s*dismiss/);
    expect(painter).toContain('for (const id of touched) dismissAgentRecentMark(id);');
    // Words scrolling under a still pointer count too: the scroller's scroll
    // re-checks the pointer's path through the content.
    expect(painter).toContain("this.scrollEl.addEventListener('scroll', this.onScroll, { passive: true });");
    expect(painter).toContain("this.scrollEl.removeEventListener('scroll', this.onScroll);");
    expect(painter).toContain('pointerPathStart(this.trail, point,');
    expect(painter).toContain('pathTouchesRect(from, point, rect)');
    expect(painter).toContain("attributeFilter: ['aria-hidden']");
    const mount = source('src/renderer/components/editor/AgentRecentChangeHighlights.tsx');
    // The painter is built on every shell; only a missing scroller skips it.
    expect(mount).not.toContain('isMobileShell');
    expect(mount).toContain('if (!scrollEl) return null;');
    expect(mount).toContain('new AgentRecentHighlightPainter(scrollEl,');
    expect(mount).toContain('const presented = isVisible || isPreparing;');
    expect(source('src/renderer/components/editor/EditorReviewLayer.tsx')).toContain('<AgentRecentChangeHighlights');
    expect(source('src/renderer/views/AllChaptersEditorView.tsx'))
      .toContain('<AgentRecentChangeHighlights scrollEl={scrollEl} entityType="node" targetId={null} />');
  });

  it('tints the reveal runs and leaves only coloured ink in the live prose', () => {
    const css = source('src/styles/comments-review.css');
    for (const kind of ['new', 'chg']) {
      const rule = new RegExp(`\\.agent-reveal__${kind} \\{([^}]+)\\}`).exec(css)?.[1];
      expect(rule).toContain(`color: hsl(var(--agent-${kind}-ink));`);
      expect(rule).toContain(`background: hsl(var(--agent-${kind}-ink) / 0.18);`);
      expect(rule).toContain('border-radius: 2px;');
      expect(rule).not.toMatch(/padding|margin/);
    }
    for (const name of ['agent-recent-new', 'agent-recent-new-1', 'agent-recent-new-2', 'agent-recent-chg', 'agent-recent-chg-1', 'agent-recent-chg-2']) {
      expect(css).toContain(`::highlight(${name}) { color:`);
    }
    expect(css).toContain('transition: background-color var(--agent-reveal-ground-fade-duration, 180ms) ease-out;');
    expect(css).toMatch(/\.agent-reveal--settle \.agent-reveal__chg \{\s*background-color: transparent;/);
    const animator = source('src/renderer/components/editor/AgentEditAnimator.tsx');
    expect(animator).toContain('setSettling(true);');
    expect(animator).toContain('window.setTimeout(() => done.current(), GROUND_FADE_MS)');
    expect(animator).toContain("'--agent-reveal-ground-fade-duration': `${GROUND_FADE_MS}ms`");
    const agent = css.slice(css.indexOf('/* Desktop: what the Agent writes is coloured ink'),
      css.indexOf('Agent NON-PROSE field review'));
    expect(agent).not.toMatch(/prose-sand|mix-blend-mode|background-image/);
    // Field reveals (typewriter) keep their tinted grounds; the overlay keeps its opaque backdrop.
    expect(css).toMatch(/\.agent-reveal__ins \{[^}]*background: hsl\(var\(--story-3\) \/ 0\.18\)/);
    expect(source('src/renderer/components/editor/AgentEditAnimator.tsx')).toContain('background: agentEditOpaqueBackground(backgroundCandidates)');
  });

  it('documents the reveal and the lingering colour', () => {
    const docs = designSystemDocs();
    expect(docs).toContain('揭示是原地覆盖');
    expect(docs).toContain('写完留色到指针碰到');
    expect(docs).toContain('指针不动、滚动稿纸时，从指针底下经过的字也算碰到');
    expect(docs).toContain('RECENT_CHANGE_FADE_MS');
    expect(source('docs/agent-runtime/durable-commit-review-protocol.md')).toContain('`mode="overwrite"`');
  });
});
