import JSZip from 'jszip';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';

import { extractTextFromCommentBody } from '../../domain/comment';
import type { EntityKind } from '../../domain/entity-kinds';
import { apiClient } from '../../lib/axios-config';
import { proseDocId, type ProseEntityType } from '../../lib/yjs-doc-id';
import {
  forceFlush as forceFlushEntitySync,
  getPendingCount,
  type ProjectGraphPayload,
} from '../entity-sync.service';
import {
  base64ToUint8,
  forceSyncAllDocuments,
} from '../yjs-sync.service';

type ExportKind = EntityKind | 'project';

interface ExportDocument {
  key: string;
  kind: ExportKind;
  id: string;
  title: string;
  path: string;
  metadata: Record<string, string | number | null | undefined>;
  body: string;
}

interface Relation {
  targetKey: string;
  label: string;
}

interface RemoteProject {
  id: string;
  name: string;
  summary: string;
  updatedAt: string;
}

interface GraphNode {
  id: string;
  title: string;
  summary: string;
  kind: 'chapter' | 'drift';
  writingStatus: string;
  updatedAt: string;
  deletedAt?: string | null;
}

interface GraphElement {
  id: string;
  categoryId: string | null;
  name: string;
  summary: string;
  contentJson: string;
  aliasesJson: string;
  groupName: string | null;
  updatedAt: string;
  deletedAt?: string | null;
}

interface GraphCategory {
  id: string;
  name: string;
  contentJson: string;
  updatedAt: string;
  deletedAt?: string | null;
}

interface GraphStoryline {
  id: string;
  name: string;
  summary: string;
  contentJson: string;
  updatedAt: string;
  deletedAt?: string | null;
}

interface GraphComment {
  id: string;
  kind: string;
  targetKind: EntityKind | null;
  targetId: string | null;
  bodyJson: string;
  status: string;
  source: string;
  updatedAt: string;
}

interface GraphLibraryItem {
  id: string;
  title: string;
  kind: string;
  source: string;
  uri: string;
  bodyJson: string | null;
  notesJson: string | null;
  updatedAt: string;
  deletedAt?: string | null;
}

interface GraphRelation {
  fromKind: EntityKind;
  fromId: string;
  toKind: EntityKind;
  toId: string;
  kind: string | null;
}

interface GraphStorylineLink {
  nodeId: string;
  storylineId: string;
}

interface GraphNodeContent {
  nodeId: string;
  contentJson: string | null;
}

interface ExportBook {
  project: RemoteProject;
  graph: ProjectGraphPayload;
  prefix: string;
}

function safeSegment(value: string): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|#\]]/g, '-')
    .replaceAll('[', '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return (cleaned || 'Untitled').slice(0, 80);
}

function key(kind: ExportKind, id: string): string {
  return `${kind}:${id}`;
}

function yamlString(value: unknown): string {
  return JSON.stringify(value == null ? '' : String(value));
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function renderInline(node: Record<string, unknown>, paths: Map<string, ExportDocument>): string {
  const text = typeof node.text === 'string' ? node.text : '';
  const marks = Array.isArray(node.marks) ? node.marks : [];
  let rendered = text;
  for (const rawMark of marks) {
    if (!rawMark || typeof rawMark !== 'object') continue;
    const mark = rawMark as { type?: string; attrs?: Record<string, unknown> };
    if (mark.type === 'entityLink') {
      const targetKind = String(mark.attrs?.targetKind ?? '');
      const targetId = String(mark.attrs?.targetId ?? '');
      const target = paths.get(key(targetKind as ExportKind, targetId));
      if (target) rendered = `[[${target.path.replace(/\.md$/, '')}|${rendered}]]`;
    } else if (mark.type === 'bold') rendered = `**${rendered}**`;
    else if (mark.type === 'italic') rendered = `*${rendered}*`;
    else if (mark.type === 'strike') rendered = `~~${rendered}~~`;
    else if (mark.type === 'code') rendered = `\`${rendered}\``;
    else if (mark.type === 'link' && typeof mark.attrs?.href === 'string') {
      rendered = `[${rendered}](${mark.attrs.href})`;
    }
  }
  return rendered;
}

function proseToMarkdown(contentJson: string, paths: Map<string, ExportDocument>): string {
  const root = parseJson(contentJson);
  if (!root || typeof root !== 'object') return '';

  const render = (raw: unknown, depth = 0): string => {
    if (!raw || typeof raw !== 'object') return '';
    const node = raw as Record<string, unknown>;
    if (node.type === 'text') return renderInline(node, paths);
    const children = Array.isArray(node.content)
      ? node.content.map((child) => render(child, depth + 1)).join('')
      : '';
    switch (node.type) {
      case 'doc':
        return children;
      case 'paragraph':
        return `${children}\n\n`;
      case 'heading': {
        const level = Math.min(
          6,
          Math.max(1, Number((node.attrs as { level?: number })?.level ?? 2)),
        );
        return `${'#'.repeat(level)} ${children}\n\n`;
      }
      case 'blockquote':
        return `${children
          .trim()
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')}\n\n`;
      case 'bulletList':
      case 'orderedList':
        return `${children}\n`;
      case 'listItem':
        return `${'  '.repeat(Math.max(0, depth - 2))}- ${children.trim()}\n`;
      case 'hardBreak':
        return '  \n';
      case 'horizontalRule':
        return '\n---\n\n';
      case 'codeBlock':
        return `\n\`\`\`\n${children.trim()}\n\`\`\`\n\n`;
      default:
        return children;
    }
  };

  return render(root)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function noteToMarkdown(value: string | null, paths: Map<string, ExportDocument>): string {
  if (!value) return '';
  const parsed = parseJson(value);
  return parsed && typeof parsed === 'object' ? proseToMarkdown(value, paths) : value;
}

function decodeAliases(value: string | null | undefined): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : [];
}

async function fetchRemoteProseJson(
  entityType: ProseEntityType,
  entityId: string,
  fallbackContentJson: string,
): Promise<string> {
  const docId = proseDocId(entityType, entityId);
  const ydoc = new Y.Doc();
  let sinceSeq = 0;
  let applied = 0;

  try {
    for (let page = 0; page < 10_000; page += 1) {
      const response = await apiClient.get<{
        updates?: Array<{ serverSeq: number; data: string }>;
        hasMore?: boolean;
      }>('/api/sync/pull', {
        params: { docId, sinceSeq, limit: 2000 },
      });
      const updates = response.data.updates ?? [];
      if (updates.length === 0) break;

      const previousSeq = sinceSeq;
      for (const update of updates) {
        Y.applyUpdate(ydoc, base64ToUint8(update.data), 'export');
        sinceSeq = Math.max(sinceSeq, update.serverSeq);
        applied += 1;
      }
      if (sinceSeq <= previousSeq) {
        throw new Error(`Export pull made no cursor progress for ${docId}`);
      }
      if (response.data.hasMore !== true) break;
      if (page === 9_999) throw new Error(`Export pull exceeded page limit for ${docId}`);
    }

    if (applied === 0) return fallbackContentJson || '{}';
    return JSON.stringify(yDocToProsemirrorJSON(ydoc, 'default'));
  } finally {
    ydoc.destroy();
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await work(item);
    }
  });
  await Promise.all(workers);
}

function addRelation(
  relations: Map<string, Relation[]>,
  fromKey: string,
  toKey: string,
  label: string,
): void {
  const bucket = relations.get(fromKey) ?? [];
  if (!bucket.some((item) => item.targetKey === toKey && item.label === label)) {
    bucket.push({ targetKey: toKey, label });
    relations.set(fromKey, bucket);
  }
}

function renderDocument(
  document: ExportDocument,
  documents: Map<string, ExportDocument>,
  relations: Map<string, Relation[]>,
): string {
  const frontmatter = Object.entries({
    drifting_kind: document.kind,
    drifting_id: document.id,
    ...document.metadata,
  })
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}: ${yamlString(value)}`)
    .join('\n');

  const backlinks = (relations.get(document.key) ?? [])
    .map((relation) => {
      const target = documents.get(relation.targetKey);
      if (!target) return null;
      return `- ${relation.label}: [[${target.path.replace(/\.md$/, '')}|${target.title}]]`;
    })
    .filter((line): line is string => Boolean(line));

  return [
    '---',
    frontmatter,
    '---',
    '',
    `# ${document.title}`,
    '',
    document.body.trim(),
    backlinks.length ? '\n## 关系\n\n' + backlinks.join('\n') : '',
    '',
  ]
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n');
}

export async function exportAllProjectsAsRelationalMarkdown(): Promise<{
  filename: string;
  documentCount: number;
}> {
  // Make the server graph and Yjs log authoritative for the account export.
  // If either flush fails, abort rather than silently producing a stale archive.
  await Promise.all([forceFlushEntitySync(), forceSyncAllDocuments()]);
  const pendingMutations = getPendingCount();
  if (pendingMutations > 0) {
    throw new Error(`Cannot export while ${pendingMutations} local change(s) are still pending`);
  }

  const projectResponse = await apiClient.get<RemoteProject[]>('/api/projects');
  const projects = projectResponse.data;
  const books: ExportBook[] = [];
  await mapWithConcurrency(projects, 4, async (project) => {
    const response = await apiClient.get<ProjectGraphPayload>(`/api/projects/${project.id}/graph`);
    books.push({
      project,
      graph: response.data,
      prefix: `books/${safeSegment(project.name)}-${project.id.slice(0, 8)}`,
    });
  });
  books.sort((a, b) => a.project.name.localeCompare(b.project.name));

  const documents = new Map<string, ExportDocument>();
  const add = (document: ExportDocument) => documents.set(document.key, document);
  const idSuffix = (id: string) => id.slice(0, 8);
  const proseFallbacks = new Map<string, string>();
  const libraryItems = new Map<string, GraphLibraryItem>();

  for (const book of books) {
    const { project, graph, prefix } = book;
    const nodes = (graph.nodes as unknown as GraphNode[]).filter((item) => !item.deletedAt);
    const elements = (graph.elements as unknown as GraphElement[]).filter(
      (item) => !item.deletedAt,
    );
    const categories = (graph.elementCategories as unknown as GraphCategory[]).filter(
      (item) => !item.deletedAt,
    );
    const storylines = (graph.storylines as unknown as GraphStoryline[]).filter(
      (item) => !item.deletedAt,
    );
    const comments = graph.comments as unknown as GraphComment[];
    const library = (graph.libraryItems as unknown as GraphLibraryItem[]).filter(
      (item) => !item.deletedAt,
    );
    const nodeContentById = new Map(
      (graph.nodeContents as unknown as GraphNodeContent[]).map((item) => [
        item.nodeId,
        item.contentJson ?? '{}',
      ]),
    );

    add({
      key: key('project', project.id),
      kind: 'project',
      id: project.id,
      title: project.name,
      path: `${prefix}/index.md`,
      metadata: { updated_at: project.updatedAt },
      body: project.summary || '',
    });

    for (const node of nodes) {
      add({
        key: key('node', node.id),
        kind: 'node',
        id: node.id,
        title: node.title,
        path: `${prefix}/book/${node.kind === 'chapter' ? 'chapters' : 'drifts'}/${safeSegment(node.title)}-${idSuffix(node.id)}.md`,
        metadata: {
          node_kind: node.kind,
          writing_status: node.writingStatus,
          updated_at: node.updatedAt,
        },
        body: node.summary || '',
      });
      proseFallbacks.set(key('node', node.id), nodeContentById.get(node.id) ?? '{}');
    }
    for (const element of elements) {
      add({
        key: key('element', element.id),
        kind: 'element',
        id: element.id,
        title: element.name,
        path: `${prefix}/elements/${safeSegment(element.name)}-${idSuffix(element.id)}.md`,
        metadata: {
          aliases: decodeAliases(element.aliasesJson).join(', '),
          group: element.groupName,
          updated_at: element.updatedAt,
        },
        body: element.summary || '',
      });
      proseFallbacks.set(key('element', element.id), element.contentJson || '{}');
    }
    for (const category of categories) {
      add({
        key: key('category', category.id),
        kind: 'category',
        id: category.id,
        title: category.name,
        path: `${prefix}/elements/categories/${safeSegment(category.name)}-${idSuffix(category.id)}.md`,
        metadata: { updated_at: category.updatedAt },
        body: '',
      });
      proseFallbacks.set(key('category', category.id), category.contentJson || '{}');
    }
    for (const storyline of storylines) {
      add({
        key: key('storyline', storyline.id),
        kind: 'storyline',
        id: storyline.id,
        title: storyline.name,
        path: `${prefix}/storylines/${safeSegment(storyline.name)}-${idSuffix(storyline.id)}.md`,
        metadata: { updated_at: storyline.updatedAt },
        body: storyline.summary || '',
      });
      proseFallbacks.set(key('storyline', storyline.id), storyline.contentJson || '{}');
    }
    for (const comment of comments) {
      add({
        key: key('comment', comment.id),
        kind: 'comment',
        id: comment.id,
        title: `Note ${comment.id.slice(0, 8)}`,
        path: `${prefix}/notes/comments/note-${idSuffix(comment.id)}.md`,
        metadata: {
          note_kind: comment.kind,
          status: comment.status,
          source: comment.source,
          updated_at: comment.updatedAt,
        },
        body: extractTextFromCommentBody(comment.bodyJson),
      });
    }
    for (const item of library) {
      add({
        key: key('library_item', item.id),
        kind: 'library_item',
        id: item.id,
        title: item.title,
        path: `${prefix}/notes/library/${safeSegment(item.title)}-${idSuffix(item.id)}.md`,
        metadata: {
          item_kind: item.kind,
          source: item.source,
          uri: item.uri,
          updated_at: item.updatedAt,
        },
        body: '',
      });
      libraryItems.set(key('library_item', item.id), item);
    }
  }

  // Resolve every current server-side Yjs document after paths are known, so
  // inline entityLink marks can become portable Obsidian-style wiki links.
  const proseDocuments = [...documents.values()].filter((document) =>
    ['node', 'element', 'category', 'storyline'].includes(document.kind),
  );
  await mapWithConcurrency(proseDocuments, 6, async (document) => {
    const entityType = document.kind as ProseEntityType;
    const contentJson = await fetchRemoteProseJson(
      entityType,
      document.id,
      proseFallbacks.get(document.key) ?? '{}',
    );
    const markdown = proseToMarkdown(contentJson, documents);
    document.body = [document.body, markdown].filter(Boolean).join('\n\n');
  });

  for (const document of documents.values()) {
    if (document.kind === 'library_item') {
      const item = libraryItems.get(document.key);
      if (item) {
        document.body = [
          noteToMarkdown(item.bodyJson, documents),
          noteToMarkdown(item.notesJson, documents),
        ]
          .filter(Boolean)
          .join('\n\n');
      }
    }
  }

  const relations = new Map<string, Relation[]>();
  for (const book of books) {
    const graphRelations = book.graph.entityRelations as unknown as GraphRelation[];
    const comments = book.graph.comments as unknown as GraphComment[];
    const storylineLinks = book.graph.nodeStorylineLinks as unknown as GraphStorylineLink[];
    const elements = (book.graph.elements as unknown as GraphElement[]).filter(
      (item) => !item.deletedAt,
    );

    for (const relation of graphRelations) {
      const from = key(relation.fromKind, relation.fromId);
      const to = key(relation.toKind, relation.toId);
      const label = relation.kind || '关联';
      addRelation(relations, from, to, label);
      addRelation(relations, to, from, `反向：${label}`);
    }
    for (const comment of comments) {
      if (!comment.targetKind || !comment.targetId) continue;
      const from = key('comment', comment.id);
      const to = key(comment.targetKind, comment.targetId);
      addRelation(relations, from, to, '注释对象');
      addRelation(relations, to, from, '被此注释引用');
    }
    for (const link of storylineLinks) {
      const from = key('storyline', link.storylineId);
      const to = key('node', link.nodeId);
      addRelation(relations, from, to, '包含章节');
      addRelation(relations, to, from, '所属故事线');
    }
    for (const element of elements) {
      if (!element.categoryId) continue;
      const from = key('element', element.id);
      const to = key('category', element.categoryId);
      addRelation(relations, from, to, '所属分类');
      addRelation(relations, to, from, '包含元素');
    }

    const index = documents.get(key('project', book.project.id));
    if (index) {
      const links = [...documents.values()]
        .filter((document) => document !== index && document.path.startsWith(`${book.prefix}/`))
        .map((document) => `- [[${document.path.replace(/\.md$/, '')}|${document.title}]]`);
      index.body = [index.body, '## 内容索引', links.join('\n')].filter(Boolean).join('\n\n');
    }
  }

  const zip = new JSZip();
  for (const document of documents.values()) {
    zip.file(document.path, renderDocument(document, documents, relations));
  }
  zip.file(
    'README.md',
    '# Drifting Markdown 导出\n\n这是账户下所有书的关系型 Markdown 导出，面向阅读与迁移，不是可无损恢复应用状态的完整备份。`[[路径|标题]]` 表示实体链接；每个文件末尾的“关系”同时包含正向与反向引用。\n',
  );
  zip.file(
    'index.md',
    [
      '# Drifting 书库',
      '',
      ...books.map(
        (book) =>
          `- [[${documents.get(key('project', book.project.id))?.path.replace(/\.md$/, '')}|${book.project.name}]]`,
      ),
      '',
    ].join('\n'),
  );

  const blob = await zip.generateAsync({ type: 'blob' });
  const filename = `drifting-all-books-markdown-${new Date().toISOString().slice(0, 10)}.zip`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return { filename, documentCount: documents.size };
}
