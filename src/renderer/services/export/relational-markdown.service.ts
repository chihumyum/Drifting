import JSZip from 'jszip';

import { extractTextFromCommentBody } from '../../domain/comment';
import type { EntityKind } from '../../domain/entity-kinds';
import { GENERIC_ASSOCIATION_SYSTEM_KEY } from '../../domain/entity-relation-type';
import { proseDocId, type ProseEntityType } from '../../lib/yjs-doc-id';
import { platform } from '../../platform';
import { hydrateProseJson } from '../../lib/agent/prose-hydrate-client';
import { flushAllOpenYjsDocuments } from '../yjs-local-durability.service';
import {
  readLocalRelationalMarkdownSource,
  type LocalExportBook,
  type LocalExportLibraryItem,
  type LocalRelationalMarkdownSource,
} from './relational-markdown.local-source';

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

interface ExportBook extends LocalExportBook {
  prefix: string;
}

function safeSegment(value: string): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|#\]]/g, '-')
    .replaceAll('[', '-')
    .replace(/\.\.+/g, '-')
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

async function readLocalProseJson(
  entityType: ProseEntityType,
  entityId: string,
  fallbackContentJson: string,
  source: LocalRelationalMarkdownSource,
): Promise<string> {
  const docId = proseDocId(entityType, entityId);
  const state = source.proseByDocId.get(docId);
  if (!state || (!state.snapshot && state.updates.length === 0)) {
    // A document that has never been opened has no Yjs state yet. Its
    // contentJson projection is still the editor's canonical seed.
    return fallbackContentJson || '{}';
  }
  // Once any Yjs state exists, it is authoritative even when it represents an
  // intentionally empty document. Corruption rejects the export instead of
  // silently falling back to a stale contentJson projection.
  return hydrateProseJson(state.snapshot, state.updates);
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

export interface RelationalMarkdownArchive {
  filename: string;
  documentCount: number;
  bytes: Uint8Array;
}

export interface RelationalMarkdownExportDependencies {
  flushOpenYjsDocuments: () => Promise<void>;
  readLocalSource: () => Promise<LocalRelationalMarkdownSource>;
  saveArchive: (
    filename: string,
    bytes: Uint8Array,
  ) => Promise<
    | { ok: true }
    | { ok: false; canceled: true }
    | { ok: false; canceled: false; error: string }
  >;
  now: () => Date;
}

const defaultExportDependencies: RelationalMarkdownExportDependencies = {
  flushOpenYjsDocuments: flushAllOpenYjsDocuments,
  readLocalSource: readLocalRelationalMarkdownSource,
  saveArchive: (filename, bytes) => platform.archive.save(filename, bytes),
  now: () => new Date(),
};

/** Build the portable Markdown ZIP from an already-consistent local capture. */
export async function buildRelationalMarkdownArchive(
  source: LocalRelationalMarkdownSource,
  now = new Date(),
): Promise<RelationalMarkdownArchive> {
  const books: ExportBook[] = source.books
    .map((book) => ({
      ...book,
      // Keep the full stable ID in archive paths. Human titles are not unique,
      // and truncating IDs can make JSZip silently replace an earlier entry.
      prefix: `books/${safeSegment(book.project.name)}-${safeSegment(book.project.id)}`,
    }))
    .sort(
      (left, right) =>
        left.project.name.localeCompare(right.project.name) ||
        left.project.id.localeCompare(right.project.id),
    );

  const documents = new Map<string, ExportDocument>();
  const add = (document: ExportDocument) => documents.set(document.key, document);
  const idSuffix = (id: string) => safeSegment(id);
  const proseFallbacks = new Map<string, string>();
  const libraryItems = new Map<string, LocalExportLibraryItem>();

  for (const book of books) {
    const { project, graph, prefix } = book;
    const nodes = graph.nodes.filter((item) => !item.deletedAt);
    const elements = graph.elements.filter((item) => !item.deletedAt);
    const categories = graph.elementCategories.filter((item) => !item.deletedAt);
    const storylines = graph.storylines.filter((item) => !item.deletedAt);
    const comments = graph.comments;
    const library = graph.libraryItems;
    const nodeContentById = new Map(
      graph.nodeContents.map((item) => [item.nodeId, item.contentJson ?? '{}']),
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
        title: `Note ${idSuffix(comment.id)}`,
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
          asset_id:
            item.kind === 'image' || item.kind === 'pdf' ? (item.assetId ?? undefined) : undefined,
          external_url: item.kind === 'url' ? (item.externalUrl ?? undefined) : undefined,
          updated_at: item.updatedAt,
        },
        body: '',
      });
      libraryItems.set(key('library_item', item.id), item);
    }
  }

  // Paths must exist before prose is rendered so entityLink marks can become
  // portable Obsidian-style wiki links.
  const proseDocuments = [...documents.values()].filter((document) =>
    ['node', 'element', 'category', 'storyline'].includes(document.kind),
  );
  await mapWithConcurrency(proseDocuments, 6, async (document) => {
    const entityType = document.kind as ProseEntityType;
    const contentJson = await readLocalProseJson(
      entityType,
      document.id,
      proseFallbacks.get(document.key) ?? '{}',
      source,
    );
    const markdown = proseToMarkdown(contentJson, documents);
    document.body = [document.body, markdown].filter(Boolean).join('\n\n');
  });

  for (const document of documents.values()) {
    if (document.kind !== 'library_item') continue;
    const item = libraryItems.get(document.key);
    if (!item) continue;
    document.body = [
      noteToMarkdown(item.bodyJson, documents),
      noteToMarkdown(item.notesJson, documents),
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  const relations = new Map<string, Relation[]>();
  for (const book of books) {
    const graphRelations = book.graph.entityRelations;
    const relationTypesById = new Map(
      book.graph.entityRelationTypes.map((relationType) => [relationType.id, relationType]),
    );
    const comments = book.graph.comments;
    const storylineLinks = book.graph.nodeStorylineLinks;
    const elements = book.graph.elements.filter((item) => !item.deletedAt);

    for (const relation of graphRelations) {
      const from = key(relation.fromKind as ExportKind, relation.fromId);
      const to = key(relation.toKind as ExportKind, relation.toId);
      const relationType = relationTypesById.get(relation.relationTypeId);
      if (!relationType) {
        throw new Error(`关系「${relation.id}」引用了不存在的关系类型`);
      }
      const label =
        relationType.systemKey === GENERIC_ASSOCIATION_SYSTEM_KEY
          ? '关联'
          : relationType.name;
      addRelation(relations, from, to, label);
      addRelation(relations, to, from, `反向：${label}`);
    }
    for (const comment of comments) {
      if (!comment.targetKind || !comment.targetId) continue;
      const from = key('comment', comment.id);
      const to = key(comment.targetKind as ExportKind, comment.targetId);
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
    '# Drifting Markdown 导出\n\n这是本机书库所有项目的关系型 Markdown 导出，面向阅读与迁移。图片和 PDF 二进制文件不包含在内，也不能重新导入 Drifting。`[[路径|标题]]` 表示实体链接；每个文件末尾的“关系”同时包含正向与反向引用。\n',
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

  const bytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return {
    bytes,
    filename: `drifting-all-books-markdown-${now.toISOString().slice(0, 10)}.zip`,
    documentCount: documents.size,
  };
}

/** Flush open editors, capture local SQLite/Yjs state, then ask the OS where to save. */
export async function exportAllProjectsAsRelationalMarkdown(
  overrides: Partial<RelationalMarkdownExportDependencies> = {},
): Promise<{
  filename: string;
  documentCount: number;
  canceled: boolean;
}> {
  const dependencies = { ...defaultExportDependencies, ...overrides };
  // Open editor Y.Docs can be newer than their SQLite snapshot. Flush only
  // local durability; export must never trigger hosted entity or Yjs traffic.
  await dependencies.flushOpenYjsDocuments();
  const source = await dependencies.readLocalSource();
  const archive = await buildRelationalMarkdownArchive(source, dependencies.now());
  const saved = await dependencies.saveArchive(archive.filename, archive.bytes);
  if (!saved.ok && !saved.canceled) throw new Error(saved.error);
  return {
    filename: archive.filename,
    documentCount: archive.documentCount,
    canceled: !saved.ok,
  };
}
