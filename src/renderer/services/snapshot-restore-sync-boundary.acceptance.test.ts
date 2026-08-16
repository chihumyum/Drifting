import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('snapshot history SyncEngine boundary', () => {
  it('journals every closed-document restore before compaction', () => {
    const restore = source('./snapshot-restore.service.ts');

    expect(restore).toContain("'history.restore-prose'");
    expect(restore).toContain('runAuthoredTransaction');
    expect(restore).toContain('appendYjsUpdateMutation');
    expect(restore).toContain('await txRepo.upsertSnapshot');
    expect(restore).toContain('await compactUpdatesAfterSnapshot');
    expect(restore.indexOf('runAuthoredTransaction')).toBeLessThan(
      restore.indexOf('await compactUpdatesAfterSnapshot'),
    );
    expect(restore).not.toContain('await yrepo.appendUpdate');
  });

  it('flushes an open document and keeps local history off hosted HTTP', () => {
    const restore = source('./snapshot-restore.service.ts');
    const history = source('./snapshot-history.service.ts');

    expect(restore).toContain('await flushOpenYjsDocument(docId)');
    expect(history).not.toMatch(/apiClient|\/api\/snapshots|pushToCloud|stateBlobBase64/u);
  });
});
