import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createYjsProseSeedState } from '../../../lib/agent/runtime/yjs-prose-command';
import { proseDocId } from '../../../lib/yjs-doc-id';
import { registerLiveYDoc } from '../../../lib/yjs-doc-registry';
import {
  freezeLiveMobilePaperContent,
  mobilePaperSnapshotIsLoading,
} from './mobile-paper-snapshot';

const releases: Array<() => void> = [];

afterEach(() => {
  while (releases.length > 0) releases.pop()?.();
});

describe('mobile paper prose snapshot', () => {
  it('freezes the live Yjs body instead of a stale summary or projection', async () => {
    const contentJson = JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '正在编辑的正文' }] }],
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, await createYjsProseSeedState(contentJson));
    releases.push(registerLiveYDoc(proseDocId('node', 'chapter-1'), doc));

    const frozen = freezeLiveMobilePaperContent({
      key: 'node:chapter-1',
      target: { entityType: 'node', id: 'chapter-1' },
      scrollTop: 0,
    });

    expect(frozen).toContain('正在编辑的正文');
    expect(JSON.parse(frozen ?? '{}')).toMatchObject({ type: 'doc' });
  });

  it('does not invent a snapshot when the paper has no live editor', () => {
    expect(
      freezeLiveMobilePaperContent({
        key: 'category:missing',
        target: { entityType: 'category', id: 'missing' },
        scrollTop: 0,
      }),
    ).toBeUndefined();
  });

  it('renders a frozen chapter immediately instead of replacing it with the loader', () => {
    const paper = {
      key: 'node:chapter-1',
      target: { entityType: 'node' as const, id: 'chapter-1' },
      scrollTop: 0,
    };
    expect(mobilePaperSnapshotIsLoading(paper, '{"type":"doc"}', false)).toBe(false);
    expect(mobilePaperSnapshotIsLoading(paper, undefined, false)).toBe(true);
  });
});
