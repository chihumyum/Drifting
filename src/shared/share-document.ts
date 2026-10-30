/**
 * Share link document v1: the reader copy of one entity's prose that the
 * client publishes to the Hosted service (docs/share-links.md). The desktop
 * client builds it from live Yjs prose; the web reader (src/share-web) renders
 * it and anchors readers' comments to it.
 *
 * A block's plain text is the concatenation of its runs' text and equals the
 * ProseMirror block's `textContent`, so comment offsets mean the same thing in
 * the reader and in the editor. Hard breaks are runs without text.
 *
 * Entity links carry a key into `entities`: each linked entity's name, summary
 * and link colour, nothing more, in reading order. `folio` is the editor page's
 * header line.
 *
 * Key order matches the service's normalized form, so an unchanged copy hashes
 * the same on both sides and republishing it keeps its revision.
 */
export const SHARE_DOCUMENT_VERSION = 1;
export const SHARE_TITLE_MAX = 200;
export const SHARE_NAME_MAX = 200;
export const SHARE_SUMMARY_MAX = 2000;
export const SHARE_ENTITIES_MAX = 1000;

export type ShareMark = 'bold' | 'italic' | 'strike' | 'underline';
const SHARE_MARKS: readonly ShareMark[] = ['bold', 'italic', 'strike', 'underline'];

export interface ShareRun {
  text: string;
  marks?: ShareMark[];
  href?: string;
  /** Key into the document's `entities`: the run is an entity link. */
  entity?: string;
  br?: true;
}

/** Kinds an entity link can point at and a reader can hover. */
export type ShareLinkedKind = 'element' | 'node' | 'storyline' | 'category';

/**
 * A linked entity as readers see it on hover: its name and summary only, with
 * the colour the author's editor gives the link.
 */
export interface ShareEntity {
  kind: ShareLinkedKind;
  name: string;
  summary?: string;
  color?: string;
}

/**
 * The editor page's folio: the chapter's place in reading order, the coloured
 * line it belongs to (a chapter's storyline, a drift's group, an element's
 * category) and its word count.
 */
export interface ShareFolio {
  chapter?: number;
  line?: { name: string; color?: string };
  words?: number;
}

export interface ShareBlock {
  /** The editor block id comments anchor to; null for a block without one. */
  id: string | null;
  type: 'paragraph' | 'heading' | 'rule';
  level?: 1 | 2 | 3;
  quote?: true;
  align?: 'center' | 'right';
  indent?: number;
  runs: ShareRun[];
}

export type ShareDocumentKind = 'chapter' | 'drift' | 'element' | 'storyline' | 'category';

export interface ShareDocument {
  v: 1;
  title: string;
  kind: ShareDocumentKind;
  blocks: ShareBlock[];
  folio?: ShareFolio;
  entities?: Record<string, ShareEntity>;
}

/**
 * Colours as Drifting stores them: hex, or a design token (`hsl(var(--story-2))`).
 * Anything else is left out, on both sides of the contract.
 */
export function shareColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const color = value.trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(color) || /^hsl\(var\(--[a-z0-9-]{1,40}\)\)$/.test(color) ? color : undefined;
}

/** The normalized form of a linked entity, in the key order the service writes. */
export function shareEntity(kind: ShareLinkedKind, name: string, summary?: string | null, color?: string | null): ShareEntity {
  const entity: ShareEntity = { kind, name: name.slice(0, SHARE_NAME_MAX) };
  const text = summary?.trim().slice(0, SHARE_SUMMARY_MAX);
  if (text) entity.summary = text;
  const safe = shareColor(color);
  if (safe) entity.color = safe;
  return entity;
}

export interface ShareDocumentContext {
  /** The entity a link points at, or null when it is gone, trashed or not shown. */
  resolveEntity?: (kind: string, id: string) => ShareEntity | null;
  folio?: ShareFolio;
}

/** The comment anchor readers send; the shape of the client's CommentAnchorPayload. */
export interface ShareCommentAnchor {
  targetBlockId: string | null;
  targetBlockIds: string[];
  selectedText: string;
  blockText: string;
  blockSelectionFrom: number;
  blockSelectionTo: number;
  blockSnapshots: { blockId: string | null; blockText: string }[];
  textAnchor: {
    startBlockId: string;
    startOffset: number;
    endBlockId: string;
    endOffset: number;
    text: string;
  } | null;
}

export function shareBlockText(block: ShareBlock): string {
  let text = '';
  for (const run of block.runs) text += run.text;
  return text;
}

interface ProseNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: ProseNode[];
}

function normalizedHref(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Hands out `e1`, `e2`… in reading order, one per linked entity. */
class EntityTable {
  readonly entries: Record<string, ShareEntity> = {};
  private readonly keys = new Map<string, string | null>();
  constructor(private readonly resolve: ShareDocumentContext['resolveEntity']) {}
  key(mark: { attrs?: Record<string, unknown> } | undefined): string | undefined {
    const kind = mark?.attrs?.targetKind ?? 'element';
    const id = mark?.attrs?.targetId;
    if (!this.resolve || typeof kind !== 'string' || typeof id !== 'string' || !id) return undefined;
    const identity = `${kind}:${id}`;
    if (!this.keys.has(identity)) {
      const entity = this.keys.size < SHARE_ENTITIES_MAX ? this.resolve(kind, id) : null;
      const key = entity ? `e${Object.keys(this.entries).length + 1}` : null;
      if (key && entity) this.entries[key] = entity;
      this.keys.set(identity, key);
    }
    return this.keys.get(identity) ?? undefined;
  }
}

function inlineRuns(node: ProseNode, runs: ShareRun[], entities: EntityTable): void {
  for (const child of node.content ?? []) {
    if (child.type === 'hardBreak') {
      runs.push({ text: '', br: true });
      continue;
    }
    if (child.type !== 'text') {
      // An unknown inline node keeps its text, if any, so offsets stay aligned.
      if (child.content) inlineRuns(child, runs, entities);
      continue;
    }
    if (!child.text) continue;
    const marks = SHARE_MARKS.filter(mark => child.marks?.some(item => item.type === mark));
    const link = child.marks?.find(item => item.type === 'link');
    const href = link ? normalizedHref(link.attrs?.href) : undefined;
    const entity = entities.key(child.marks?.find(item => item.type === 'entityLink'));
    const previous = runs[runs.length - 1];
    if (previous && !previous.br && previous.href === href && previous.entity === entity
      && (previous.marks ?? []).join() === marks.join()) {
      previous.text += child.text;
      continue;
    }
    const run: ShareRun = { text: child.text };
    if (marks.length) run.marks = marks;
    if (href) run.href = href;
    if (entity) run.entity = entity;
    runs.push(run);
  }
}

function textBlock(node: ProseNode, quote: boolean, entities: EntityTable): ShareBlock {
  const id = typeof node.attrs?.id === 'string' && node.attrs.id ? node.attrs.id : null;
  const runs: ShareRun[] = [];
  inlineRuns(node, runs, entities);
  const block: ShareBlock = { id, type: node.type === 'heading' ? 'heading' : 'paragraph', runs };
  if (block.type === 'heading') {
    const level = node.attrs?.level;
    block.level = level === 1 || level === 2 ? level : 3;
  }
  if (quote) block.quote = true;
  const align = node.attrs?.textAlign;
  if (align === 'center' || align === 'right') block.align = align;
  const indent = node.attrs?.indent;
  if (typeof indent === 'number' && Number.isInteger(indent) && indent > 0) block.indent = Math.min(indent, 8);
  return block;
}

function collectBlocks(nodes: readonly ProseNode[], quote: boolean, blocks: ShareBlock[], entities: EntityTable): void {
  for (const node of nodes) {
    if (node.type === 'paragraph' || node.type === 'heading') {
      blocks.push(textBlock(node, quote, entities));
    } else if (node.type === 'horizontalRule') {
      blocks.push({ id: typeof node.attrs?.id === 'string' ? node.attrs.id : null, type: 'rule', runs: [] });
    } else if (node.type === 'blockquote') {
      collectBlocks(node.content ?? [], true, blocks, entities);
    } else if (node.content?.some(child => child.type === 'text' || child.type === 'hardBreak')) {
      blocks.push(textBlock(node, quote, entities));
    } else if (node.content) {
      collectBlocks(node.content, quote, blocks, entities);
    }
  }
}

/** Every entity link target in a prose body, for resolving them before the copy is built. */
export function proseEntityLinks(prose: unknown): { kind: string; id: string }[] {
  const found = new Map<string, { kind: string; id: string }>();
  const visit = (node: ProseNode) => {
    for (const mark of node.marks ?? []) {
      if (mark.type !== 'entityLink') continue;
      const kind = typeof mark.attrs?.targetKind === 'string' ? mark.attrs.targetKind : 'element';
      const id = mark.attrs?.targetId;
      if (typeof id === 'string' && id) found.set(`${kind}:${id}`, { kind, id });
    }
    if (Array.isArray(node.content)) node.content.forEach(visit);
  };
  if (prose && typeof prose === 'object') visit(prose as ProseNode);
  return [...found.values()];
}

/** The reader copy of a prose body (ProseMirror JSON) under a title. */
export function proseJsonToShareDocument(
  prose: unknown,
  title: string,
  kind: ShareDocumentKind,
  context: ShareDocumentContext = {},
): ShareDocument {
  const blocks: ShareBlock[] = [];
  const entities = new EntityTable(context.resolveEntity);
  const root = prose && typeof prose === 'object' ? (prose as ProseNode) : {};
  collectBlocks(Array.isArray(root.content) ? root.content : [], false, blocks, entities);
  const document: ShareDocument = { v: 1, title: title.slice(0, SHARE_TITLE_MAX).trim(), kind, blocks };
  const folio = normalizedFolio(context.folio);
  if (folio) document.folio = folio;
  if (Object.keys(entities.entries).length) document.entities = entities.entries;
  return document;
}

function normalizedFolio(folio: ShareFolio | undefined): ShareFolio | undefined {
  if (!folio) return undefined;
  const result: ShareFolio = {};
  if (folio.chapter !== undefined && Number.isSafeInteger(folio.chapter) && folio.chapter > 0) result.chapter = folio.chapter;
  const name = folio.line?.name.slice(0, SHARE_NAME_MAX);
  if (name) {
    result.line = { name };
    const color = shareColor(folio.line?.color);
    if (color) result.line.color = color;
  }
  if (folio.words !== undefined && Number.isSafeInteger(folio.words) && folio.words >= 0) result.words = folio.words;
  return Object.keys(result).length ? result : undefined;
}
