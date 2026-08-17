import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function productionSources(directory: string): readonly string[] {
  const result: string[] = [];
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...productionSources(relative));
    } else if (
      /\.tsx?$/u.test(entry.name) &&
      !/\.(?:test|integration|acceptance)\.tsx?$/u.test(entry.name)
    ) {
      result.push(relative);
    }
  }
  return result;
}

describe('fractional discrete-order architecture', () => {
  it('pins the official Rocicorp implementation and removes numeric key codecs', () => {
    const packageJson = JSON.parse(source('package.json')) as {
      dependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies?.['fractional-indexing']).toBe('4.0.0');

    const forbidden = /positionKeyFromNumber|numberFromPositionKey|bookActPositionKey|bookActProjectionFromPositionKey|allocateAuthoredPositionKeyInTransaction|p1:[0-9a-f]|POSITION_WIDTH|KV_POSITION_STEP/u;
    const violations = productionSources('src/renderer')
      .filter((file) => forbidden.test(source(file)));
    expect(violations).toEqual([]);
  });

  it('keeps every authored family on adjacent authority or explicit rebalance paths', () => {
    const adjacentWriters = [
      'src/renderer/usecase/useStoryline.ts',
      'src/renderer/usecase/useLibraryItem.ts',
      'src/renderer/usecase/useDriftGroup.ts',
      'src/renderer/usecase/synced-entity-commands.ts',
      'src/renderer/usecase/sync-lifecycle-restore.ts',
      'src/renderer/lib/agent/runtime/drifting-structural-write-strategy.ts',
      'src/renderer/lib/agent/runtime/drifting-element-patch-write-strategy.ts',
    ];
    for (const file of adjacentWriters) {
      expect(source(file), file).toContain('appendPlannedAuthoredOrderInTransaction');
    }
    expect(source('src/renderer/usecase/normalized-kv-alias-authority.ts')).toContain(
      'planAuthoredOrderMutation',
    );
    expect(source('src/renderer/sqlite-repo/plot-grid-repo.ts')).toContain(
      'fractionalPositionKeyBetween',
    );
    expect(source('src/renderer/usecase/useDriftGroup.ts')).toContain(
      'appendAuthoredOrderRebalance',
    );
    for (const continuousCoordinateWriter of [
      'src/renderer/usecase/book-node-write.ts',
      'src/renderer/usecase/useBookNode.ts',
      'src/renderer/usecase/useBookAct.ts',
    ]) {
      expect(source(continuousCoordinateWriter), continuousCoordinateWriter).not.toContain(
        'appendPlannedAuthoredOrderInTransaction',
      );
    }
  });

  it('uses UTF-8 tie-breaks and deterministic rank materialization', () => {
    const authorityFiles = [
      'src/renderer/sync/journal/order-authority.ts',
      'src/renderer/sync/reducer/reducer.ts',
      'src/renderer/sync/reducer/production-domain-kernel.ts',
      'src/renderer/sync/checkpoint/domain-catalog.ts',
      'src/renderer/sqlite-repo/plot-grid-repo.ts',
      'src/renderer/domain/book-act.ts',
    ];
    for (const file of authorityFiles) {
      expect(source(file), file).not.toContain('localeCompare');
    }
    const checkpointCatalog = source('src/renderer/sync/checkpoint/domain-catalog.ts');
    expect(checkpointCatalog).not.toContain('const actRanks = orderRanks(');
    expect(checkpointCatalog).not.toContain("orderRanks(restoredOrders, 'chapter'");
  });
});
