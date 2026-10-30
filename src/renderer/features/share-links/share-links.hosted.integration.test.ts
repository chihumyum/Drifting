import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../lib/db';
import { BookElementTable, CommentTable, NodeContentTable } from '../../schema/drizzle';
import { createWorkspaceProjectionFixture, WORKSPACE_TEST_INPUT as INPUT } from '../../services/workspace-projection.test-support';
import { anchorForSelection } from '../../../share-web/anchor';
import type { ShareDocument } from '../../../shared/share-document';

const origin = process.env.HOSTED_TEST_ORIGIN;
const session = vi.hoisted(() => ({ binding: null as { accountSubject: string; token: string } | null }));

vi.mock('../../lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/config')>();
  const service = process.env.HOSTED_TEST_ORIGIN ?? 'http://localhost:3000';
  return {
    ...actual,
    APP_CONFIG: { ...actual.APP_CONFIG, LOCAL_ONLY_MODE: false, API_BASE_URL: service, SHARE_WEB_ORIGIN: service },
    canUseHostedService: () => true,
  };
});
vi.mock('../../lib/hosted-session-binding', () => ({
  getHostedSessionBinding: () => session.binding,
  bindHostedSession: () => undefined,
  clearHostedSessionBinding: () => undefined,
}));
// The journal is covered by its own suites; the import's rows land in real SQLite.
vi.mock('../../usecase/sync-helpers', async () => {
  const { getDb: db } = await import('../../lib/db');
  return {
    withAtomicSyncTransaction: (_projectId: string, work: (tx: unknown, sync: () => Promise<void>) => Promise<unknown>) =>
      db().transaction(tx => work(tx, async () => undefined)),
  };
});

import { syncShareInbox } from './share-inbox';
import { shareLinkUrl } from './share-link-api';
import { republishShareLink, useShareLinkStore } from './share-link-store';
import { readShareDocument, shareDocumentSha256 } from './share-source';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

/** Synthetic accounts on the local disposable service, verified through Mailpit. */
async function createAccount(name: string) {
  const email = `share-client-${randomUUID()}@example.test`;
  const password = randomUUID();
  const post = async (endpoint: string, body: unknown) => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${origin}/api/auth/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin! }, body: JSON.stringify(body),
      });
      if (response.status === 429 && attempt < 2) {
        const retry = Number(response.headers.get('retry-after') ?? 60);
        await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(60, Number.isFinite(retry) ? retry : 60)) * 1000 + 250));
        continue;
      }
      expect(response.status, endpoint).toBe(200);
      return response;
    }
  };
  await post('sign-up/email', { email, password, name });
  await post('email-otp/send-verification-otp', { email, type: 'email-verification' });
  const mail = process.env.HOSTED_TEST_MAIL_ORIGIN ?? 'http://localhost:8025';
  const listing = await (await fetch(`${mail}/api/v1/messages`)).json() as { messages: { ID: string; To: { Address: string }[] }[] };
  const message = listing.messages.find(item => item.To.some(to => to.Address === email))!;
  const text = (await (await fetch(`${mail}/api/v1/message/${message.ID}`)).json() as { Text: string }).Text;
  await post('email-otp/verify-email', { email, otp: text.match(/\b\d{6}\b/)![0] });
  const response = await post('sign-in/email', { email, password });
  const user = (await response.json() as { user: { id: string } }).user;
  return { accountSubject: user.id, token: response.headers.get('set-auth-token')! };
}

async function reader(token: string, path: string, init: { method?: string; body?: unknown } = {}) {
  return fetch(`${origin}/api/share/v1/links/${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

describe.skipIf(!origin)('share links against the Hosted service', () => {
  it('publishes the entity copy, imports readers\' comments, reports resolutions and stops sharing', async () => {
    const fixture = await createWorkspaceProjectionFixture();
    cleanups.push(fixture.close);
    const author = await createAccount('合成作者');
    const audience = await createAccount('合成读者');
    session.binding = author;
    cleanups.push(async () => { session.binding = null; useShareLinkStore.setState({ account: null, shares: [], loadedAt: null }); });
    const target = { projectId: INPUT.projectId, entityKind: 'node' as const, entityId: 'chapter' };
    // Editors give every block an id; comments anchor to them.
    await getDb().update(NodeContentTable).set({ contentJson: JSON.stringify({ type: 'doc', content: [
      { type: 'paragraph', attrs: { id: 'block-1' }, content: [{ type: 'text', text: 'Synthetic body.' }] },
      { type: 'paragraph', attrs: { id: 'block-2' }, content: [
        { type: 'text', text: 'Element', marks: [{ type: 'entityLink', attrs: { targetKind: 'element', targetId: 'element' } }] },
        { type: 'text', text: ' waits.' },
      ] },
    ] }) }).where(eq(NodeContentTable.nodeId, 'chapter'));
    await getDb().update(BookElementTable).set({ summary: '合成摘要' }).where(eq(BookElementTable.id, 'element'));

    const link = await useShareLinkStore.getState().publish(target);
    expect(link).toMatchObject({ ...target, title: 'Chapter', revision: 1, commentsEnabled: true });
    expect(shareLinkUrl(link.token)).toBe(`${origin}/s/${link.token}`);
    // The client and the service hash the same normalized copy (before PostgreSQL
    // stores it as jsonb), so an unchanged body is never re-sent.
    expect(await shareDocumentSha256((await readShareDocument(target))!)).toBe(link.documentSha256);
    const page = await (await reader(audience.token, link.token)).json() as { document: ShareDocument; viewer: { name: string } };
    // Linked entities travel with name and summary only; the folio carries the chapter's place and storyline.
    expect(page.document.blocks[1]!.runs[0]).toEqual({ text: 'Element', entity: 'e1' });
    expect(page.document.entities).toEqual({ e1: { kind: 'element', name: 'Element', summary: '合成摘要' } });
    expect(page.document.folio).toEqual({ chapter: 1, line: { name: 'main', color: '#778899' }, words: expect.any(Number) });
    expect(await republishShareLink(link)).toBe(false);
    expect(page.viewer.name).toBe('合成读者');

    const anchor = anchorForSelection(page.document.blocks, { index: 0, offset: 0 }, { index: 0, offset: 9 })!;
    const posted = await Promise.all(['节奏很好', '这句想删'].map(async body => {
      const response = await reader(audience.token, `${link.token}/comments`, { body: { body, anchor } });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    }));
    expect(await syncShareInbox()).toEqual({ imported: 2, withdrawn: 0, statusesReported: 0 });
    const [row] = await getDb().select().from(CommentTable).where(eq(CommentTable.id, posted[0]!.id));
    expect(row).toMatchObject({ projectId: INPUT.projectId, targetKind: 'node', targetId: 'chapter', authorKind: 'external', authorName: '合成读者' });
    expect(JSON.parse(row!.anchorJson).textAnchor.text).toBe('Synthetic');
    expect(await syncShareInbox()).toEqual({ imported: 0, withdrawn: 0, statusesReported: 0 });

    await getDb().update(CommentTable).set({ status: 'resolved' }).where(eq(CommentTable.id, posted[0]!.id));
    await reader(audience.token, `${link.token}/comments/${posted[1]!.id}`, { method: 'DELETE' });
    expect(await syncShareInbox()).toEqual({ imported: 0, withdrawn: 1, statusesReported: 1 });
    expect(await getDb().select().from(CommentTable).where(eq(CommentTable.id, posted[1]!.id))).toEqual([]);
    const after = await (await reader(audience.token, link.token)).json() as { comments: { id: string; status: string }[] };
    expect(after.comments).toEqual([expect.objectContaining({ id: posted[0]!.id, status: 'resolved' })]);

    await getDb().update(CommentTable).set({ status: 'open' }).where(eq(CommentTable.id, posted[0]!.id));
    await syncShareInbox();
    expect((await (await reader(audience.token, link.token)).json() as { comments: { status: string }[] }).comments[0]!.status).toBe('open');

    await useShareLinkStore.getState().stop(link.id);
    expect((await reader(audience.token, link.token)).status).toBe(404);
    expect(await syncShareInbox()).toBeNull();
  }, 240_000);
});
