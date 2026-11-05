import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import type { BookElement } from '../domain/book-element';
import type { BookNode } from '../domain/book-node';
import { installHeadlessDatabaseClient } from '../lib/db';
import { events } from '../lib/events';
import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { registerLiveYDoc } from '../lib/yjs-doc-registry';
import { BookNodeTable, NodeContentTable, ProjectTable } from '../schema/drizzle';
import { createYjsRepository } from '../sqlite-repo/yjs-repo';
import { useAgentChatStore } from '../store/agent-chat-store';
import { useDataStore } from '../store/data-store';
import { ensureActiveSyncGenerationInTransaction } from '../sync/journal/sync-generation-repository';
import { appendAuthoredYjsUpdate } from '../sync/journal/yjs-update';
import { retainElementNameBackfill } from './element-name-backfill.service';

vi.mock('../sync/journal/installation-identity', () => ({
  getSyncInstallationIdentity: async () => ({
    installationId: 'synthetic-backfill-install',
    createWriterIdentity: () => ({ writerId: 'synthetic-backfill-writer', writerEpoch: 'synthetic-backfill-epoch' }),
  }),
}));

const NOW = '2026-11-06T00:00:00.000Z';
const PROJECT = 'project-a';
const cleanups: Array<() => Promise<void> | void> = [];
const initialData = useDataStore.getState();
const initialChat = useAgentChatStore.getState();

function prose(text: string): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  try {
    const block = new Y.XmlElement('paragraph');
    block.setAttribute('id', 'block-1');
    block.insert(0, [new Y.XmlText(text)]);
    doc.getXmlFragment('default').insert(0, [block]);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/** The stored text runs of a chapter with the element each links to. */
async function storedLinks(nodeId: string): Promise<Array<[string, string | null]>> {
  const repository = createYjsRepository();
  const doc = new Y.Doc({ gc: false });
  try {
    const snapshot = await repository.getSnapshot(`node-content:${nodeId}`);
    if (snapshot) Y.applyUpdate(doc, snapshot.stateBlob);
    for (const row of await repository.listUpdates(`node-content:${nodeId}`)) Y.applyUpdate(doc, row.updateBlob);
    const block = doc.getXmlFragment('default').get(0) as Y.XmlElement;
    return block.toArray().flatMap((child) =>
      ((child as Y.XmlText).toDelta() as Array<{ insert: string; attributes?: { entityLink?: { targetId: string } } }>)
        .map((delta): [string, string | null] => [delta.insert, delta.attributes?.entityLink?.targetId ?? null]));
  } finally {
    doc.destroy();
  }
}

const element = (id: string, name: string): BookElement => ({
  id, projectId: PROJECT, categoryId: 'category', name, summary: '', contentJson: '{}', kvJson: '[]',
  aliases: [], groupName: null, portraitAssetId: null, createdAt: NOW, updatedAt: NOW,
} as BookElement);

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-name-backfill-'));
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'synthetic.db'));
  const db = gateway.client();
  cleanups.push(async () => { await gateway.close(); await rm(directory, { recursive: true, force: true }); });
  cleanups.push(installHeadlessDatabaseClient(db, 'synthetic-backfill.db'));
  await db.insert(ProjectTable).values({ id: PROJECT, name: 'Synthetic', userId: 'synthetic-user', createdAt: NOW, updatedAt: NOW });
  await db.transaction((tx) => ensureActiveSyncGenerationInTransaction(tx, { projectId: PROJECT, nowIso: NOW }));
  const nodes: BookNode[] = [];
  for (const [id, text] of [['closed', '老周来了，安纳蒂也来了。'], ['open', '老周在门口。']] as const) {
    await db.insert(BookNodeTable).values({ id, projectId: PROJECT, title: id, positionX: 0, positionY: 0, createdAt: NOW, updatedAt: NOW });
    await db.insert(NodeContentTable).values({ nodeId: id, contentJson: '{}', outlineJson: '[]', plotGridJson: '{}', createdAt: NOW, updatedAt: NOW });
    await appendAuthoredYjsUpdate(PROJECT, `node-content:${id}`, prose(text));
    nodes.push({ id, projectId: PROJECT, title: id } as BookNode);
  }
  // 安纳蒂 was already registered; 老周 is the element being created.
  const laozhou = element('laozhou', '老周');
  useDataStore.setState({
    workspaceProjectId: PROJECT,
    bookNodes: nodes,
    bookElements: [element('annati', '安纳蒂'), laozhou],
    storylines: [],
    bookElementCategories: [],
  });
  const openDoc = new Y.Doc();
  cleanups.push(registerLiveYDoc('node-content:open', openDoc), () => openDoc.destroy());
  const release = retainElementNameBackfill(PROJECT);
  cleanups.push(release);
  return { db, laozhou };
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  useDataStore.setState(initialData, true);
  useAgentChatStore.setState(initialChat, true);
});

describe('linking a created element in closed prose', () => {
  it('waits for the running Agent turn, then links only the new element in closed chapters', async () => {
    useAgentChatStore.setState({ boundProjectId: PROJECT, runningTurns: { conversation: 'turn' } });
    const { db, laozhou } = await fixture();

    events.emit('element:element-created', { element: laozhou });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await storedLinks('closed')).toEqual([['老周来了，安纳蒂也来了。', null]]);

    useAgentChatStore.setState({ runningTurns: {} });
    await vi.waitFor(async () => {
      expect(await storedLinks('closed')).toEqual([['老周', 'laozhou'], ['来了，安纳蒂也来了。', null]]);
    });
    // The open chapter is its editor's to link.
    expect(await storedLinks('open')).toEqual([['老周在门口。', null]]);
    const [cache] = await db.select().from(NodeContentTable).where(eq(NodeContentTable.nodeId, 'closed'));
    expect(cache?.contentJson).toContain('"targetId":"laozhou"');
  });

  it('links every element created during one Agent turn in one write per chapter', async () => {
    useAgentChatStore.setState({ boundProjectId: PROJECT, runningTurns: { conversation: 'turn' } });
    const { laozhou } = await fixture();
    const annati = useDataStore.getState().bookElements.find((item) => item.id === 'annati')!;
    const before = (await createYjsRepository().listUpdates('node-content:closed')).length;

    events.emit('element:element-created', { element: laozhou });
    events.emit('element:element-created', { element: annati });
    useAgentChatStore.setState({ runningTurns: {} });

    await vi.waitFor(async () => {
      expect(await storedLinks('closed')).toEqual([['老周', 'laozhou'], ['来了，', null], ['安纳蒂', 'annati'], ['也来了。', null]]);
    });
    expect((await createYjsRepository().listUpdates('node-content:closed')).length).toBe(before + 1);
  });

  it('links nothing for an element deleted before its turn came', async () => {
    useAgentChatStore.setState({ boundProjectId: PROJECT, runningTurns: { conversation: 'turn' } });
    const { laozhou } = await fixture();

    events.emit('element:element-created', { element: laozhou });
    useDataStore.setState((state) => ({ bookElements: state.bookElements.filter((item) => item.id !== laozhou.id) }));
    useAgentChatStore.setState({ runningTurns: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await storedLinks('closed')).toEqual([['老周来了，安纳蒂也来了。', null]]);
  });
});
