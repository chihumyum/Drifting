import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { designSystemDocs } from '../design-system-docs.test-support';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('Agent changes: in-place reveal and lingering colour (desktop)', () => {
  it('plays prose reveals in place on the desktop and keeps the typewriter on mobile', () => {
    const animator = source('src/renderer/components/editor/AgentEditAnimator.tsx');
    expect(animator).toMatch(/getPlatformRuntime\(\)\.isMobileShell \? 'typewriter' : 'overwrite'/);
    expect(animator).toContain("const total = mode === 'overwrite' ? steps : delChars + insChars;");
    expect(animator).toContain('agentRevealSteps(agentRevealPieces(segs))');
    expect(animator).toContain('mode={mode}');
    const text = source('src/renderer/components/editor/AgentRevealText.tsx');
    expect(text).toContain('agentRevealFrame(pieces, progress)');
    expect(text).toContain('`${classPrefix}__${run.mark}`');
    // Field reveals keep the typewriter (no mode passed).
    expect(source('src/renderer/components/editor/FieldReview.tsx')).not.toContain('mode=');
  });

  it('records what each revealed change wrote, on the desktop only', () => {
    const animator = source('src/renderer/components/editor/AgentEditAnimator.tsx');
    expect(animator).toContain('if (!getPlatformRuntime().isMobileShell) recordAgentRecentChange(entityType, id, c);');
  });

  it('paints the marks as a colour without touching the prose and lets one go after a dwell', () => {
    const painter = source('src/renderer/lib/agent-recent-highlight.ts');
    expect(painter).toContain('highlights');
    expect(painter).not.toMatch(/classList|setAttribute\(|Decoration\./);
    expect(painter).toContain('RECENT_CHANGE_DWELL_MS');
    expect(painter).toContain('dismissAgentRecentMark(id)');
    expect(painter).toContain("attributeFilter: ['aria-hidden']");
    const mount = source('src/renderer/components/editor/AgentRecentChangeHighlights.tsx');
    expect(mount).toContain('getPlatformRuntime().isMobileShell');
    expect(mount).toContain('const presented = isVisible || isPreparing;');
    expect(source('src/renderer/components/editor/EditorReviewLayer.tsx')).toContain('<AgentRecentChangeHighlights');
    expect(source('src/renderer/views/AllChaptersEditorView.tsx'))
      .toContain('<AgentRecentChangeHighlights scrollEl={scrollEl} entityType="node" targetId={null} />');
  });

  it('styles Agent writing as coloured ink with no ground', () => {
    const css = source('src/styles/comments-review.css');
    expect(css).toContain('.agent-reveal__new { color: hsl(var(--agent-new-ink)); }');
    expect(css).toContain('.agent-reveal__chg { color: hsl(var(--agent-chg-ink)); }');
    for (const name of ['agent-recent-new', 'agent-recent-new-1', 'agent-recent-new-2', 'agent-recent-chg', 'agent-recent-chg-1', 'agent-recent-chg-2']) {
      expect(css).toContain(`::highlight(${name}) { color:`);
    }
    const agent = css.slice(css.indexOf('/* Desktop: what the Agent writes is coloured ink'),
      css.indexOf('Agent NON-PROSE field review'));
    expect(agent).not.toMatch(/prose-sand|mix-blend-mode|background-image/);
    // The paused mobile shell keeps its tinted grounds; the overlay keeps its opaque backdrop.
    expect(css).toMatch(/\.agent-reveal__ins \{[^}]*background: hsl\(var\(--story-3\) \/ 0\.18\)/);
    expect(source('src/renderer/components/editor/AgentEditAnimator.tsx')).toContain('background: agentEditOpaqueBackground(backgroundCandidates)');
  });

  it('documents the reveal and the lingering colour', () => {
    const docs = designSystemDocs();
    expect(docs).toContain('揭示是原地覆盖');
    expect(docs).toContain('写完留色到指针停住');
    expect(docs).toContain('RECENT_CHANGE_DWELL_MS');
    expect(source('docs/agent-runtime/durable-commit-review-protocol.md')).toContain('`mode="overwrite"`');
  });
});
