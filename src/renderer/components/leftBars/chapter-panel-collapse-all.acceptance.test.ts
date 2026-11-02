import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { designSystemDocs } from '../design-system-docs.test-support';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function block(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Missing block: ${start} -> ${end}`);
  return text.slice(from, to);
}

describe('ChapterPanel expand/collapse-all', () => {
  it('shows the folding fan only while chapters are grouped by storyline', () => {
    const subheader = source('src/renderer/components/leftBars/LeftSidebarSubHeader.tsx');
    const toggle = block(subheader, '{(activeLeftPanel ===', '</SubIconBtn>');

    expect(subheader).toContain(
      "activeLeftPanel === 'nodes' && nodesViewMode === 'storyline' && storylines.length > 0;",
    );
    expect(toggle).toContain(
      "{(activeLeftPanel === 'elements' || activeLeftPanel === 'drift' || chapterIsStoryline) && (",
    );
    expect(toggle).toContain("<SubIconBtn title={t('leftSidebar.actions.collapseAll')} onClick={collapseAll}>");
  });

  it('folds every storyline group and 未归属 together, or opens them all', () => {
    const panel = source('src/renderer/components/leftBars/ChapterPanel.tsx');
    const handler = block(panel, 'const handler = () => {', "return subscribeSidebarCollapse('nodes', paneId, handler);");

    expect(panel).toContain("useSidebarPanelState<Set<string>>('collapsed', () => new Set())");
    expect(handler).toContain('if (prev.size === 0) {');
    expect(handler).toContain('return new Set([...storylines.map((s) => s.id), UNAFFILIATED_GROUP_ID]);');
    expect(handler).toContain('return new Set();');
    expect(designSystemDocs()).toContain('要素类目、构想分组与按故事线分组的章节');
  });
});
