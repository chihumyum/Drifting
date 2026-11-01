import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import type { SyncCornerState } from '../../sync/sync-health';
import { syncActionsFor } from './sync-status-actions';
import { syncCornerText, syncProblemRowText } from './sync-status-text';

const locale = (name: string) =>
  JSON.parse(readFileSync(resolve(process.cwd(), `src/renderer/locales/${name}.json`), 'utf8')) as Record<string, unknown>;

/** Echoes the key, and fails the test if either locale lacks it. */
const used = new Set<string>();
const t = ((key: string) => {
  used.add(key);
  return key;
}) as unknown as TFunction;

function lookup(tree: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree);
}

const STATES: SyncCornerState[] = [
  { kind: 'syncing', transfer: { phase: 'publishing-segments', progress: { stage: 'upload-changes', completedObjects: 120, totalObjects: 561, transferredBytes: 1024, totalBytes: 4096, totalKnown: true } } },
  { kind: 'syncing', transfer: { phase: 'pulling', progress: { stage: 'download', completedObjects: 40, totalObjects: 40, transferredBytes: 0, totalBytes: 0, totalKnown: false } } },
  { kind: 'syncing', transfer: { phase: 'applying', progress: null } },
  { kind: 'retrying', syncGenerationIds: ['sync-a'] },
  { kind: 'offline', pendingChanges: 561 },
  { kind: 'problem', problem: 'not-started', errorCode: null, failures: 0, syncGenerationIds: [] },
  { kind: 'problem', problem: 'reauth', errorCode: null, failures: 0, syncGenerationIds: [] },
  { kind: 'problem', problem: 'quota', errorCode: 'QUOTA_EXCEEDED', failures: 1, syncGenerationIds: ['sync-a'] },
  { kind: 'problem', problem: 'failing', errorCode: 'SYNC_CYCLE_FAILED', failures: 3, syncGenerationIds: ['sync-a'] },
];

describe('what the paper says about sync', () => {
  it('says nothing for an empty corner', () => {
    expect(syncCornerText({ kind: 'none' }, t, 'en')).toBeNull();
  });

  it('gives every state a title, and a transfer its reading and how far it is', () => {
    const [upload, download, applying] = STATES.map((state) => syncCornerText(state, t, 'en')!);
    expect(upload).toMatchObject({ title: 'notifications.cloudSync.uploadingChanges', ratio: 0.25 });
    expect(upload.reading).toContain('notifications.cloudSync.objectsKnown');
    expect(download).toMatchObject({ title: 'notifications.cloudSync.downloading', ratio: null });
    expect(applying).toEqual({ title: 'notifications.cloudSync.applying' });
    for (const state of STATES) expect(syncCornerText(state, t, 'en')?.title).toBeTruthy();
    expect(syncCornerText(STATES[8]!, t, 'en')).toMatchObject({ title: 'paperSync.failing', code: 'paperSync.failingCode' });
  });

  it('offers retry, sign-in or Settings by what the author can do', () => {
    expect(syncActionsFor('reauth')).toEqual(['sign-in']);
    expect(syncActionsFor('quota')).toEqual(['open-settings', 'retry']);
    for (const state of ['not-started', 'failing', 'retrying', 'offline'] as const) {
      expect(syncActionsFor(state)).toEqual(['retry']);
    }
  });

  it('names the book on the bell and keeps the code in the danger ink', () => {
    expect(
      syncProblemRowText({ problem: 'failing', projectId: 'p', syncGenerationIds: ['s'], errorCode: 'X', failures: 3 }, t, 'Tide Archive'),
    ).toEqual({ title: 'paperSync.failing', detail: 'Tide Archive', error: 'paperSync.failingCode' });
    expect(
      syncProblemRowText({ problem: 'not-started', projectId: null, syncGenerationIds: [], errorCode: null, failures: 0 }, t, null),
    ).toEqual({ title: 'paperSync.notStarted', detail: 'paperSync.notStartedDetail' });
  });

  it('finds every word it uses in both locales', () => {
    for (const state of STATES) syncCornerText(state, t, 'en');
    for (const key of ['paperSync.label', 'paperSync.retry', 'paperSync.signIn', 'paperSync.openSettings', 'paperSync.restored']) used.add(key);
    const zh = locale('zh-CN');
    const en = locale('en');
    for (const key of used) {
      expect(typeof lookup(zh, key), `zh-CN ${key}`).toBe('string');
      expect(typeof lookup(en, key), `en ${key}`).toBe('string');
    }
  });
});
