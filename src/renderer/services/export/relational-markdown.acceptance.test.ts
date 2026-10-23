import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { marked } from 'marked';
import { readFileSync } from 'node:fs';

import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';

import { createYjsProseSeedState } from '../../lib/agent/runtime/yjs-prose-command';
import { proseDocId } from '../../lib/yjs-doc-id';
import type { LocalRelationalMarkdownSource } from './relational-markdown.local-source';
import {
  buildRelationalMarkdownArchive,
  buildRelationalMarkdownEntries,
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
          assets: [],
          acts: [],
          driftGroups: [],
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


function projectedDocument(result: Awaited<ReturnType<typeof buildRelationalMarkdownEntries>>, kind: string, id: string) {
  const document = result.documents.find(item => item.key === `${kind}:${id}`)!;
  return { ...document, text: result.entries.find(entry => entry.path === document.path)!.text };
}

describe('automatic read-only Markdown projection', () => {
  it('merges readable documents and keeps canonical source versions in the manifest mapping', async () => {
    const source = await sourceFixture();
    const before = await buildRelationalMarkdownEntries(source, true);
    const body = projectedDocument(before, 'node', SNAPSHOT_NODE_ID);
    expect(body.path).toBe('正文/001 -Snapshot -Chapter-.md');
    expect(body.text).toMatch(/^Snapshot Yjs truth$/mu);
    expect(body.text).not.toContain('drifting_source_version:');
    expect(body.sourceVersion).toBe(`sha256:${createHash('sha256').update('Snapshot Yjs truth').digest('hex')}`);
    expect(before.entries.find(entry => entry.path === '导出说明.md')!.text).toContain('NO reverse sync');
    expect(before.documents.some(item => item.key.includes('node-deleted-0004'))).toBe(false);
    expect(projectedDocument(before, 'node', UPDATE_NODE_ID).text).toMatch(/^Update-log Yjs truth$/mu);
    for (const entry of before.entries) expect(entry.text).not.toMatch(/\^(?:comment-)?drift-|#\^/u);
    const node = source.books[0]!.graph.nodes.find(node => node.id === SNAPSHOT_NODE_ID)!;
    node.title = 'Renamed readable chapter';
    node.bookOrder = 100;
    const after = await buildRelationalMarkdownEntries(source, true);
    const renamed = projectedDocument(after, 'node', SNAPSHOT_NODE_ID);
    expect(renamed.path).toBe('正文/003 Renamed readable chapter.md');
    expect(renamed.sourceVersion).toBe(body.sourceVersion);
    expect(after.entries.some(entry => entry.path === body.path)).toBe(false);
    expect(renamed.text).toMatch(/^Snapshot Yjs truth$/mu);
  });

  it('renders passage citations directly to the readable entity files', async () => {
    const source = await sourceFixture();
    source.books[0]!.graph.elements[0]!.contentJson = proseJson('See the update', [{ type: 'entityLink', attrs: {
      targetKind: 'node', targetId: UPDATE_NODE_ID, targetBlockId: 'block-update-log-yjs-truth', targetEndBlockId: null,
    } }]);
    const result = await buildRelationalMarkdownEntries(source, true);
    const body = projectedDocument(result, 'element', ELEMENT_ID);
    expect(body.path).toBe('要素/People/Hero.md');
    expect(body.text).toContain('[See the update](../../%E6%AD%A3%E6%96%87/002%20Update%20chapter.md)');
    expect(result.entries.some(entry => /(?:index|prose)\.md$/u.test(entry.path))).toBe(false);
  });
});

describe('Obsidian projection interoperability', () => {
  it('resolves every relative link to a whole file independently of the vault nesting', async () => {
    const source = await sourceFixture();
    const graph = source.books[0]!.graph;
    const target = graph.nodes.find(node => node.id === UPDATE_NODE_ID)!;
    target.title = 'Target [quoted]';
    source.proseByDocId.delete(proseDocId('node', UPDATE_NODE_ID));
    graph.nodeContents.find(content => content.nodeId === UPDATE_NODE_ID)!.contentJson = JSON.stringify({ type: 'doc', content: [
      { type: 'paragraph', attrs: { id: 'opening-段' }, content: [{ type: 'text', text: 'Opening paragraph.' }] },
      { type: 'blockquote', attrs: { id: 'quote-block' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted paragraph.' }] }] },
      { type: 'heading', attrs: { id: 'closing-block', level: 2 }, content: [{ type: 'text', text: 'Closing heading' }] },
      { type: 'paragraph', attrs: { id: 'empty-block' }, content: [] },
    ] });
    const element = graph.elements[0]!;
    element.aliasesJson = JSON.stringify(['Hero, the first', '别名[甲]', 'a: b']);
    element.contentJson = proseJson('Read the range', [{ type: 'entityLink', attrs: {
      targetKind: 'node', targetId: target.id, targetBlockId: 'opening-段', targetEndBlockId: 'closing-block',
    } }]);
    // A synthetic one-pixel image and a small PDF, both generated for this test.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG2kAAAAASUVORK5CYII=', 'base64');
    const pdfParts = ['%PDF-1.4\n'];
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>'];
    const offsets = [0];
    objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdfParts.join(''))); pdfParts.push(`${index + 1} 0 obj\n${object}\nendobj\n`); });
    const xref = Buffer.byteLength(pdfParts.join(''));
    pdfParts.push(`xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const pdf = Buffer.from(pdfParts.join(''));
    for (const [id, kind, mime, bytes] of [['image-asset', 'image', 'image/png', png], ['pdf-asset', 'pdf', 'application/pdf', pdf]] as const) {
      graph.assets.push({ id, projectId: PROJECT_ID, kind, sourceMime: mime, sourceSizeBytes: bytes.length,
        sourceSha256: createHash('sha256').update(bytes).digest('hex'), width: kind === 'image' ? 1 : null,
        height: kind === 'image' ? 1 : null, createdAt: NOW });
    }
    element.portraitAssetId = 'image-asset';
    graph.libraryItems.push({ ...graph.libraryItems[0]!, id: 'pdf-note', kind: 'pdf', title: 'Synthetic PDF', assetId: 'pdf-asset' });
    const projection = await buildRelationalMarkdownEntries(source, true);
    const paths = new Set([...projection.entries, ...projection.assets].map(entry => entry.path));
    const byPath = new Map(projection.entries.map(entry => [entry.path, entry.text]));
    for (const prefix of ['', 'Other Vault/Nested Project/']) {
      for (const entry of projection.entries) {
        marked.walkTokens(marked.lexer(entry.text), token => {
          if (token.type !== 'link' && token.type !== 'image') return;
          if (/^[a-z]+:/iu.test(token.href)) return;
          const [destination, fragment] = token.href.split('#');
          const resolved = posix.normalize(posix.join(posix.dirname(prefix + entry.path), decodeURIComponent(destination!)));
          expect(resolved.startsWith(prefix)).toBe(true);
          const targetPath = resolved.slice(prefix.length);
          expect(paths.has(targetPath), `${entry.path} -> ${token.href}`).toBe(true);
          expect(fragment, `${entry.path} -> ${token.href}`).toBeUndefined();
        });
      }
    }
    const bodyPath = projectedDocument(projection, 'element', ELEMENT_ID).path;
    const body = byPath.get(bodyPath)!;
    expect(body).not.toContain('末段');
    expect(body).not.toContain('drifting:');
    expect(byPath.get(bodyPath)).toContain('aliases: ["Hero","Hero, the first","别名[甲]","a: b"]');
    expect(projectedDocument(projection, 'node', UPDATE_NODE_ID).path).toMatch(/^正文\/002 /u);
    for (const entry of projection.entries) expect(entry.text).not.toMatch(/\^(?:comment-)?drift-|#\^|&#8203;/u);
    const citation = /\[Read the range\]\(([^)]+)\)/u.exec(body)![1]!;
    const json = JSON.parse(graph.nodeContents.find(content => content.nodeId === target.id)!.contentJson!);
    json.content.unshift({ type: 'paragraph', attrs: { id: 'inserted' }, content: [{ type: 'text', text: 'Inserted before citation.' }] });
    graph.nodeContents.find(content => content.nodeId === target.id)!.contentJson = JSON.stringify(json);
    const updated = await buildRelationalMarkdownEntries(source, true);
    expect(updated.entries.find(entry => entry.path === bodyPath)!.text).toContain(`[Read the range](${citation})`);
    expect(projection.assets).toHaveLength(2);
    if (process.env.DRIFTING_OBSIDIAN_FIXTURE === '1') {
      const directory = '.local-data/obsidian-projection/generated';
      for (const entry of projection.entries) {
        mkdirSync(posix.dirname(`${directory}/${entry.path}`), { recursive: true });
        writeFileSync(`${directory}/${entry.path}`, entry.text);
      }
      const binaries = new Map([['image-asset', png], ['pdf-asset', pdf]]);
      for (const asset of projection.assets) {
        mkdirSync(posix.dirname(`${directory}/${asset.path}`), { recursive: true });
        writeFileSync(`${directory}/${asset.path}`, binaries.get(asset.assetId)!);
      }
      mkdirSync(`${directory}/.drifting`, { recursive: true });
      writeFileSync(`${directory}/.drifting/manifest.json`, JSON.stringify({ schemaVersion: 3, projectId: PROJECT_ID,
        documents: projection.documents,
        generatedAt: NOW, readOnly: true, reverseSync: false,
        files: Object.fromEntries([...projection.entries.map(entry => [entry.path, createHash('sha256').update(entry.text).digest('hex')]),
          ...projection.assets.map(asset => [asset.path, asset.sourceSha256])]) }));
    }
  });

  it('plans JPEG previews for unsupported images and rejects missing referenced asset metadata', async () => {
    const source = await sourceFixture();
    const graph = source.books[0]!.graph;
    graph.elements[0]!.portraitAssetId = 'missing';
    await expect(buildRelationalMarkdownEntries(source, true)).rejects.toThrow('Missing project asset metadata');
    graph.assets.push({ id: 'missing', projectId: PROJECT_ID, kind: 'image', sourceMime: 'image/heic',
      sourceSizeBytes: 1, sourceSha256: 'a'.repeat(64), width: 1, height: 1, createdAt: NOW });
    const result = await buildRelationalMarkdownEntries(source, true);
    expect(result.assets.map(asset => asset.path)).toEqual(['资料/附件/Hero.heic', '资料/附件/Hero(预览).jpg']);
    expect(projectedDocument(result, 'element', ELEMENT_ID).text).toContain('%28%E9%A2%84%E8%A7%88%29.jpg)');
    // Manual ZIP remains a readable migration archive, without binary copies.
    expect((await buildRelationalMarkdownEntries(source)).assets).toEqual([]);
  });
});

describe('reader-facing Markdown tree', () => {
  it('preserves act boundaries, drift folders and scene/beat/note levels in complete named documents', async () => {
    const source = await sourceFixture();
    const graph = source.books[0]!.graph;
    graph.acts.push({ id: 'act-a', projectId: PROJECT_ID, name: '第一幕', startOrder: 2, color: null, driftNodeId: null, createdAt: NOW, updatedAt: NOW });
    graph.driftGroups.push({ id: 'g1', projectId: PROJECT_ID, name: '片段', parentGroupId: null, color: null, sortOrder: null, createdAt: NOW, updatedAt: NOW },
      { id: 'g2', projectId: PROJECT_ID, name: '未采用', parentGroupId: 'g1', color: null, sortOrder: null, createdAt: NOW, updatedAt: NOW });
    graph.nodes.push({ ...graph.nodes[0]!, id: 'drift-a', kind: 'drift', title: '窗边的片段', writingStatus: 'drifting', bookOrder: null, driftGroupId: 'g2' });
    graph.nodeContents.push({ ...graph.nodeContents[0]!, nodeId: 'drift-a', contentJson: JSON.stringify({ type: 'doc', content: [1, 2, 3].map(level => ({
      type: 'heading', attrs: { id: `level-${level}`, level }, content: [{ type: 'text', text: ['场景', '节拍', '笔记'][level - 1] }],
    })) }) });
    const result = await buildRelationalMarkdownEntries(source, true);
    expect(projectedDocument(result, 'node', SNAPSHOT_NODE_ID).path).toMatch(/^正文\/001 /u);
    expect(projectedDocument(result, 'node', UPDATE_NODE_ID).path).toBe('正文/01 第一幕/002 Update chapter.md');
    const drift = projectedDocument(result, 'node', 'drift-a');
    expect(drift.path).toBe('构想/片段/未采用/窗边的片段.md');
    expect(drift.text).toContain('## 场景');
    expect(drift.text).toContain('### 节拍');
    expect(drift.text).toContain('#### 笔记');
    const contents = result.entries.find(entry => entry.path === '正文/目录.md')!.text;
    expect(contents.indexOf('Snapshot')).toBeLessThan(contents.indexOf('第一幕'));
    expect(contents.indexOf('第一幕')).toBeLessThan(contents.indexOf('Update chapter'));
    expect(contents).toContain('草稿');
    const comments = result.entries.find(entry => entry.path === '注释与待办.md')!;
    expect(comments.text).toContain('Local comment');
    expect(comments.text).toContain('### 注释：Local comment\n\n状态：未完成');
    expect(projectedDocument(result, 'node', SNAPSHOT_NODE_ID).text).toContain('注释');
    expect(result.documents.find(document => document.key === 'comment:comment-0001')!.path).toBe(comments.path);
    expect(result.entries.filter(entry => entry.path.startsWith('注释'))).toHaveLength(1);
  });

  it('handles duplicate names, Unicode normalization, reserved names and file-directory collisions without leaking full IDs', async () => {
    const source = await sourceFixture();
    const graph = source.books[0]!.graph;
    graph.elements.push({ ...graph.elements[0]!, id: 'element-0002', name: 'hero' },
      { ...graph.elements[0]!, id: 'element-0003', name: 'CON' },
      { ...graph.elements[0]!, id: 'element-0004', name: '😀'.repeat(120) });
    // Category notes reserve their own filename before user-named elements are allocated.
    graph.elements.push({ ...graph.elements[0]!, id: 'element-0005', name: '分类说明' });
    const result = await buildRelationalMarkdownEntries(source, true);
    const normalized = result.entries.map(entry => entry.path.normalize('NFKC').toLowerCase());
    expect(new Set(normalized).size).toBe(normalized.length);
    expect(projectedDocument(result, 'element', 'element-0002').path).toMatch(/hero \([0-9a-f]{8}\)\.md$/u);
    expect(projectedDocument(result, 'element', 'element-0003').path).toContain('/_CON.md');
    expect(projectedDocument(result, 'element', 'element-0005').path).toMatch(/分类说明 \([0-9a-f]{8}\)\.md$/u);
    for (const entry of result.entries) {
      expect(entry.path).not.toContain('id-element-');
      expect(Buffer.byteLength(entry.path.split('/').slice(-1)[0]!)).toBeLessThanOrEqual(240);
      expect(entry.path).not.toMatch(/[\\:*?"<>|#^\x5b\x5d]/u);
    }
    const cyclic = await sourceFixture();
    cyclic.books[0]!.graph.driftGroups.push({ id: 'cycle', projectId: PROJECT_ID, name: 'Cycle', parentGroupId: 'cycle', color: null, sortOrder: null, createdAt: NOW, updatedAt: NOW });
    await expect(buildRelationalMarkdownEntries(cyclic, true)).rejects.toThrow('Cyclic drift group hierarchy');
  });
});
