import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { proseDocId } from '../yjs-doc-id';
import { registerLiveYDoc } from '../yjs-doc-registry';
import { registerLocalYjsDocument } from '../../services/yjs-local-durability.service';
import { useDataStore } from '../../store/data-store';
import { useSettingsStore } from '../../store/settings-store';
import { createSyntheticWorkspaceProjection } from '../../performance/fixture';
import {
  revertEntityBlock,
  yInsertBlockWithId,
  yReplaceBlockText,
} from './chapter-prose';

describe('guarded block-level Agent review inverse', () => {
  let doc: Y.Doc;
  let release: () => void;
  let releasePersistence: () => void;

  beforeEach(() => {
    doc = new Y.Doc();
    release = registerLiveYDoc(proseDocId('node', 'node-review'), doc);
    releasePersistence = registerLocalYjsDocument(
      'project-review',
      proseDocId('node', 'node-review'),
      async () => undefined,
    );
  });

  afterEach(() => {
    release();
    releasePersistence();
    doc.destroy();
  });

  it('restores mention marks using the reviewed source without a mounted editor', async () => {
    const before = useDataStore.getState();
    const settings = useSettingsStore.getState();
    try {
      const fixture = createSyntheticWorkspaceProjection('project-review', 2, 1);
      fixture.bookNodes[0] = { ...fixture.bookNodes[0], id: 'node-review', title: '源章节' };
      fixture.bookNodes[1] = { ...fixture.bookNodes[1], title: '目标章节' };
      useDataStore.setState({ ...fixture, workspaceProjectId: 'project-review', workspaceProjectionEpoch: 1 });
      useSettingsStore.setState({ autoElementLinkEnabled: true });
      const fragment = doc.getXmlFragment('default');
      doc.transact(() => yInsertBlockWithId(fragment, null, 'mention-block', 'Agent 正文'));
      await revertEntityBlock('node', 'node-review', {
        blockId: 'mention-block', op: 'changed', oldText: '源章节与目标章节', newText: 'Agent 正文', afterPrevId: null,
      }, undefined, 'project-review');
      const paragraph = fragment.get(0) as Y.XmlElement;
      const text = paragraph.get(0) as Y.XmlText;
      const segments = text.toDelta() as { insert: string; attributes?: { entityLink?: { targetId: string } } }[];
      expect(segments.filter((segment) => segment.attributes?.entityLink).map((segment) => [segment.insert, segment.attributes?.entityLink?.targetId]))
        .toEqual([['目标章节', fixture.bookNodes[1].id]]);
    } finally {
      useDataStore.setState(before, true);
      useSettingsStore.setState(settings, true);
    }
  });

  it('removes one Agent-created block and is idempotent on retry', async () => {
    const fragment = doc.getXmlFragment('default');
    doc.transact(() => {
      yInsertBlockWithId(fragment, null, 'agent-block', 'agent text');
    });

    const change = {
      blockId: 'agent-block',
      op: 'new' as const,
      oldText: '',
      newText: 'agent text',
      afterPrevId: null,
    };
    await revertEntityBlock('node', 'node-review', change);
    await revertEntityBlock('node', 'node-review', change);

    expect(fragment.length).toBe(0);
  });

  it('refuses to overwrite author text changed after the Agent edit', async () => {
    const fragment = doc.getXmlFragment('default');
    doc.transact(() => {
      yInsertBlockWithId(fragment, null, 'edited-block', 'agent text');
      yReplaceBlockText(fragment, { blockId: 'edited-block' }, 'author text');
    });

    await expect(
      revertEntityBlock('node', 'node-review', {
        blockId: 'edited-block',
        op: 'changed',
        oldText: 'original text',
        newText: 'agent text',
        afterPrevId: null,
      }),
    ).rejects.toThrow('refusing to overwrite author text');
    expect(fragment.toString()).toContain('author text');
  });

  it('restores one deleted block once under its surviving anchor', async () => {
    const fragment = doc.getXmlFragment('default');
    doc.transact(() => {
      yInsertBlockWithId(fragment, null, 'anchor', 'anchor text');
    });
    const change = {
      blockId: 'deleted-block',
      op: 'deleted' as const,
      oldText: 'restored text',
      newText: '',
      afterPrevId: 'anchor',
    };

    await revertEntityBlock('node', 'node-review', change);
    await revertEntityBlock('node', 'node-review', change);

    expect(fragment.length).toBe(2);
    expect(fragment.toString()).toContain('restored text');
  });

  it('preserves unrelated author edits while reverting only the certified Agent block', async () => {
    const fragment = doc.getXmlFragment('default');
    doc.transact(() => {
      yInsertBlockWithId(fragment, null, 'agent-target', 'agent text');
      yInsertBlockWithId(fragment, 'agent-target', 'author-block', 'before author edit');
      yReplaceBlockText(fragment, { blockId: 'author-block' }, 'after author edit');
      yInsertBlockWithId(fragment, 'author-block', 'author-new', 'new author paragraph');
    });

    await revertEntityBlock('node', 'node-review', {
      blockId: 'agent-target',
      op: 'changed',
      oldText: 'original text',
      newText: 'agent text',
      afterPrevId: null,
    });

    expect(fragment.toString()).toContain('original text');
    expect(fragment.toString()).toContain('after author edit');
    expect(fragment.toString()).toContain('new author paragraph');
    expect(fragment.toString()).not.toContain('agent text');
  });

  it('retries idempotently when Yjs changed but the first persistence acknowledgement failed', async () => {
    releasePersistence();
    let flushes = 0;
    releasePersistence = registerLocalYjsDocument(
      'project-review',
      proseDocId('node', 'node-review'),
      async () => {
        flushes += 1;
        if (flushes === 1) throw new Error('flush acknowledgement lost');
      },
    );
    const fragment = doc.getXmlFragment('default');
    doc.transact(() => {
      yInsertBlockWithId(fragment, null, 'retry-block', 'agent text');
    });
    const change = {
      blockId: 'retry-block',
      op: 'changed' as const,
      oldText: 'original text',
      newText: 'agent text',
      afterPrevId: null,
    };

    await expect(
      revertEntityBlock('node', 'node-review', change),
    ).rejects.toThrow('failed to flush');
    expect(fragment.toString()).toContain('original text');

    await expect(
      revertEntityBlock('node', 'node-review', change),
    ).resolves.toBeUndefined();
    expect(flushes).toBe(2);
    expect(fragment.toString()).toContain('original text');
    expect(fragment.toString()).not.toContain('agent text');
  });
});
