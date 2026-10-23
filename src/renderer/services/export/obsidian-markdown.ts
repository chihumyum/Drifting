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

/** Plain readable Markdown: entity links point at whole files, without block anchors or fragments. */
export function obsidianProse(
  contentJson: string,
  from: string,
  documents: ReadonlyMap<string, ObsidianDocument>,
  locations?: LocationResolver,
  headingOffset = 0,
): string {
  // Adapt a captured copy only. The live document and the Agent's Markdown protocol stay unchanged.
  const convert = (node: JSONContent): JSONContent => {
    const marks = node.marks ?? [];
    let target: { targetKind: string; targetId: string } | undefined;
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
    const document = target && documents.get(`${target.targetKind}:${target.targetId}`);
    const next: JSONContent = { ...node, ...(node.content ? { content: node.content.map(convert) } : {}) };
    if (!document) return next;
    const kept = marks.filter(mark => mark.type !== 'entityLink' && !(replacedLink && mark.type === 'link'));
    next.marks = [...kept, { type: 'link', attrs: { href: relativeMarkdownHref(from, document.path) } }];
    return next;
  };
  const adapted = convert(JSON.parse(contentJson || '{}') as JSONContent);
  return docToBlocks(JSON.stringify(adapted)).flatMap(block => {
    if (!block.markdown) return [];
    return [block.type === 'heading' ? block.markdown.replace(/^(#{1,3}) /u, (_, hashes: string) => `${'#'.repeat(Math.min(6, hashes.length + headingOffset))} `) : block.markdown];
  }).join('\n\n');
}
