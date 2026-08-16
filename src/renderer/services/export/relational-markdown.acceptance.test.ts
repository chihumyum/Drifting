import { readFileSync } from 'node:fs';

import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';

import { createYjsProseSeedState } from '../../lib/agent/runtime/yjs-prose-command';
import { proseDocId } from '../../lib/yjs-doc-id';
import type { LocalRelationalMarkdownSource } from './relational-markdown.local-source';
import {
  buildRelationalMarkdownArchive,
  exportAllProjectsAsRelationalMarkdown,
} from './relational-markdown.service';

const NOW = '2026-08-14T10:00:00.000Z';
const PROJECT_ID = 'project-local-0001';
const SNAPSHOT_NODE_ID = 'node-snapshot-0001';
const UPDATE_NODE_ID = 'node-update-0002';
const SEED_NODE_ID = 'node-seed-0003';
const ELEMENT_ID = 'element-0001';
const CATEGORY_ID = 'category-0001';
const STORYLINE_ID = 'storyline-0001';

function proseJson(text: string, marks?: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: `block-${text.toLowerCase().replace(/\W+/g, '-')}` },
        content: [{ type: 'text', text, ...(marks ? { marks } : {}) }],
      },
    ],
  });
}

async function sourceFixture(): Promise<LocalRelationalMarkdownSource> {
  const snapshot = await createYjsProseSeedState(proseJson('Snapshot Yjs truth'));
  const update = await createYjsProseSeedState(proseJson('Update-log Yjs truth'));
  const source = {
    books: [
      {
        project: {
          id: PROJECT_ID,
          userId: 'anonymous',
          name: '../Local [Book]',
          summary: 'Local project summary',
          kvJson: '[]',
          storylineTemplateKvJson: '[]',
          createdAt: NOW,
          updatedAt: NOW,
        },
        graph: {
          nodes: [
            {
              id: SNAPSHOT_NODE_ID,
              projectId: PROJECT_ID,
              title: '../Snapshot [Chapter]',
              summary: '',
              kind: 'chapter',
              writingStatus: 'draft',
              bookOrder: 1,
              narrativeOrder: null,
              wordCount: 0,
              wordCountBasisKind: null,
              wordCountBasisHash: null,
              wordCountBasisRevision: null,
              wordCountBasisServerSeq: null,
              driftGroupId: null,
              deletedAt: null,
              createdAt: NOW,
              updatedAt: NOW,
              positionX: 0,
              positionY: 0,
            },
            {
              id: UPDATE_NODE_ID,
              projectId: PROJECT_ID,
              title: 'Update chapter',
              summary: '',
              kind: 'chapter',
              writingStatus: 'draft',
              bookOrder: 2,
              narrativeOrder: null,
              wordCount: 0,
              wordCountBasisKind: null,
              wordCountBasisHash: null,
              wordCountBasisRevision: null,
              wordCountBasisServerSeq: null,
              driftGroupId: null,
              deletedAt: null,
              createdAt: NOW,
              updatedAt: NOW,
              positionX: 0,
              positionY: 0,
            },
            {
              id: SEED_NODE_ID,
              projectId: PROJECT_ID,
              title: 'Never-opened chapter',
              summary: '',
              kind: 'chapter',
              writingStatus: 'draft',
              bookOrder: 3,
              narrativeOrder: null,
              wordCount: 0,
              wordCountBasisKind: null,
              wordCountBasisHash: null,
              wordCountBasisRevision: null,
              wordCountBasisServerSeq: null,
              driftGroupId: null,
              deletedAt: null,
              createdAt: NOW,
              updatedAt: NOW,
              positionX: 0,
              positionY: 0,
            },
            {
              id: 'node-deleted-0004',
              projectId: PROJECT_ID,
              title: 'Deleted chapter must not export',
              summary: '',
              kind: 'chapter',
              writingStatus: 'draft',
              bookOrder: 4,
              narrativeOrder: null,
              wordCount: 0,
              wordCountBasisKind: null,
              wordCountBasisHash: null,
              wordCountBasisRevision: null,
              wordCountBasisServerSeq: null,
              driftGroupId: null,
              deletedAt: NOW,
              createdAt: NOW,
              updatedAt: NOW,
              positionX: 0,
              positionY: 0,
            },
          ],
          nodeContents: [
            {
              nodeId: SNAPSHOT_NODE_ID,
              contentJson: proseJson('Stale snapshot projection'),
              outlineJson: '[]',
              plotGridJson: '{}',
              createdAt: NOW,
              updatedAt: NOW,
            },
            {
              nodeId: UPDATE_NODE_ID,
              contentJson: proseJson('Stale update projection'),
              outlineJson: '[]',
              plotGridJson: '{}',
              createdAt: NOW,
              updatedAt: NOW,
            },
            {
              nodeId: SEED_NODE_ID,
              contentJson: proseJson('Seed-only fallback'),
              outlineJson: '[]',
              plotGridJson: '{}',
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
          elements: [
            {
              id: ELEMENT_ID,
              projectId: PROJECT_ID,
              categoryId: CATEGORY_ID,
              name: 'Hero',
              summary: '',
              contentJson: proseJson('See chapter', [
                {
                  type: 'entityLink',
                  attrs: { targetKind: 'node', targetId: SNAPSHOT_NODE_ID },
                },
              ]),
              kvJson: '[]',
              aliasesJson: '[]',
              groupName: null,
              portraitAssetId: null,
              deletedAt: null,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
          elementCategories: [
            {
              id: CATEGORY_ID,
              projectId: PROJECT_ID,
              name: 'People',
              contentJson: '{}',
              elementTemplateJson: '{}',
              elementTemplateKvJson: '[]',
              color: '#fff',
              layoutMode: 'auto',
              gridX: null,
              gridY: null,
              deletedAt: null,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
          storylines: [
            {
              id: STORYLINE_ID,
              projectId: PROJECT_ID,
              name: 'Main line',
              color: '#fff',
              summary: '',
              orderKey: 1,
              contentJson: '{}',
              kvJson: '[]',
              nodeContentTemplateJson: '{}',
              deletedAt: null,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
          comments: [
            {
              id: 'comment-0001',
              projectId: PROJECT_ID,
              kind: 'note',
              targetKind: 'node',
              targetId: SNAPSHOT_NODE_ID,
              targetBlockId: null,
              anchorJson: '{}',
              authorKind: 'user',
              authorId: null,
              authorName: null,
              bodyJson: proseJson('Local comment'),
              status: 'open',
              priority: null,
              source: 'manual',
              metadataJson: null,
              targetBlockIdsJson: '[]',
              resolvedAt: null,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
          libraryItems: [
            {
              id: 'library-0001',
              projectId: PROJECT_ID,
              title: 'Local note',
              kind: 'text',
              assetId: null,
              externalUrl: null,
              bodyJson: proseJson('Library body'),
              notesJson: proseJson('Library annotation'),
              previewImageUrl: null,
              orderKey: 0,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
          entityRelations: [
            {
              id: 'relation-0001',
              projectId: PROJECT_ID,
              fromKind: 'node',
              fromId: SNAPSHOT_NODE_ID,
              toKind: 'element',
              toId: ELEMENT_ID,
              relationTypeId: 'relation-type-main-character',
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
          entityRelationTypes: [
            {
              id: 'relation-type-main-character',
              projectId: PROJECT_ID,
              name: '主角',
              normalizedName: '主角',
              description: '',
              orientation: 'directed',
              systemKey: null,
              locked: false,
              sourceRole: '角色',
              targetRole: '对象',
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
          nodeStorylineLinks: [
            {
              nodeId: SNAPSHOT_NODE_ID,
              storylineId: STORYLINE_ID,
              isPrimary: true,
            },
          ],
        },
      },
    ],
    proseByDocId: new Map([
      [
        proseDocId('node', SNAPSHOT_NODE_ID),
        { snapshot, updates: [] },
      ],
      [
        proseDocId('node', UPDATE_NODE_ID),
        { snapshot: null, updates: [update] },
      ],
    ]),
  };
  return source as unknown as LocalRelationalMarkdownSource;
}

async function zipText(zip: JSZip, suffix: string): Promise<string> {
  const file = Object.values(zip.files).find((entry) => !entry.dir && entry.name.endsWith(suffix));
  if (!file) throw new Error(`ZIP entry not found: ${suffix}`);
  return file.async('string');
}

describe('local relational Markdown export acceptance', () => {
  it('uses persisted Yjs state before seed fallback and preserves safe relational links', async () => {
    const source = await sourceFixture();
    const archive = await buildRelationalMarkdownArchive(source, new Date(NOW));
    const zip = await JSZip.loadAsync(archive.bytes);
    const names = Object.keys(zip.files).filter((name) => !zip.files[name]?.dir);

    expect(archive.filename).toBe('drifting-all-books-markdown-2026-08-14.zip');
    expect(archive.documentCount).toBe(9);
    expect(names.every((name) => !name.startsWith('/') && !name.includes('..'))).toBe(true);
    expect(names.some((name) => name.includes('Local -Book--project-'))).toBe(true);
    expect(names.some((name) => name.includes('Deleted chapter must not export'))).toBe(false);

    const snapshotChapter = await zipText(zip, `-${SNAPSHOT_NODE_ID}.md`);
    const updateChapter = await zipText(zip, `-${UPDATE_NODE_ID}.md`);
    const seedChapter = await zipText(zip, `-${SEED_NODE_ID}.md`);
    const element = await zipText(zip, `-${ELEMENT_ID}.md`);
    const library = await zipText(zip, '-library-0001.md');
    const readme = await zipText(zip, 'README.md');

    expect(snapshotChapter).toContain('Snapshot Yjs truth');
    expect(snapshotChapter).not.toContain('Stale snapshot projection');
    expect(updateChapter).toContain('Update-log Yjs truth');
    expect(updateChapter).not.toContain('Stale update projection');
    expect(seedChapter).toContain('Seed-only fallback');
    expect(snapshotChapter).toContain('主角: [[');
    expect(snapshotChapter).toContain('所属故事线: [[');
    expect(snapshotChapter).toContain('被此注释引用: [[');
    expect(element).toContain('[[books/');
    expect(element).toContain('|See chapter]]');
    expect(element).toContain('反向：主角: [[');
    expect(element).toContain('所属分类: [[');
    expect(library).not.toContain('/Users/example/');
    expect(library).not.toContain('file://');
    expect(readme).toContain('本机书库所有项目');
    expect(readme).toContain('图片和 PDF 二进制文件不包含在内');
    expect(readme).not.toContain('账户下所有书');
  });

  it('flushes live local Yjs before reading SQLite and reports picker cancellation without retrying', async () => {
    const source = await sourceFixture();
    const calls: string[] = [];
    const saveArchive = vi.fn(async () => {
      calls.push('save');
      return { ok: false as const, canceled: true as const };
    });

    const result = await exportAllProjectsAsRelationalMarkdown({
      flushOpenYjsDocuments: async () => {
        calls.push('flush');
      },
      readLocalSource: async () => {
        calls.push('read');
        return source;
      },
      saveArchive,
      now: () => new Date(NOW),
    });

    expect(calls).toEqual(['flush', 'read', 'save']);
    expect(result).toMatchObject({ canceled: true, documentCount: 9 });
    expect(saveArchive).toHaveBeenCalledTimes(1);
  });

  it('keeps the export path free of hosted graph, mutation flush, and remote Yjs calls', () => {
    const service = readFileSync(new URL('./relational-markdown.service.ts', import.meta.url), 'utf8');
    const source = readFileSync(
      new URL('./relational-markdown.local-source.ts', import.meta.url),
      'utf8',
    );
    const implementation = `${service}\n${source}`;

    expect(implementation).not.toMatch(/apiClient|forceFlushEntitySync|forceSyncAllDocuments/);
    expect(implementation).not.toMatch(/\/api\/(?:projects|sync)/);
    expect(implementation).toContain('flushAllOpenYjsDocuments');
    expect(implementation).toContain('yjsSnapshots');
    expect(implementation).toContain('yjsUpdates');
    expect(implementation).toContain('getDb().transaction');
  });

  it('keeps local export reachable without mounting a retired cloud activity surface', () => {
    const panel = readFileSync(
      new URL('../../features/settings/panels/ControlSettingsPanels.tsx', import.meta.url),
      'utf8',
    );

    expect(panel).toContain('exportAllProjectsAsRelationalMarkdown');
    expect(panel).toContain("title={t('settings.sync.local_data')}");
    expect(panel).not.toContain('SyncSummaryRow');
    expect(panel).not.toContain('SyncActivityPanel');
    expect(panel).not.toContain('syncDebugToasts');
  });
});
