import { deriveActSegments } from '../../domain/book-act';
import { extractTextFromCommentBody } from '../../domain/comment';
import { GENERIC_ASSOCIATION_SYSTEM_KEY } from '../../domain/entity-relation-type';
import { proseReadMarkdown, proseReadVersion } from '../../lib/agent/prose-read-view';
import { contentJsonBlockIds, createLocationResolver, type LocationEntity } from '../../lib/location-link';
import type { ProseEntityType } from '../../lib/yjs-doc-id';
import type { MarkdownProjectionAsset, MarkdownProjectionDocument } from '../../platform/contracts';
import { extForMime } from '../asset-store.service';
import { markdownShareSummary } from './markdown-share';
import { markdownLabel, obsidianProse, relativeMarkdownHref } from './obsidian-markdown';
import { readLocalProseJson } from './relational-markdown.prose';
import type { LocalRelationalMarkdownSource } from './relational-markdown.local-source';
import type { MarkdownZipEntry } from './markdown-zip';

const HOME = '开始阅读.md';
const CONTENTS = '正文/目录.md';
const COMMENTS = '注释与待办.md';
const STATUS: Record<string, string> = { draft: '草稿', finished: '已完成', discarded: '已搁置', drifting: '漂浮中', resting: '休眠', open: '未完成', resolved: '已解决', converted: '已转换' };
const byteLength = (value: string) => new TextEncoder().encode(value).length;
const key = (kind: string, id: string) => `${kind}:${id}`;

/** Filenames are readable on macOS/Windows and safe as Markdown destinations. */
export function readableFileStem(value: string): string {
  const normalized = value.normalize('NFKC').replace(/[<>:"/\\|?*#^%\x5b\x5d\p{Cc}\p{Cf}]/gu, '-')
    .replace(/\.{2,}/gu, '-').replace(/-{2,}/gu, '-').replace(/\s+/gu, ' ').replace(/^[.\s]+|[.\s]+$/gu, '');
  let result = '';
  for (const char of normalized || '未命名') { if (byteLength(result + char) > 120) break; result += char; }
  result = result.replace(/[. ]+$/gu, '') || '未命名';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(result)) result = `_${result}`;
  return result;
}

function shortId(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0').slice(0, 8);
}

class Paths {
  private used = new Set([HOME, CONTENTS, COMMENTS, '导出说明.md', '正文', '构想', '要素', '故事线', '资料', '资料/附件', '.drifting'].map(path => path.toLowerCase()));
  claim(parent: string, title: string, identity: string, extension = '.md'): string {
    const stem = readableFileStem(title);
    let suffix = '';
    for (let attempt = 0; ; attempt++) {
      const path = `${parent ? `${parent}/` : ''}${stem}${suffix}${extension}`;
      if (byteLength(path) > 1024) throw new Error('Markdown projection directory hierarchy is too deep');
      const normalized = path.normalize('NFKC').toLowerCase();
      if (!this.used.has(normalized)) { this.used.add(normalized); return path; }
      suffix = ` (${shortId(identity)}${attempt ? `-${attempt + 1}` : ''})`;
    }
  }
}

interface Document extends MarkdownProjectionDocument {
  kind: string;
  id: string;
  summary: string;
  json?: string;
  fallback?: string;
  aliases: string[];
  status?: string;
  sections: string[];
}

function parseAliases(value: string | null): string[] {
  try { const values: unknown = JSON.parse(value || '[]'); return Array.isArray(values) ? values.filter((item): item is string => typeof item === 'string') : []; }
  catch { return []; }
}

export async function buildReadableMarkdownProjection(source: LocalRelationalMarkdownSource, now: Date) {
  if (source.books.length !== 1) throw new Error('A projection must contain exactly one project');
  const { project, graph } = source.books[0]!;
  const paths = new Paths();
  const documents = new Map<string, Document>();
  const assets = new Map<string, MarkdownProjectionAsset>();
  const entries: MarkdownZipEntry[] = [];
  const locations: LocationEntity[] = [];
  const add = (kind: string, id: string, title: string, path: string, options: Partial<Document> = {}) => {
    const document: Document = { key: key(kind, id), kind, id, title: title.trim() || '未命名', path, anchor: null, sourceVersion: null, summary: '', aliases: [title], sections: [], ...options };
    documents.set(document.key, document);
    return document;
  };
  const compare = <T extends { id: string }>(a: T, b: T) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const nodes = graph.nodes.filter(node => !node.deletedAt);
  const chapters = nodes.filter(node => node.kind === 'chapter').sort((a, b) =>
    (a.bookOrder ?? Infinity) - (b.bookOrder ?? Infinity) || compare(a, b));
  const segments = deriveActSegments(graph.acts, chapters);
  const chapterFolders = new Map<string, string>();
  const actDocuments = new Map<string, Document>();
  for (const [index, segment] of segments.entries()) {
    const directory = paths.claim('正文', `${String(index + 1).padStart(Math.max(2, String(segments.length).length), '0')} ${segment.act.name}`, key('act', segment.act.id), '');
    const document = add('act', segment.act.id, segment.act.name,
      paths.claim(directory, '本幕', key('act', segment.act.id)));
    actDocuments.set(segment.act.id, document);
    for (const chapter of segment.chapters) chapterFolders.set(chapter.id, directory);
  }
  const groupPaths = new Map<string, string>();
  const groups = new Map(graph.driftGroups.map(group => [group.id, group]));
  const groupPath = (id: string, visiting = new Set<string>()): string => {
    if (groupPaths.has(id)) return groupPaths.get(id)!;
    const group = groups.get(id);
    if (!group) return '构想';
    if (visiting.has(id)) throw new Error('Cyclic drift group hierarchy in Markdown projection');
    visiting.add(id);
    const parent = group.parentGroupId ? groupPath(group.parentGroupId, visiting) : '构想';
    const path = paths.claim(parent, group.name, key('drift-group', id), '');
    groupPaths.set(id, path);
    visiting.delete(id);
    return path;
  };
  for (const group of [...groups.values()].sort(compare)) groupPath(group.id);
  const content = new Map(graph.nodeContents.map(item => [item.nodeId, item.contentJson ?? '{}']));
  const addProse = (kind: ProseEntityType, id: string, title: string, path: string, fallback: string, summary = '', aliases: string[] = []) => {
    const document = add(kind, id, title, path, { fallback, summary, aliases: [...new Set([title, ...aliases])] });
    locations.push({ kind, id, name: title, group: kind === 'node' ? (nodes.find(node => node.id === id)!.kind === 'chapter' ? 'chapters' : 'drifts') : kind === 'element' ? 'elements' : kind === 'category' ? 'categories' : 'storylines' });
    return document;
  };
  for (const [index, chapter] of chapters.entries()) {
    addProse('node', chapter.id, chapter.title,
      paths.claim(chapterFolders.get(chapter.id) ?? '正文', `${String(index + 1).padStart(Math.max(3, String(chapters.length).length), '0')} ${readableFileStem(chapter.title)}`, key('node', chapter.id)),
      content.get(chapter.id) ?? '{}', chapter.summary).status = STATUS[chapter.writingStatus] ?? chapter.writingStatus;
  }
  for (const node of nodes.filter(node => node.kind !== 'chapter').sort(compare)) {
    addProse('node', node.id, node.title, paths.claim(node.driftGroupId ? groupPath(node.driftGroupId) : '构想', node.title, key('node', node.id)),
      content.get(node.id) ?? '{}', node.summary).status = STATUS[node.writingStatus] ?? node.writingStatus;
  }
  const categoryPaths = new Map<string, string>();
  for (const category of graph.elementCategories.filter(item => !item.deletedAt).sort(compare)) {
    const directory = paths.claim('要素', category.name, key('category', category.id), '');
    categoryPaths.set(category.id, directory);
    addProse('category', category.id, category.name, paths.claim(directory, '分类说明', key('category', category.id)), category.contentJson ?? '{}');
  }
  for (const element of graph.elements.filter(item => !item.deletedAt).sort(compare)) {
    addProse('element', element.id, element.name, paths.claim(categoryPaths.get(element.categoryId ?? '') ?? '要素', element.name, key('element', element.id)),
      element.contentJson ?? '{}', element.summary, parseAliases(element.aliasesJson));
  }
  for (const storyline of graph.storylines.filter(item => !item.deletedAt).sort(compare)) {
    addProse('storyline', storyline.id, storyline.name, paths.claim('故事线', storyline.name, key('storyline', storyline.id)), storyline.contentJson ?? '{}', storyline.summary);
  }
  for (const item of [...graph.libraryItems].sort(compare)) {
    add('library_item', item.id, item.title, paths.claim('资料', item.title, key('library_item', item.id)));
  }
  const home = add('project', project.id, project.name, HOME, { summary: project.summary });
  for (const comment of [...graph.comments].sort(compare)) {
    const text = extractTextFromCommentBody(comment.bodyJson).split('\n')[0] || (comment.kind === 'todo' ? '待办' : '注释');
    add('comment', comment.id, Array.from(text).slice(0, 40).join(''), COMMENTS, { status: STATUS[comment.status] ?? comment.status });
  }
  // Hydrate all prose before creating links; persisted Yjs remains the only initialized prose authority.
  const proseDocuments = [...documents.values()].filter(document => document.fallback !== undefined);
  for (let index = 0; index < proseDocuments.length; index += 6) {
    await Promise.all(proseDocuments.slice(index, index + 6).map(async document => {
      document.json = await readLocalProseJson(document.kind as ProseEntityType, document.id, document.fallback!, source);
    }));
  }
  const resolver = createLocationResolver({ projectId: project.id, entities: locations,
    blockIds: (kind, id) => contentJsonBlockIds(documents.get(key(kind, id))?.json ?? '{}') });
  const link = (from: string, target: Document, title = target.title) =>
    `[${markdownLabel(title)}](${relativeMarkdownHref(from, target.path)})`;
  const links = (from: Document, targets: Document[]) => targets.map(target => `- ${link(from.path, target)}`).join('\n');
  const relation = (from: Document | undefined, to: Document | undefined, label: string) => {
    if (!from || !to) return;
    const line = `- ${markdownLabel(label)}：${link(from.path, to)}`;
    if (!from.sections.includes(line)) from.sections.push(line);
  };
  const types = new Map(graph.entityRelationTypes.map(type => [type.id, type]));
  for (const item of graph.entityRelations) {
    const type = types.get(item.relationTypeId);
    if (!type) throw new Error(`关系「${item.id}」引用了不存在的关系类型`);
    const label = type.systemKey === GENERIC_ASSOCIATION_SYSTEM_KEY ? '关联' : type.name;
    const from = documents.get(key(item.fromKind, item.fromId)), to = documents.get(key(item.toKind, item.toId));
    relation(from, to, label); relation(to, from, `反向：${label}`);
  }
  for (const item of graph.nodeStorylineLinks) {
    const from = documents.get(key('node', item.nodeId)), to = documents.get(key('storyline', item.storylineId));
    relation(from, to, '所属故事线'); relation(to, from, '包含章节');
  }
  for (const element of graph.elements.filter(item => !item.deletedAt)) relation(documents.get(key('element', element.id)), documents.get(key('category', element.categoryId ?? '')), '所属分类');
  for (const segment of segments) {
    const document = actDocuments.get(segment.act.id)!;
    document.summary = segment.chapters.length ? links(document, segment.chapters.map(chapter => documents.get(key('node', chapter.id))!)) : '本幕尚无章节。';
    if (segment.act.driftNodeId) relation(document, documents.get(key('node', segment.act.driftNodeId)), '本幕笔记');
  }
  const assetById = new Map(graph.assets.map(asset => [asset.id, asset]));
  const attachments = new Map<string, string>();
  const attach = (documentKey: string, assetId: string | null) => {
    if (!assetId) return;
    const document = documents.get(documentKey);
    if (!document) return;
    const asset = assetById.get(assetId);
    if (!asset || asset.projectId !== project.id) throw new Error(`Missing project asset metadata: ${assetId}`);
    let sourcePath = attachments.get(assetId);
    if (!sourcePath) {
      const ext = extForMime(asset.sourceMime);
      sourcePath = paths.claim('资料/附件', document.title, key('asset', asset.id), `.${ext}`);
      assets.set(sourcePath, { path: sourcePath, assetId, variant: 'source', ext, sourceSha256: asset.sourceSha256, sourceSizeBytes: asset.sourceSizeBytes });
      attachments.set(assetId, sourcePath);
    }
    let preview = sourcePath;
    const ext = extForMime(asset.sourceMime);
    if (asset.kind === 'image' && !['png', 'jpg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext)) {
      const existing = [...assets.values()].find(item => item.assetId === assetId && item.variant === 'display');
      preview = existing?.path ?? paths.claim('资料/附件', `${document.title}（预览）`, key('preview', assetId), '.jpg');
      assets.set(preview, { path: preview, assetId, variant: 'display', ext: 'jpg', sourceSha256: null, sourceSizeBytes: null });
    }
    document.sections.unshift(`## 附件\n\n![${markdownLabel(document.title)}](${relativeMarkdownHref(document.path, preview)})\n\n[原始文件](${relativeMarkdownHref(document.path, sourcePath)})`);
  };
  for (const element of graph.elements.filter(item => !item.deletedAt)) attach(key('element', element.id), element.portraitAssetId);
  for (const item of graph.libraryItems) attach(key('library_item', item.id), item.assetId);
  const richText = (value: string | null, from: string, headingOffset = 1) => {
    if (!value) return '';
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { return value; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return value;
    return obsidianProse(value, from, documents, resolver, headingOffset);
  };
  const header = (document: Document) => ['---', `aliases: ${JSON.stringify(document.aliases)}`,
    ...(document.status ? [`写作状态: ${JSON.stringify(document.status)}`] : []), '---', '', `# ${markdownLabel(document.title)}`].join('\n');
  for (const comment of graph.comments) relation(documents.get(key(comment.targetKind ?? '', comment.targetId ?? '')), documents.get(key('comment', comment.id)), comment.kind === 'todo' ? '待办' : '注释');
  for (const document of documents.values()) {
    if (document.kind === 'project' || document.kind === 'comment') continue;
    const parts = [header(document)];
    if (document.summary) parts.push(document.kind === 'act' ? document.summary : markdownShareSummary(document.summary));
    if (document.json !== undefined) {
      document.sourceVersion = await proseReadVersion(proseReadMarkdown(document.json, resolver));
      parts.push(obsidianProse(document.json, document.path, documents, resolver, 1));
    }
    if (document.kind === 'category') {
      const members = graph.elements.filter(item => !item.deletedAt && item.categoryId === document.id).map(item => documents.get(key('element', item.id))!);
      if (members.length) parts.push('## 包含要素', links(document, members));
    }
    if (document.kind === 'library_item') {
      const item = graph.libraryItems.find(item => item.id === document.id)!;
      parts.push(richText(item.bodyJson, document.path), richText(item.notesJson, document.path));
      if (item.externalUrl) parts.push(`## 外部链接\n\n[打开链接](${item.externalUrl.replace(/[\s()<>]/gu, char => encodeURIComponent(char))})`);
    }
    const related = document.sections.filter(section => section.startsWith('- '));
    parts.push(...document.sections.filter(section => !section.startsWith('- ')));
    if (related.length) parts.push('## 相关内容', related.join('\n'));
    entries.push({ path: document.path, text: parts.filter(Boolean).join('\n\n') + '\n' });
  }
  if (graph.comments.length) {
    const parts = ['# 注释与待办'];
    const grouped = new Map<string, typeof graph.comments>();
    for (const comment of [...graph.comments].sort(compare)) {
      const target = documents.get(key(comment.targetKind ?? '', comment.targetId ?? ''));
      const group = target?.key ?? '';
      grouped.set(group, [...(grouped.get(group) ?? []), comment]);
    }
    for (const [targetKey, comments] of grouped) {
      const target = documents.get(targetKey);
      parts.push(`## ${target ? link(COMMENTS, target) : '未关联的注释与待办'}`);
      for (const comment of comments) {
        const document = documents.get(key('comment', comment.id))!;
        parts.push(`### ${comment.kind === 'todo' ? '待办' : '注释'}：${markdownLabel(document.title)}`,
          `状态：${document.status}`, richText(comment.bodyJson, COMMENTS, 3));
      }
    }
    entries.push({ path: COMMENTS, text: parts.join('\n\n') + '\n' });
  }
  const chapterItem = (chapter: typeof chapters[number]) => {
    const document = documents.get(key('node', chapter.id))!;
    return `${chapters.indexOf(chapter) + 1}. ${link(CONTENTS, document)} · ${document.status}${chapter.summary ? ` — ${markdownLabel(chapter.summary)}` : ''}`;
  };
  const contents = ['# 正文目录'];
  const assigned = new Set(segments.flatMap(segment => segment.chapters.map(chapter => chapter.id)));
  contents.push(...chapters.filter(chapter => !assigned.has(chapter.id)).map(chapterItem));
  for (const segment of segments) contents.push(`## ${link(CONTENTS, actDocuments.get(segment.act.id)!)}`,
    ...segment.chapters.map(chapterItem), ...segment.chapters.length ? [] : ['本幕尚无章节。']);
  if (!chapters.length && !segments.length) contents.push('暂无章节。');
  entries.push({ path: CONTENTS, text: contents.join('\n\n') + '\n' });
  const first = chapters[0] && documents.get(key('node', chapters[0].id));
  const navigation = [
    `- [正文目录](${relativeMarkdownHref(HOME, CONTENTS)})`,
    ...(first ? [`- ${link(HOME, first, '从第一章开始阅读')}`] : []),
    ...['构想', 'element', 'storyline', 'library_item'].flatMap(kind => {
      const targets = kind === '构想' ? nodes.filter(node => node.kind !== 'chapter').map(node => documents.get(key('node', node.id))!)
        : [...documents.values()].filter(document => document.kind === kind);
      return targets.length ? [`## ${kind === 'element' ? '要素' : kind === 'storyline' ? '故事线' : kind === 'library_item' ? '资料' : kind}`, links(home, targets)] : [];
    }),
    ...(graph.comments.length ? [`- [注释与待办](${relativeMarkdownHref(HOME, COMMENTS)})`] : []),
    '- [导出说明](%E5%AF%BC%E5%87%BA%E8%AF%B4%E6%98%8E.md)',
  ];
  entries.push({ path: HOME, text: [`# ${markdownLabel(home.title)}`, markdownShareSummary(project.summary),
    `生成时间：${now.toISOString()}\n\n此目录是 Drifting 自动生成的只读副本。修改文件不会写回 Drifting，刷新可能覆盖修改。`, ...navigation].filter(Boolean).join('\n\n') + '\n' });
  entries.push({ path: '导出说明.md', text: '# 关于这份书稿\n\n从“开始阅读.md”进入，或按“正文”目录中的编号阅读章节。章节、构想、要素和故事线各是一份完整文件，摘要在开头，正文在中间，相关内容在末尾。\n\n正文沿用原有的场景、节拍、笔记标题层级；要素按已有分类组织，构想沿用已有分组。注释与待办按所属对象汇总。图片和 PDF 位于“资料/附件”，可在 Obsidian 中预览。\n\n此目录兼容 Obsidian，既可独立作为 Vault，也可整体放入已有 Vault 的子目录。重命名或调序后，Drifting 会更新内部链接；外部笔记中的旧文件链接可能失效。\n\n这是 READ-ONLY 单向投影，NO reverse sync。SQLite 与 Yjs 中的原稿不会被外部文件修改。需要修改请使用 Drifting 或获授权的工具；磁盘阅读不能替代工具的写前读取。\n\n.drifting/manifest.json 保存生成时间、文件 SHA-256、实体与路径映射和 sourceVersion。文件物理行号与哈希不同于 MCP read_chapter 的行号和版本；修改前请通过工具重新读取。正文不带段落锚点，引用和关联链接打开整份文件。\n\n投影不包含完整数据库和 CRDT 历史，不能替代可恢复备份。项目关闭后保留最后快照，重新打开或手动刷新后更新。\n' });
  return { entries: entries.sort((a, b) => a.path.localeCompare(b.path, 'en')), assets: [...assets.values()],
    documents: [...documents.values()].map(({ key, path, title, anchor, sourceVersion }) => ({ key, path, title, anchor, sourceVersion })), documentCount: documents.size };
}
