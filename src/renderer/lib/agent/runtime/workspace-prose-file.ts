import type {
  YjsProseBlock,
  YjsProseNode,
  YjsProseOperation,
  YjsProseTextNode,
} from './yjs-prose-command';

export interface WorkspaceTextReplacement {
  oldText: string;
  newText: string;
  replaceAll: boolean;
}

export function parseWorkspaceTextReplacements(value: unknown): WorkspaceTextReplacement[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('edit_file requires at least one exact replacement');
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`replacements[${index}] must be an object`);
    }
    const row = raw as Record<string, unknown>;
    if (typeof row.oldText !== 'string' || row.oldText.length === 0) {
      throw new Error(`replacements[${index}].oldText must be non-empty`);
    }
    if (typeof row.newText !== 'string') {
      throw new Error(`replacements[${index}].newText must be a string`);
    }
    return {
      oldText: normalizeLineEndings(row.oldText),
      newText: normalizeLineEndings(row.newText),
      replaceAll: row.replaceAll === true,
    };
  });
}

export function applyWorkspaceTextReplacements(
  content: string,
  replacements: readonly WorkspaceTextReplacement[],
): string {
  let next = normalizeLineEndings(content);
  for (const replacement of replacements) {
    const count = countOccurrences(next, replacement.oldText);
    if (count === 0) {
      throw new Error(
        `The text to replace was not found in the current file: ${previewText(replacement.oldText)}`,
      );
    }
    if (!replacement.replaceAll && count !== 1) {
      throw new Error(
        `The text to replace occurs ${count} times. Include more surrounding text or set replaceAll=true.`,
      );
    }
    next = replacement.replaceAll
      ? next.split(replacement.oldText).join(replacement.newText)
      : next.replace(replacement.oldText, replacement.newText);
  }
  if (next === normalizeLineEndings(content)) {
    throw new Error('The requested replacements do not change the file');
  }
  return next;
}

export function renderWorkspaceProseFile(blocks: readonly YjsProseBlock[]): string {
  return blocks.map(renderWorkspaceProseBlock).join('\n\n');
}

/**
 * Turn normal file replacements into one atomic structured prose operation.
 * Existing blocks survive by identity whenever their rendered text still
 * exists, so comments, editor anchors, and untouched inline marks remain
 * attached. Only newly inserted paragraphs receive deterministic block ids.
 */
export async function planWorkspaceProseFileEdit(input: {
  blocks: readonly YjsProseBlock[];
  replacements: readonly WorkspaceTextReplacement[];
  idempotencyKey: string;
}): Promise<YjsProseOperation> {
  const beforeText = renderWorkspaceProseFile(input.blocks);
  const afterText = applyWorkspaceTextReplacements(beforeText, input.replacements);
  const desiredTexts = splitWorkspaceProseFile(afterText);
  const beforeTexts = input.blocks.map(renderWorkspaceProseBlock);
  const exactPairs = longestCommonSubsequencePairs(beforeTexts, desiredTexts);
  const desiredBlocks: YjsProseBlock[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  let inserted = 0;

  for (const [oldMatch, newMatch] of [...exactPairs, [input.blocks.length, desiredTexts.length]]) {
    const oldGap = input.blocks.slice(oldCursor, oldMatch);
    const newGap = desiredTexts.slice(newCursor, newMatch);
    const paired = Math.min(oldGap.length, newGap.length);
    for (let index = 0; index < paired; index += 1) {
      desiredBlocks.push(blockWithRenderedText(oldGap[index]!, newGap[index]!));
    }
    for (let index = paired; index < newGap.length; index += 1) {
      desiredBlocks.push(
        await newBlockFromRenderedText(
          newGap[index]!,
          await deterministicBlockId(input.idempotencyKey, inserted),
        ),
      );
      inserted += 1;
    }
    if (oldMatch < input.blocks.length && newMatch < desiredTexts.length) {
      desiredBlocks.push(input.blocks[oldMatch]!);
    }
    oldCursor = oldMatch + 1;
    newCursor = newMatch + 1;
  }

  if (input.blocks.length === 0) {
    return { kind: 'insert', afterBlockId: null, blocks: desiredBlocks };
  }

  let prefix = 0;
  while (
    prefix < input.blocks.length &&
    prefix < desiredBlocks.length &&
    blocksEqual(input.blocks[prefix]!, desiredBlocks[prefix]!)
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < input.blocks.length - prefix &&
    suffix < desiredBlocks.length - prefix &&
    blocksEqual(
      input.blocks[input.blocks.length - 1 - suffix]!,
      desiredBlocks[desiredBlocks.length - 1 - suffix]!,
    )
  ) {
    suffix += 1;
  }

  const oldChanged = input.blocks.slice(prefix, input.blocks.length - suffix);
  const newChanged = desiredBlocks.slice(prefix, desiredBlocks.length - suffix);
  if (oldChanged.length === 0) {
    return {
      kind: prefix === input.blocks.length ? 'append' : 'insert',
      ...(prefix === input.blocks.length
        ? { blocks: newChanged }
        : {
            afterBlockId: prefix === 0 ? null : input.blocks[prefix - 1]!.id,
            blocks: newChanged,
          }),
    } as YjsProseOperation;
  }
  if (newChanged.length === 0) {
    return { kind: 'remove', blockIds: oldChanged.map((block) => block.id) };
  }
  if (
    oldChanged.length === newChanged.length &&
    oldChanged.every((block, index) => block.id === newChanged[index]?.id)
  ) {
    return {
      kind: 'edit_many',
      edits: oldChanged.flatMap((block, index) => {
        const replacement = newChanged[index]!;
        return blocksEqual(block, replacement) ? [] : [{ blockId: block.id, block: replacement }];
      }),
    };
  }
  return {
    kind: 'replace',
    fromBlockId: oldChanged[0]!.id,
    toBlockId: oldChanged[oldChanged.length - 1]!.id,
    blocks: newChanged,
  };
}

function renderWorkspaceProseBlock(block: YjsProseBlock): string {
  const text = nodesText(block.content ?? []).replace(/\s*\n\s*/g, ' ');
  switch (block.type) {
    case 'paragraph':
      return text;
    case 'heading':
      return `# ${text}`;
    case 'blockquote':
      return `> ${text}`;
    case 'codeBlock':
      return `\` ${text}`;
    case 'listItem':
    case 'bulletList':
      return `- ${text}`;
    case 'orderedList':
      return `1. ${text}`;
    default:
      return `[${block.type}] ${text}`;
  }
}

function nodesText(nodes: readonly YjsProseNode[]): string {
  return nodes
    .map((node) => (node.kind === 'text' ? node.text : nodesText(node.content ?? [])))
    .join('');
}

function splitWorkspaceProseFile(value: string): string[] {
  const normalized = normalizeLineEndings(value);
  if (normalized.length === 0) return [''];
  return normalized.split(/\n{2,}/).map((block) => block.replace(/\n/g, ' '));
}

function blockWithRenderedText(block: YjsProseBlock, rendered: string): YjsProseBlock {
  const parsed = parseRenderedBlock(rendered, block.type);
  if (parsed.type !== block.type) {
    return makeBlock(block.id, parsed.type, parsed.text, undefined);
  }
  if (block.type === 'blockquote') {
    const paragraph = block.content?.find(
      (node) => node.kind === 'element' && node.type === 'paragraph',
    );
    const current = paragraph?.kind === 'element' ? (paragraph.content ?? []) : [];
    return {
      ...block,
      content: [
        {
          kind: 'element',
          type: 'paragraph',
          ...(paragraph?.kind === 'element' && paragraph.attrs ? { attrs: paragraph.attrs } : {}),
          ...(parsed.text ? { content: replaceMarkedText(current, parsed.text) } : {}),
        },
      ],
    };
  }
  if (block.type === 'paragraph' || block.type === 'heading' || block.type === 'codeBlock') {
    return {
      ...block,
      content: parsed.text ? replaceMarkedText(block.content ?? [], parsed.text) : [],
    };
  }
  return makeBlock(block.id, parsed.type, parsed.text, block.attrs);
}

function replaceMarkedText(
  nodes: readonly YjsProseNode[],
  nextText: string,
): readonly YjsProseTextNode[] {
  if (!nodes.every((node) => node.kind === 'text')) {
    return nextText ? [{ kind: 'text', text: nextText }] : [];
  }
  const textNodes = nodes as readonly YjsProseTextNode[];
  const previous = textNodes.map((node) => node.text).join('');
  let prefix = 0;
  while (
    prefix < previous.length &&
    prefix < nextText.length &&
    previous[prefix] === nextText[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < nextText.length - prefix &&
    previous[previous.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return mergeTextNodes([
    ...sliceTextNodes(textNodes, 0, prefix),
    ...(nextText.length - suffix > prefix
      ? [{ kind: 'text' as const, text: nextText.slice(prefix, nextText.length - suffix) }]
      : []),
    ...sliceTextNodes(textNodes, previous.length - suffix, previous.length),
  ]);
}

function sliceTextNodes(
  nodes: readonly YjsProseTextNode[],
  from: number,
  to: number,
): YjsProseTextNode[] {
  const output: YjsProseTextNode[] = [];
  let cursor = 0;
  for (const node of nodes) {
    const start = Math.max(0, from - cursor);
    const end = Math.min(node.text.length, to - cursor);
    if (start < end) {
      output.push({
        ...node,
        text: node.text.slice(start, end),
      });
    }
    cursor += node.text.length;
    if (cursor >= to) break;
  }
  return output;
}

function mergeTextNodes(nodes: readonly YjsProseTextNode[]): YjsProseTextNode[] {
  const output: YjsProseTextNode[] = [];
  for (const node of nodes) {
    if (!node.text) continue;
    const last = output[output.length - 1];
    if (last && JSON.stringify(last.marks ?? {}) === JSON.stringify(node.marks ?? {})) {
      output[output.length - 1] = { ...last, text: last.text + node.text };
    } else {
      output.push(node);
    }
  }
  return output;
}

async function newBlockFromRenderedText(rendered: string, id: string): Promise<YjsProseBlock> {
  const parsed = parseRenderedBlock(rendered, 'paragraph');
  return makeBlock(id, parsed.type, parsed.text, undefined);
}

function parseRenderedBlock(
  rendered: string,
  fallbackType: string,
): { type: string; text: string } {
  const heading = /^\s{0,3}#{1,6}[\t ]+(.*)$/s.exec(rendered);
  if (heading) return { type: 'heading', text: heading[1] ?? '' };
  const quote = /^\s{0,3}>[\t ]?(.*)$/s.exec(rendered);
  if (quote) return { type: 'blockquote', text: quote[1] ?? '' };
  const code = /^`[\t ]?(.*)$/s.exec(rendered);
  if (code) return { type: 'codeBlock', text: code[1] ?? '' };
  const bullet = /^-[\t ]+(.*)$/s.exec(rendered);
  if (bullet) return { type: 'bulletList', text: bullet[1] ?? '' };
  const ordered = /^1\.[\t ]+(.*)$/s.exec(rendered);
  if (ordered) return { type: 'orderedList', text: ordered[1] ?? '' };
  const typed = /^\[([^\]]+)]\s?(.*)$/s.exec(rendered);
  if (typed && typed[1] === fallbackType) {
    return { type: fallbackType, text: typed[2] ?? '' };
  }
  // The Markdown-like prefix is the file representation of a structural
  // block. Removing that prefix is therefore a real type change, just as it
  // would be in an ordinary Markdown file.
  return { type: 'paragraph', text: rendered };
}

function makeBlock(
  id: string,
  type: string,
  text: string,
  attrs: YjsProseBlock['attrs'],
): YjsProseBlock {
  if (type === 'blockquote') {
    return {
      id,
      type,
      ...(attrs ? { attrs } : {}),
      content: [
        {
          kind: 'element',
          type: 'paragraph',
          ...(text ? { content: [{ kind: 'text', text }] } : {}),
        },
      ],
    };
  }
  if (type === 'bulletList' || type === 'orderedList') {
    return {
      id,
      type,
      ...(attrs ? { attrs } : {}),
      content: [
        {
          kind: 'element',
          type: 'listItem',
          content: [
            {
              kind: 'element',
              type: 'paragraph',
              ...(text ? { content: [{ kind: 'text', text }] } : {}),
            },
          ],
        },
      ],
    };
  }
  return {
    id,
    type,
    ...(attrs ? { attrs } : {}),
    content: text ? [{ kind: 'text', text }] : [],
  };
}

function longestCommonSubsequencePairs(
  before: readonly string[],
  after: readonly string[],
): Array<[number, number]> {
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      table[left * width + right] =
        before[left] === after[right]
          ? 1 + table[(left + 1) * width + right + 1]!
          : Math.max(table[(left + 1) * width + right]!, table[left * width + right + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      pairs.push([left, right]);
      left += 1;
      right += 1;
    } else if (table[(left + 1) * width + right]! >= table[left * width + right + 1]!) {
      left += 1;
    } else {
      right += 1;
    }
  }
  return pairs;
}

function blocksEqual(left: YjsProseBlock, right: YjsProseBlock): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function deterministicBlockId(idempotencyKey: string, index: number): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        `drifting.workspace-prose-block:${idempotencyKey}:${index}`,
      ) as BufferSource,
    ),
  );
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= value.length - needle.length) {
    const found = value.indexOf(needle, offset);
    if (found < 0) break;
    count += 1;
    offset = found + needle.length;
  }
  return count;
}

function previewText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  const preview = compact.length > 120 ? `${compact.slice(0, 117)}…` : compact;
  return JSON.stringify(preview);
}
