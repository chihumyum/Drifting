import type { JSONContent } from '@tiptap/core';
import { docToBlocks } from '../../lib/agent/serialize';
import type { LocationResolver } from '../../lib/location-link';

export interface ObsidianDocument { path: string; title: string }

export function markdownLabel(value: string): string {
  return value.replace(/[\\[\]`*_~<>|]/gu, '\\$&').replace(/\r?\n/gu, ' ');
}

/** File-relative Markdown destinations survive moving the whole projection into a vault. */
export function relativeMarkdownHref(from: string, to: string, fragment = ''): string {
  const base = from.split('/').slice(0, -1);
  const target = to.split('/');
  while (base.length && target.length && base[0] === target[0]) { base.shift(); target.shift(); }
  return [...base.map(() => '..'), ...target]
    .map(part => encodeURIComponent(part).replace(/[!'()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/') + fragment;
}

export function relativeMarkdownLink(from: string, to: string, label: string): string {
  return `[${markdownLabel(label)}](${relativeMarkdownHref(from, to)})`;
}

/** Encode, rather than strip, ids: distinct Unicode/punctuation ids must never collide. */
export function obsidianBlockId(id: string | null, index: number): string {
  return id ? `drift-${Array.from(new TextEncoder().encode(id), byte => byte.toString(16).padStart(2, '0')).join('')}`
    : `drift-position-${index + 1}`;
}

export function obsidianProse(
  contentJson: string,
  from: string,
  documents: ReadonlyMap<string, ObsidianDocument>,
  blocks: (key: string) => readonly (string | null)[],
  locations?: LocationResolver,
  anchorBlocks = true,
  headingOffset = 0,
): string {
  // Adapt a captured copy only. The live document and the Agent's Markdown protocol stay unchanged.
  const convert = (node: JSONContent): JSONContent[] => {
    const marks = node.marks ?? [];
    let target: { targetKind: string; targetId: string; targetBlockId?: string | null; targetEndBlockId?: string | null } | undefined;
    let replacedLink = false;
    for (const mark of marks) {
      if (mark.type === 'entityLink' && typeof mark.attrs?.targetKind === 'string' && typeof mark.attrs?.targetId === 'string') {
        target = mark.attrs as typeof target;
        break;
      }
      if (mark.type === 'link' && typeof mark.attrs?.href === 'string') {
        const resolution = locations?.resolve(mark.attrs.href);
        if (resolution?.ok) { target = resolution.attrs; replacedLink = true; break; }
      }
    }
    const documentKey = target ? `${target.targetKind}:${target.targetId}` : '';
    const document = documents.get(documentKey);
    const next: JSONContent = { ...node, ...(node.content ? { content: node.content.flatMap(convert) } : {}) };
    if (!document || !target) return [next];
    const targetBlocks = blocks(documentKey);
    const index = target.targetBlockId ? targetBlocks.indexOf(target.targetBlockId) : -1;
    const end = target.targetEndBlockId ? targetBlocks.indexOf(target.targetEndBlockId) : -1;
    const path = document.path;
    const href = (at: number) => relativeMarkdownHref(from, path,
      at >= 0 ? `#^${obsidianBlockId(targetBlocks[at]!, at)}` : '');
    const kept = marks.filter(mark => mark.type !== 'entityLink' && !(replacedLink && mark.type === 'link'));
    next.marks = [...kept, { type: 'link', attrs: { href: href(index) } }];
    if (index >= 0 && end > index) {
      return [next, { type: 'text', text: '（至' },
        { type: 'text', text: '末段', marks: [{ type: 'link', attrs: { href: href(end) } }] },
        { type: 'text', text: '）' }];
    }
    return [next];
  };
  const doc = JSON.parse(contentJson || '{}') as JSONContent;
  const adapted = convert(doc)[0]!;
  return docToBlocks(JSON.stringify(adapted)).map((block, index) => {
    const raw = block.markdown || '&#8203;';
    const markdown = block.type === 'heading' ? raw.replace(/^(#{1,3}) /u, (_, hashes: string) => `${'#'.repeat(Math.min(6, hashes.length + headingOffset))} `) : raw;
    if (!anchorBlocks) return markdown;
    const anchor = `^${obsidianBlockId(block.blockId, index)}`;
    // Obsidian requires a separate anchor paragraph for quotes and other structured blocks.
    return block.type === 'paragraph' ? `${markdown} ${anchor}` : `${markdown}\n\n${anchor}`;
  }).join('\n\n');
}
