import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

async function rendererSource(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
}

describe('main prose single-authority architecture', () => {
  it('seeds every ordinary UI prose owner and keeps later projections derived', async () => {
    const [node, element, storyline, category, content] = await Promise.all([
      rendererSource('usecase/useBookNode.ts'),
      rendererSource('usecase/useBookElement.ts'),
      rendererSource('usecase/useStoryline.ts'),
      rendererSource('usecase/useElementCategory.ts'),
      rendererSource('usecase/useBookContent.ts'),
    ]);

    expect(node).toContain('appendAuthoredProseSeedInTransaction');
    expect(element).toContain('appendAuthoredProseSeedInTransaction');
    expect(storyline).toContain('appendAuthoredProseSeedInTransaction');
    expect(category).toContain('appendAuthoredProseSeedInTransaction');
    expect(element).toContain("runDerivedTransaction('prose.element-projection'");
    expect(storyline).toContain("runDerivedTransaction('prose.storyline-projection'");
    expect(category).toContain("runDerivedTransaction('prose.category-projection'");
    expect(content).toContain("runDerivedTransaction('prose.node-content-projection'");
    expect(content).not.toContain("sync('nodeContent'");
  });

  it('imports initial prose through owner creation instead of a second scalar write', async () => {
    const source = await rendererSource('components/modals/ImportDialog.tsx');
    expect(source).toContain('initialContentJson: docJson');
    expect(source).not.toContain('updateContentByNodeId(created.id');
    expect(source).not.toContain('updateElement(created.id');
  });

  it('keeps metrics and closed-document caches derived from journaled Yjs', async () => {
    const [metrics, closedProse] = await Promise.all([
      rendererSource('services/node-prose-metrics.service.ts'),
      rendererSource('lib/agent/chapter-prose.ts'),
    ]);
    expect(metrics).toContain('runDerivedTransaction');
    expect(metrics).toContain("'prose.node-metrics-projection'");
    expect(metrics).not.toContain('withAtomicSyncTransaction');
    expect(closedProse).toContain('appendAuthoredYjsUpdate');
    expect(closedProse).toContain('seed-only-promotion');
    expect(closedProse).toContain("runDerivedTransaction('prose.node-content-projection'");
  });

  it('gives all Agent structural prose creates an in-transaction Yjs state', async () => {
    const source = await rendererSource(
      'lib/agent/runtime/drifting-structural-write-strategy.ts',
    );
    expect(source.match(/appendAuthoredProseSeedInTransaction/gu)).toHaveLength(5);
    expect(source).toContain("entityType: 'node'");
    expect(source).toContain("entityType: 'element'");
    expect(source).toContain("entityType: 'storyline'");
    expect(source).toContain("entityType: 'category'");
  });
});
