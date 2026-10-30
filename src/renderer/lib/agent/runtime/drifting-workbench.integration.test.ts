import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../../../lib/db';
import { createDatabaseClient } from '../../../lib/db';
import type { LibraryItem } from '../../../domain/library-item';
import type { MaterialFolder } from '../../../domain/material-folder';
import { AgentConversationTable, BookNodeTable, ProjectTable } from '../../../schema/drizzle';
import { createBookActRepository } from '../../../sqlite-repo/book-act-repo';
import { createLibraryItemSqliteRepository } from '../../../sqlite-repo/library-item-repo';
import { createBookNodeSqliteRepository } from '../../../sqlite-repo/node-repo';
import { createTimelineMarkerRepository } from '../../../sqlite-repo/timeline-marker-repo';
import { createMaterialFolderRepository } from '../../../sqlite-repo/material-folder-repo';
import { invalidateSqliteReducerStateCache } from '../../../sync/reducer/sqlite-materializer';
import { libraryMutationPayload } from '../../../usecase/library-item-payload';
import { withAtomicSyncTransaction } from '../../../usecase/sync-helpers';
import { useAgentEditStore } from '../../../store/agent-edit-store';
import { useDataStore } from '../../../store/data-store';
import { useProjectStore } from '../../../store/project-store';
import { setAgentEditModeOverride } from '../agent-edit-mode';
import type { AgentToolContext } from '../tool-handlers';
import { ProductFileBackedSqliteGateway } from './acceptance/p3-file-backed-sqlite';
import { createTestAgentAuthoredJournal } from './agent-authored-journal.test-support';
import {
  createDriftingAgentProductComposition,
  type DriftingAgentProductComposition,
} from './drifting-product-composition';
import { getDriftingWriteStrategy } from './drifting-write-strategies';
import type {
  DriftingDomainReadToolName,
  DriftingDomainWriteToolName,
} from './drifting-workspace-tool-contract';
import type {
  AgentModelDriver,
  AgentRuntimeContext,
  AgentToolExecutionRequest,
  AgentToolExecutionResult,
} from './types';

const databaseSlot = vi.hoisted(() => ({ current: null as unknown }));
const secureStorage = vi.hoisted(() => new Map<string, string>());

vi.mock('../../../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/db')>();
  return {
    ...actual,
    getDb: () => {
      if (!databaseSlot.current) throw new Error('Workbench test database is not installed');
      return databaseSlot.current as ReturnType<typeof actual.getDb>;
    },
  };
});

vi.mock('../../../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform')>();
  return {
    ...actual,
    platform: {
      ...actual.platform,
      app: { ...actual.platform.app, getInstallationIdentity: async () => `install-${'b'.repeat(64)}` },
      keychain: {
        get: async (key: string) => secureStorage.get(key) ?? null,
        has: async (key: string) => secureStorage.has(key),
        set: async (key: string, value: string) => {
          secureStorage.set(key, value);
          return true;
        },
        delete: async (key: string) => secureStorage.delete(key),
      },
    },
  };
});

vi.mock('../../../lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/config')>();
  return {
    ...actual,
    APP_CONFIG: { ...actual.APP_CONFIG, LOCAL_ONLY_MODE: false },
    canUseNetwork: () => false,
  };
});

const PROJECT_ID = 'workbench-project';
const USER_ID = 'workbench-user';
const CONVERSATION_ID = 'workbench-conversation';
const SESSION_ID = 'workbench-session';
const AT = '2026-10-30T00:00:00.000Z';
const NOTE_ID = 'note-lighthouse';
const FOLDER_ID = 'folder-people';

const NOTE_BODY = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { id: 'b-heading', level: 2 }, content: [{ type: 'text', text: '灯塔' }] },
    { type: 'paragraph', attrs: { id: 'b-p1' }, content: [{ type: 'text', text: '灯塔停用于 1937 年。' }] },
    {
      type: 'taskList',
      attrs: { id: 'b-tasks' },
      content: [
        {
          type: 'taskItem',
          attrs: { id: 'b-t1', checked: false, todoId: null },
          content: [{ type: 'paragraph', attrs: { id: 'b-t1p' }, content: [{ type: 'text', text: '查潮汐表' }] }],
        },
      ],
    },
    { type: 'paragraph', attrs: { id: 'b-p2' }, content: [{ type: 'text', text: '守塔人姓周。' }] },
  ],
};

const initialDataState = useDataStore.getState();
const initialProjectState = useProjectStore.getState();

const unusedDriver: AgentModelDriver = {
  id: 'workbench-unused-driver',
  stream() {
    throw new Error('The workbench integration invokes the tool runtime directly');
  },
};

describe('Agent workbench writes', () => {
  let fixture: WorkbenchFixture;

  beforeEach(async () => {
    secureStorage.clear();
    setAgentEditModeOverride(null);
    useAgentEditStore.getState().clearAll();
    fixture = await WorkbenchFixture.create();
  });

  afterEach(async () => {
    useDataStore.setState(initialDataState, true);
    useProjectStore.setState(initialProjectState, true);
    await fixture.close();
  });

  it('lists folders and reads a note as round-trippable Markdown', async () => {
    const listed = await fixture.read('list-1', 'list_materials', {});
    expect(listed).toMatchObject({ ok: true });
    expect(JSON.stringify(listed)).toContain('人物');
    const read = await fixture.read('read-1', 'read_material', { material: '灯塔笔记' });
    expect(JSON.stringify(read)).toContain('- [ ] 查潮汐表');
  });

  it('creates, renames and moves folders, files materials and rejects each write exactly', async () => {
    expect(await fixture.write('folder-1', 'create_material_folder', { name: '原型', parent: '人物' })).toMatchObject({
      ok: true,
    });
    const created = (await fixture.folders()).find((folder) => folder.name === '原型');
    expect(created?.parentFolderId).toBe(FOLDER_ID);
    expect(useDataStore.getState().materialFolders.some((folder) => folder.name === '原型')).toBe(true);

    expect(
      await fixture.write('move-1', 'update_material', {
        material: '灯塔笔记',
        title: '灯塔调研',
        folder: '人物/原型',
        description: '第三章的背景资料',
      }),
    ).toMatchObject({ ok: true });
    const moved = await fixture.item(NOTE_ID);
    expect(moved).toMatchObject({ title: '灯塔调研', folderId: created!.id });
    expect(moved?.notesJson).toContain('第三章的背景资料');

    expect(await fixture.write('rename-1', 'update_material_folder', { folder: '人物/原型', name: '人物原型', parent: '' })).toMatchObject({
      ok: true,
    });
    expect((await fixture.folders()).find((folder) => folder.id === created!.id)).toMatchObject({
      name: '人物原型',
      parentFolderId: null,
    });

    await fixture.revert('rename-1');
    expect((await fixture.folders()).find((folder) => folder.id === created!.id)).toMatchObject({
      name: '原型',
      parentFolderId: FOLDER_ID,
    });
    await fixture.revert('move-1');
    expect(await fixture.item(NOTE_ID)).toMatchObject({ title: '灯塔笔记', folderId: null, notesJson: null });
    await fixture.revert('folder-1');
    expect((await fixture.folders()).map((folder) => folder.id)).toEqual([FOLDER_ID]);
  });

  it('refuses moving a folder into its own subtree and reports a no-op without a write', async () => {
    await fixture.write('folder-2', 'create_material_folder', { name: '子', parent: '人物' });
    const loop = await fixture.write('loop-1', 'update_material_folder', { folder: '人物', parent: '人物/子' });
    expect(loop).toMatchObject({ ok: false });
    const noop = await fixture.write('noop-1', 'update_material', { material: '灯塔笔记', title: '灯塔笔记' });
    expect(noop).toMatchObject({ ok: true, data: { noop: true } });
  });

  it('deletes a folder without deleting what it holds, and restores it on reject', async () => {
    await fixture.write('file-1', 'update_material', { material: '灯塔笔记', folder: '人物' });
    const deleted = await fixture.write('delete-1', 'delete_material_folder', { folder: '人物' }, 'author_approved');
    expect(deleted, JSON.stringify(deleted)).toMatchObject({ ok: true });
    expect(await fixture.folders()).toEqual([]);
    expect(await fixture.item(NOTE_ID)).toMatchObject({ folderId: null });
    await fixture.revert('delete-1');
    // Sync never revives a purged id: the folder returns under a new one.
    const [restored] = await fixture.folders();
    expect(restored).toMatchObject({ name: '人物', parentFolderId: null });
    expect(restored!.id).not.toBe(FOLDER_ID);
    expect(await fixture.item(NOTE_ID)).toMatchObject({ folderId: restored!.id });
  });

  it('creates a note from Markdown and removes it on reject while it is untouched', async () => {
    const result = await fixture.write('note-1', 'create_material_note', {
      title: '潮汐',
      folder: '人物',
      body: '## 潮汐\n\n| 日期 | 潮位 |\n| --- | --- |\n| 3 日 | 高 |\n\n- [ ] 核对 1937 年记录',
    });
    expect(result).toMatchObject({ ok: true });
    const note = (await fixture.items()).find((item) => item.title === '潮汐');
    expect(note).toMatchObject({ kind: 'text', folderId: FOLDER_ID });
    const read = await fixture.read('note-read', 'read_material', { material: '潮汐' });
    expect(JSON.stringify(read)).toContain('| 3 日 | 高 |');
    await fixture.revert('note-1');
    expect((await fixture.items()).some((item) => item.title === '潮汐')).toBe(false);
  });

  it('revises only the touched note blocks and rejects back to the exact document', async () => {
    const before = await fixture.read('before', 'read_material', { material: '灯塔笔记' });
    expect(
      await fixture.write('revise-1', 'revise_material_note', {
        material: '灯塔笔记',
        changes: [{ currentText: '1937', revisedText: '1938' }],
      }),
    ).toMatchObject({ ok: true });
    const body = JSON.parse((await fixture.item(NOTE_ID))!.bodyJson ?? '{}') as typeof NOTE_BODY;
    expect(body.content.map((block) => block.attrs.id)).toEqual(['b-heading', 'b-p1', 'b-tasks', 'b-p2']);
    expect(JSON.stringify(body.content[1])).toContain('1938');
    expect(JSON.stringify(await fixture.read('after', 'read_material', { material: '灯塔笔记' }))).toContain('1938');

    await fixture.revert('revise-1');
    const restored = await fixture.read('restored', 'read_material', { material: '灯塔笔记' });
    expect(materialBody(restored)).toBe(materialBody(before));
  });

  it('replaces a whole note body', async () => {
    expect(
      await fixture.write('replace-1', 'replace_material_note_body', {
        material: '灯塔笔记',
        body: '> [!note]\n> 全部重写\n\n```\ncode\n```',
      }),
    ).toMatchObject({ ok: true });
    const read = await fixture.read('replaced', 'read_material', { material: '灯塔笔记' });
    expect(materialBody(read)).toBe('> [!note]\n> 全部重写\n\n```\ncode\n```');
  });
});

describe('Agent book structure writes', () => {
  let fixture: WorkbenchFixture;

  beforeEach(async () => {
    secureStorage.clear();
    fixture = await WorkbenchFixture.create();
  });

  afterEach(async () => {
    useDataStore.setState(initialDataState, true);
    useProjectStore.setState(initialProjectState, true);
    await fixture.close();
  });

  it('splits the book into acts, moves boundaries and rejects them exactly', async () => {
    expect(await fixture.write('act-1', 'create_act', { firstChapter: '第二章' })).toMatchObject({ ok: true });
    const [act] = await fixture.acts();
    expect(act).toMatchObject({ name: '第一幕', startOrder: 2.5 });
    const structure = JSON.stringify(await fixture.read('structure-1', 'read_book_structure', {}));
    expect(structure).toContain('"beforeFirstAct":["第一章"]');
    expect(structure).toContain('"chapters":["第二章","第三章"]');
    expect(JSON.stringify(await fixture.read('chapters-1', 'list_chapters', {}))).toContain('第一幕');

    expect(await fixture.write('act-2', 'update_act', { act: '第一幕', name: '起', firstChapter: '第三章' })).toMatchObject({
      ok: true,
    });
    expect((await fixture.acts())[0]).toMatchObject({ name: '起', startOrder: 7.5 });
    await fixture.revert('act-2');
    expect((await fixture.acts())[0]).toMatchObject({ id: act!.id, name: '第一幕', startOrder: 2.5 });

    expect(await fixture.write('act-3', 'delete_act', { act: '第一幕' }, 'author_approved')).toMatchObject({ ok: true });
    expect(await fixture.acts()).toEqual([]);
    await fixture.revert('act-3');
    const [restored] = await fixture.acts();
    expect(restored).toMatchObject({ name: '第一幕', startOrder: 2.5 });
    expect(restored!.id).not.toBe(act!.id);
  });

  it('reorders chapters inside the act of their neighbor', async () => {
    await fixture.write('act-4', 'create_act', { name: '下半', firstChapter: '第三章' });
    expect(await fixture.write('move-1', 'move_chapter', { chapter: '第一章', after: '第二章' })).toMatchObject({ ok: true });
    // After 第二章 but before the act boundary at 7.5, so it stays out of 下半.
    expect(await fixture.order('chapter-one')).toBe(6.25);
    expect(await fixture.write('move-2', 'move_chapter', { chapter: '第二章', act: '下半' })).toMatchObject({ ok: true });
    expect(await fixture.order('chapter-two')).toBe(15);
    expect(await fixture.write('move-3', 'move_chapter', { chapter: '第一章', before: '第三章' })).toMatchObject({ ok: true });
    expect(await fixture.order('chapter-one')).toBe(8.75);
    await fixture.revert('move-3');
    expect(await fixture.order('chapter-one')).toBe(6.25);
    const noop = await fixture.write('move-4', 'move_chapter', { chapter: '第一章', after: '第二章', before: '第三章' });
    expect(noop).toMatchObject({ ok: false });
  });

  it('places chapters and markers on the narrative timeline', async () => {
    expect(
      await fixture.write('marker-1', 'create_timeline_marker', { label: '1937 年冬', before: '第二章' }),
    ).toMatchObject({ ok: true });
    expect((await fixture.markers())[0]).toMatchObject({ label: '1937 年冬', narrativeOrder: 5 });
    expect(
      await fixture.write('place-1', 'set_timeline_position', { item: '第三章', after: '刻度:1937 年冬' }),
    ).toMatchObject({ ok: true });
    expect(await fixture.narrative('chapter-three')).toBe(7.5);
    expect(await fixture.write('place-2', 'set_timeline_position', { item: '第一章', after: '第二章' })).toMatchObject({
      ok: true,
    });
    expect(await fixture.narrative('chapter-one')).toBe(15);
    const timeline = JSON.stringify(await fixture.read('timeline-1', 'read_book_structure', {}));
    expect(timeline.indexOf('1937 年冬')).toBeLessThan(timeline.indexOf('"name":"第三章","position"'));

    expect(await fixture.write('place-3', 'set_timeline_position', { item: '第三章', remove: true })).toMatchObject({
      ok: true,
    });
    expect(await fixture.narrative('chapter-three')).toBeNull();
    await fixture.revert('place-3');
    expect(await fixture.narrative('chapter-three')).toBe(7.5);

    expect(
      await fixture.write('marker-2', 'update_timeline_marker', { marker: '1937 年冬', label: '1938 年春', after: '第二章' }),
    ).toMatchObject({ ok: true });
    expect((await fixture.markers())[0]).toMatchObject({ label: '1938 年春', narrativeOrder: 12.5 });
    expect(
      await fixture.write('marker-3', 'delete_timeline_marker', { marker: '1938 年春' }, 'author_approved'),
    ).toMatchObject({ ok: true });
    expect(await fixture.markers()).toEqual([]);
    await fixture.revert('marker-3');
    expect((await fixture.markers())[0]).toMatchObject({ label: '1938 年春', narrativeOrder: 12.5 });
  });
});

function materialBody(result: AgentToolExecutionResult): string {
  const text = JSON.stringify(result);
  const match = /"body":"((?:[^"\\]|\\.)*)"/u.exec(text);
  return match ? (JSON.parse(`"${match[1]}"`) as string) : '';
}

class WorkbenchFixture {
  readonly composition: DriftingAgentProductComposition;
  readonly context: AgentToolContext;
  readonly authoredJournal = createTestAgentAuthoredJournal('workbench');
  private tick = 0;
  private closed = false;

  private constructor(
    readonly directory: string,
    readonly gateway: ProductFileBackedSqliteGateway,
    readonly database: DbClient,
  ) {
    this.context = { projectId: PROJECT_ID, write: {} as AgentToolContext['write'] };
    this.composition = createDriftingAgentProductComposition({
      driver: unusedDriver,
      database,
      getContext: () => this.context,
      authoredJournal: this.authoredJournal,
    });
  }

  static async create(): Promise<WorkbenchFixture> {
    invalidateSqliteReducerStateCache();
    const directory = await mkdtemp(path.join(tmpdir(), 'drifting-workbench-'));
    const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
    const database = createDatabaseClient(gateway);
    databaseSlot.current = database;
    try {
      await gateway.open('drifting.db');
      await seed(database);
      await hydrateStores(database);
      const fixture = new WorkbenchFixture(directory, gateway, database);
      await fixture.composition.repositories.runtime.createSession({
        id: SESSION_ID,
        projectId: PROJECT_ID,
        routeKind: 'chat',
        conversationId: CONVERSATION_ID,
        goalRunId: null,
        chapterId: null,
        provider: 'test',
        model: 'test',
        providerEpoch: 0,
        status: 'running',
        createdAt: AT,
        updatedAt: AT,
        endedAt: null,
      });
      return fixture;
    } catch (error) {
      databaseSlot.current = null;
      await gateway.close();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async write(
    callId: string,
    name: DriftingDomainWriteToolName,
    arguments_: Record<string, unknown>,
    authorization: 'automatic' | 'author_approved' = 'automatic',
  ): Promise<AgentToolExecutionResult> {
    const request = await this.request(callId, name, 'write', arguments_);
    request.authorization = {
      kind: authorization,
      requestId: authorization === 'author_approved' ? `permission:${callId}` : null,
      argumentsHash: `sha256:${createHash('sha256').update(JSON.stringify(sortJson(arguments_))).digest('hex')}`,
    };
    return this.composition.tools.execute(request);
  }

  async read(
    callId: string,
    name: DriftingDomainReadToolName,
    arguments_: Record<string, unknown>,
  ): Promise<AgentToolExecutionResult> {
    return this.composition.workspaceTools.execute(await this.request(callId, name, 'read', arguments_));
  }

  async revert(callId: string): Promise<void> {
    const effect = await this.composition.repositories.writeEffects.getEffect(
      `agent-write:${this.idempotencyKey(callId)}`,
    );
    if (!effect) throw new Error(`Missing effect for ${callId}`);
    const strategy = getDriftingWriteStrategy(effect.toolName, {
      freshness: this.composition.repositories.freshness,
      elementPatchDb: this.database,
      authoredJournal: this.authoredJournal,
    });
    if (!strategy) throw new Error(`Missing strategy for ${effect.toolName}`);
    await strategy.applyInverse(effect, this.context, new AbortController().signal);
  }

  acts() {
    return createBookActRepository(PROJECT_ID, this.database).findAll();
  }

  markers() {
    return createTimelineMarkerRepository(PROJECT_ID, this.database).findAll();
  }

  async order(nodeId: string): Promise<number | null> {
    return (await createBookNodeSqliteRepository(PROJECT_ID, this.database).findById(nodeId))?.bookOrder ?? null;
  }

  async narrative(nodeId: string): Promise<number | null> {
    return (await createBookNodeSqliteRepository(PROJECT_ID, this.database).findById(nodeId))?.narrativeOrder ?? null;
  }

  folders(): Promise<MaterialFolder[]> {
    return createMaterialFolderRepository(PROJECT_ID, this.database).findAll();
  }

  items(): Promise<LibraryItem[]> {
    return createLibraryItemSqliteRepository(PROJECT_ID, this.database).findAll();
  }

  item(id: string): Promise<LibraryItem | null> {
    return createLibraryItemSqliteRepository(PROJECT_ID, this.database).findById(id);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (databaseSlot.current === this.database) databaseSlot.current = null;
    await this.gateway.close();
    await rm(this.directory, { recursive: true, force: true });
  }

  private async request(
    callId: string,
    name: DriftingDomainReadToolName | DriftingDomainWriteToolName,
    access: 'read' | 'write',
    arguments_: Record<string, unknown>,
  ): Promise<AgentToolExecutionRequest> {
    const turnId = `turn:${callId}`;
    const at = new Date(Date.parse(AT) + ++this.tick).toISOString();
    const persistence = this.composition.repositories.runtime;
    await persistence.createTurn({
      id: turnId,
      sessionId: SESSION_ID,
      ordinal: this.tick,
      status: 'running',
      promptMessageId: null,
      acceptedAt: at,
      startedAt: at,
      endedAt: null,
      errorCode: null,
      errorMessage: null,
      updatedAt: at,
    });
    const request: AgentToolExecutionRequest = {
      sessionId: SESSION_ID,
      turnId,
      callId,
      idempotencyKey: this.idempotencyKey(callId),
      name,
      arguments: arguments_,
      access,
      context: runtimeContext(),
      control: {
        requestUserInput: async () => {
          throw new Error('No interactive prompt is expected in the workbench harness');
        },
      },
      signal: new AbortController().signal,
    };
    await persistence.createToolCall({
      id: `agent-tool:${SESSION_ID}:${turnId}:${callId}`,
      sessionId: SESSION_ID,
      turnId,
      callId,
      name,
      access,
      status: 'running',
      idempotencyKey: request.idempotencyKey,
      arguments: arguments_,
      result: null,
      errorCode: null,
      createdAt: at,
      startedAt: at,
      completedAt: null,
    });
    return request;
  }

  private idempotencyKey(callId: string): string {
    return `${SESSION_ID}:turn:${callId}:${callId}`;
  }
}

async function seed(database: DbClient): Promise<void> {
  await database.insert(ProjectTable).values({
    id: PROJECT_ID,
    userId: USER_ID,
    name: 'Workbench Book',
    summary: '',
    kvJson: '[]',
    storylineTemplateKvJson: '[]',
    createdAt: AT,
    updatedAt: AT,
  });
  await database.insert(BookNodeTable).values(CHAPTERS.map(([id, title, order, narrative]) => chapter(id, title, order, narrative)));
  await database.insert(AgentConversationTable).values({
    id: CONVERSATION_ID,
    projectId: PROJECT_ID,
    title: 'Workbench acceptance',
    sdkSessionId: null,
    runtimeSessionId: null,
    mode: 'byok',
    messagesJson: '[]',
    deletedAt: null,
    createdAt: AT,
    updatedAt: AT,
  });
  // Through the authored journal, as the material panel creates them, so the
  // sync lifecycle knows both rows before the Agent changes them.
  await withAtomicSyncTransaction(PROJECT_ID, async (tx, sync) => {
    const folder = {
      id: FOLDER_ID,
      projectId: PROJECT_ID,
      name: '人物',
      parentFolderId: null,
      createdAt: AT,
      updatedAt: AT,
    };
    await createMaterialFolderRepository(PROJECT_ID, tx).create(folder);
    await sync('materialFolder', 'create', FOLDER_ID, PROJECT_ID, {
      id: FOLDER_ID,
      name: folder.name,
      parentFolderId: null,
      createdAt: AT,
      updatedAt: AT,
    });
    const note = await createLibraryItemSqliteRepository(PROJECT_ID, tx).create({
      id: NOTE_ID,
      projectId: PROJECT_ID,
      kind: 'text',
      title: '灯塔笔记',
      notesJson: null,
      provenanceJson: null,
      orderKey: 0,
      folderId: null,
      taskTodos: true,
      assetId: null,
      externalUrl: null,
      previewImageUrl: null,
      bodyJson: JSON.stringify(NOTE_BODY),
      createdAt: AT,
      updatedAt: AT,
    });
    await sync('libraryItem', 'create', NOTE_ID, PROJECT_ID, libraryMutationPayload(note));
  });
}

const CHAPTERS: ReadonlyArray<[string, string, number, number | null]> = [
  ['chapter-one', '第一章', 0, null],
  ['chapter-two', '第二章', 5, 10],
  ['chapter-three', '第三章', 10, null],
];

function chapter(id: string, title: string, bookOrder: number, narrativeOrder: number | null = null) {
  return {
    id,
    projectId: PROJECT_ID,
    title,
    summary: '',
    bookOrder,
    narrativeOrder,
    wordCount: 0,
    writingStatus: 'draft' as const,
    kind: 'chapter' as const,
    driftGroupId: null,
    deletedAt: null,
    createdAt: AT,
    updatedAt: AT,
    positionX: 0,
    positionY: 0,
  };
}

async function hydrateStores(database: DbClient): Promise<void> {
  useProjectStore.setState({
    ...initialProjectState,
    currentProject: {
      id: PROJECT_ID,
      userId: USER_ID,
      name: 'Workbench Book',
      summary: '',
      kvJson: '[]',
      storylineTemplateKvJson: '[]',
      createdAt: AT,
      updatedAt: AT,
    },
    projects: [],
  });
  useDataStore.setState({
    ...initialDataState,
    bookNodes: CHAPTERS.map(([id, title, order, narrative]) => chapter(id, title, order, narrative)).map(
      ({ positionX, positionY, ...value }) => ({ ...value, position: { x: positionX, y: positionY } }),
    ),
    storylines: [],
    bookElements: [],
    bookElementCategories: [],
    comments: [],
    entityRelations: [],
    libraryItems: await createLibraryItemSqliteRepository(PROJECT_ID, database).findAll(),
    materialFolders: await createMaterialFolderRepository(PROJECT_ID, database).findAll(),
  });
}

function runtimeContext(): AgentRuntimeContext {
  return { route: { kind: 'chat', projectId: PROJECT_ID, conversationId: CONVERSATION_ID } };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
