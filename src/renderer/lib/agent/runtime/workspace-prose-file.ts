import type {
  YjsProseBlock,
  YjsProseNode,
  YjsProseOperation,
  YjsProseTextNode,
} from './yjs-prose-command';
import {
  normalizeAgentMarkdownLink,
  parseAgentProseMarkdown,
  renderAgentProseMarkdownBlock,
  type AgentMarkdownBlock,
  type AgentMarkdownInline,
  type AgentMarkdownMarks,
} from '../markdown-prose-adapter';

export interface WorkspaceTextReplacement {
  oldText: string;
  newText: string;
  replaceAll: boolean;
}

export interface NormalizedWorkspaceProseReplacements {
  replacements: WorkspaceTextReplacement[];
  skippedStale: number;
  skippedStaleTargets: string[];
}

export interface ModelFacingAuthoredText {
  text: string;
  linkedMentions: string[];
}

/**
 * The editor stores inline structure such as hard breaks and entity links.
 * Those are domain annotations, not prose for the model to clean up. Present
 * ordinary authored text plus a compact mention set; keep the reversible
 * annotation syntax inside the runtime.
 */
export function projectAuthoredTextForModel(value: string): ModelFacingAuthoredText {
  const projection = projectAuthoredText(value);
  return {
    text: normalizeAuthoredTextTransportArtifacts(projection.text),
    linkedMentions: [...new Set(projection.linkedMentions)],
  };
}

/**
 * Provider function calls carry strings inside JSON. Some models occasionally
 * emit a second transport-escaping layer (for example `\\\"对白\\\"` or
 * `\\他说`) as if that layer were authored prose. Drifting owns that boundary:
 * remove only impossible prose escapes before quote/CJK glyphs while keeping
 * Markdown escapes and ordinary backslashes intact.
 */
export function normalizeAuthoredTextTransportArtifacts(value: string): string {
  return normalizeLineEndings(value).replace(
    /\\+(?=["'“”‘’「」『』《》〈〉，。！？；：、—…（）【】\p{Script=Han}])/gu,
    '',
  );
}

/** Normalize newly authored replacement text without losing an exact match
 * against already persisted legacy artifacts. */
export function normalizeWorkspaceProseReplacements(
  content: string,
  replacements: readonly WorkspaceTextReplacement[],
): NormalizedWorkspaceProseReplacements {
  let current = normalizeLineEndings(content);
  const normalizedReplacements: WorkspaceTextReplacement[] = [];
  let skippedStale = 0;
  const skippedStaleTargets: string[] = [];
  let firstStaleError: Error | null = null;
  for (const replacement of replacements) {
    const normalizedOld = normalizeAuthoredTextTransportArtifacts(replacement.oldText);
    const accidentalWrapper = matchingQuoteWrapper(normalizedOld);
    const directOld = current.includes(replacement.oldText)
      ? replacement.oldText
      : current.includes(normalizedOld)
        ? normalizedOld
        : null;
    const unwrappedOld =
      directOld === null &&
      accidentalWrapper
        ? resolveModelFacingOldText(
            current,
            accidentalWrapper.inner,
            replacement.replaceAll,
          )
        : null;
    const projectedOld =
      directOld === null && unwrappedOld === null
        ? resolveModelFacingOldText(current, normalizedOld, replacement.replaceAll)
        : null;
    const resolvedOld = directOld ?? unwrappedOld ?? projectedOld;
    const oldText = resolvedOld ?? normalizedOld;
    const normalizedNew = normalizeAuthoredTextTransportArtifacts(replacement.newText);
    if (
      resolvedOld === null &&
      normalizedNew.length > 0 &&
      uniqueModelFacingTextExists(current, normalizedNew, replacement.replaceAll)
    ) {
      // The desired authored passage is already current. This is an idempotent
      // row, not unfinished work for the model to localize or debug.
      continue;
    }
    const matchingNewWrapper =
      unwrappedOld && accidentalWrapper ? matchingQuoteWrapper(normalizedNew) : null;
    const authoredNew =
      matchingNewWrapper &&
      accidentalWrapper &&
      matchingNewWrapper.open === accidentalWrapper.open &&
      matchingNewWrapper.close === accidentalWrapper.close
        ? matchingNewWrapper.inner
        : normalizedNew;
    const normalized = {
      ...replacement,
      oldText,
      newText: restoreAuthoredTextAnnotations(
        oldText,
        authoredNew,
      ),
    };
    if (normalized.oldText === normalized.newText) continue;
    try {
      current = applyWorkspaceTextReplacements(current, [normalized]);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('STALE_EDIT_TARGET:')) {
        skippedStale += 1;
        skippedStaleTargets.push(normalized.oldText);
        firstStaleError ??= error;
        continue;
      }
      throw error;
    }
    normalizedReplacements.push(normalized);
  }
  if (normalizedReplacements.length === 0) {
    if (firstStaleError) throw firstStaleError;
    throw new Error('The requested replacements do not change the file');
  }
  return { replacements: normalizedReplacements, skippedStale, skippedStaleTargets };
}

function uniqueModelFacingTextExists(
  current: string,
  desiredText: string,
  replaceAll: boolean,
): boolean {
  try {
    return resolveModelFacingOldText(current, desiredText, replaceAll) !== null;
  } catch {
    // A repeated desired phrase cannot prove that this exact stale target was
    // already satisfied. Leave it on the ordinary stale path.
    return false;
  }
}

function matchingQuoteWrapper(
  value: string,
): { open: string; close: string; inner: string } | null {
  const pairs = [
    ['“', '”'],
    ['‘', '’'],
    ['「', '」'],
    ['『', '』'],
    ['"', '"'],
    ["'", "'"],
  ] as const;
  for (const [open, close] of pairs) {
    if (value.length > open.length + close.length && value.startsWith(open) && value.endsWith(close)) {
      return { open, close, inner: value.slice(open.length, -close.length) };
    }
  }
  return null;
}

export function restoreAuthoredTextAnnotations(previous: string, next: string): string {
  let restored = next;
  let searchFrom = 0;
  for (const link of internalAuthoredLinks(previous)) {
    if (restored.includes(link.raw)) {
      searchFrom = restored.indexOf(link.raw, searchFrom) + link.raw.length;
      continue;
    }
    const labelAt = restored.indexOf(link.label, searchFrom);
    if (labelAt < 0) continue;
    restored = `${restored.slice(0, labelAt)}${link.raw}${restored.slice(labelAt + link.label.length)}`;
    searchFrom = labelAt + link.raw.length;
  }
  if (/<br\s*\/?>/iu.test(previous)) {
    restored = restored.replace(/(?<!\n)\n(?!\n)/gu, '<br>');
  }
  return restored;
}

function resolveModelFacingOldText(
  current: string,
  modelOldText: string,
  replaceAll: boolean,
): string | null {
  const projection = projectAuthoredText(current);
  const matches = findReplacementMatches(projection.text, modelOldText);
  if (matches.length === 0) return null;
  if (!replaceAll && matches.length > 1) {
    throw new Error(
      `The text to replace occurs ${matches.length} times. Include more surrounding text or set replaceAll=true.`,
    );
  }
  const rawMatches = matches.map((match) =>
    current.slice(
      projection.boundaries[match.start] ?? match.start,
      projection.boundaries[match.end] ?? match.end,
    ),
  );
  if (replaceAll && new Set(rawMatches).size > 1) return null;
  return rawMatches[0] ?? null;
}

function projectAuthoredText(value: string): {
  text: string;
  boundaries: number[];
  linkedMentions: string[];
} {
  const tokenPattern = /<br\s*\/?>|\[([^\]\n]+)\]\(([^)\n]+)\)/giu;
  let text = '';
  const boundaries = [0];
  const linkedMentions: string[] = [];
  let cursor = 0;
  const appendLiteral = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) {
      text += value[index] ?? '';
      boundaries.push(index + 1);
    }
  };
  for (const match of value.matchAll(tokenPattern)) {
    const start = match.index;
    const raw = match[0];
    const end = start + raw.length;
    appendLiteral(cursor, start);
    if (/^<br\s*\/?>$/iu.test(raw)) {
      text += '\n';
      boundaries.push(end);
    } else {
      const label = match[1] ?? '';
      const destination = match[2] ?? '';
      if (!isInternalAuthoredLink(destination)) {
        appendLiteral(start, end);
      } else {
        linkedMentions.push(authoredLinkDomainTarget(destination, label));
        for (let index = 0; index < label.length; index += 1) {
          text += label[index] ?? '';
          boundaries.push(index === label.length - 1 ? end : start + 1 + index + 1);
        }
      }
    }
    cursor = end;
  }
  appendLiteral(cursor, value.length);
  return { text, boundaries, linkedMentions };
}

function internalAuthoredLinks(value: string): Array<{
  raw: string;
  label: string;
}> {
  return [...value.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/gu)].flatMap((match) =>
    isInternalAuthoredLink(match[2] ?? '')
      ? [{ raw: match[0], label: match[1] ?? '' }]
      : [],
  );
}

function isInternalAuthoredLink(destination: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(destination.trim())?.[1]?.toLowerCase();
  return !scheme || !['http', 'https', 'mailto', 'tel'].includes(scheme);
}

function authoredLinkDomainTarget(destination: string, fallbackLabel: string): string {
  const normalized = destination.trim();
  const fragment = normalized.includes('#') ? normalized.slice(normalized.lastIndexOf('#') + 1) : '';
  const pathSegments = normalized.split('#', 1)[0]!.split('/').filter(Boolean);
  const pathName = pathSegments[pathSegments.length - 1]?.replace(/\.md$/iu, '');
  const candidate = fragment || pathName || fallbackLabel;
  try {
    return stripInlinePresentation(decodeURIComponent(candidate));
  } catch {
    return stripInlinePresentation(candidate);
  }
}

function stripInlinePresentation(value: string): string {
  return value
    .replace(/^\*{1,2}|\*{1,2}$/gu, '')
    .replace(/^~~|~~$/gu, '')
    .replace(/^<u>|<\/u>$/giu, '')
    .replace(/\\([\\`*{}\[\]()#+.!_>-])/gu, '$1')
    .trim();
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
    const matches = findReplacementMatches(next, replacement.oldText).map((match) =>
      includeCompatibleStructuralPrefix(next, match, replacement.oldText, replacement.newText),
    );
    if (matches.length === 0) {
      throw new Error(
        'STALE_EDIT_TARGET: The text to replace was not found in the current file. ' +
          'Re-read the latest file and copy the current text; do not retry the identical edit. ' +
          previewText(replacement.oldText),
      );
    }
    if (!replacement.replaceAll && matches.length !== 1) {
      throw new Error(
        `The text to replace occurs ${matches.length} times. Include more surrounding text or set replaceAll=true.`,
      );
    }
    const selected = replacement.replaceAll ? matches : matches.slice(0, 1);
    for (const match of [...selected].reverse()) {
      next = next.slice(0, match.start) + replacement.newText + next.slice(match.end);
    }
  }
  if (next === normalizeLineEndings(content)) {
    throw new Error('The requested replacements do not change the file');
  }
  return next;
}

interface ReplacementMatch {
  start: number;
  end: number;
}

function includeCompatibleStructuralPrefix(
  content: string,
  match: ReplacementMatch,
  oldText: string,
  newText: string,
): ReplacementMatch {
  if (structuralPrefixKind(oldText)) return match;
  const nextKind = structuralPrefixKind(newText);
  if (!nextKind) return match;
  const lineStart = content.lastIndexOf('\n', match.start - 1) + 1;
  const existingPrefix = content.slice(lineStart, match.start);
  if (structuralPrefixKind(existingPrefix) !== nextKind) return match;
  return { start: lineStart, end: match.end };
}

function structuralPrefixKind(
  value: string,
): 'heading' | 'blockquote' | 'code' | 'bullet' | 'ordered' | null {
  if (/^\s{0,3}#{1,6}[\t ]+/u.test(value)) return 'heading';
  if (/^\s{0,3}>[\t ]?/u.test(value)) return 'blockquote';
  if (/^`[\t ]?/u.test(value)) return 'code';
  if (/^-[\t ]+/u.test(value)) return 'bullet';
  if (/^1\.[\t ]+/u.test(value)) return 'ordered';
  return null;
}

/**
 * Models commonly normalize quote styles, add paragraph-leading indentation,
 * or omit invisible line-end spaces while replaying prose they just read.
 * Treat only those presentation differences as equivalent, and only after an
 * exact lookup misses. This keeps edit_file deterministic: wording, paragraph
 * boundaries, other punctuation, and occurrence cardinality must still match.
 */
function findReplacementMatches(content: string, oldText: string): ReplacementMatch[] {
  const exact = occurrenceIndexes(content, oldText);
  if (exact.length > 0) {
    return exact.map((start) => ({
      start,
      end: includeInvisibleLineEndWhitespace(content, start + oldText.length),
    }));
  }

  const comparableContent = comparableEditText(content);
  const comparableOldText = comparableEditText(oldText);
  if (
    (comparableContent.changed || comparableOldText.changed) &&
    comparableOldText.text
  ) {
    const comparableMatches = occurrenceIndexes(
      comparableContent.text,
      comparableOldText.text,
    ).map((index) => {
      const start = comparableContent.starts[index]!;
      const finalIndex = index + comparableOldText.text.length - 1;
      let end = comparableContent.ends[finalIndex]!;
      end = includeInvisibleLineEndWhitespace(content, end);
      return { start, end };
    });
    if (comparableMatches.length > 0) return comparableMatches;
  }

  // Long prose fragments are often replayed with one transport-level quote
  // omitted or with paragraph whitespace folded into a single line. Those
  // differences are not editorial intent. Reconcile them only when a long,
  // punctuation-preserving signature identifies exactly one current span.
  // Short or ambiguous fragments still fail closed.
  const semanticContent = semanticComparableEditText(content);
  const semanticOldText = semanticComparableEditText(oldText);
  if (semanticOldText.text.length < MIN_SEMANTIC_EDIT_SIGNATURE_LENGTH) return [];
  const semanticIndexes = occurrenceIndexes(semanticContent.text, semanticOldText.text);
  if (semanticIndexes.length !== 1) return [];
  return semanticIndexes.map((index) => {
    let start = semanticContent.starts[index]!;
    const finalIndex = index + semanticOldText.text.length - 1;
    let end = semanticContent.ends[finalIndex]!;
    if ((semanticOldText.starts[0] ?? 0) > 0) {
      while (start > 0 && isSemanticBoundaryIgnorable(content[start - 1]!)) start -= 1;
    }
    if (
      (semanticOldText.ends[semanticOldText.ends.length - 1] ?? oldText.length) <
      oldText.length
    ) {
      while (end < content.length && isSemanticBoundaryIgnorable(content[end]!)) end += 1;
    }
    end = includeInvisibleLineEndWhitespace(content, end);
    return { start, end };
  });
}

const MIN_SEMANTIC_EDIT_SIGNATURE_LENGTH = 24;

/**
 * A second, deliberately narrow reconciliation view for long prose spans.
 * It removes only whitespace and quotation marks. Sentence punctuation and
 * every authored word remain byte-significant, so a stale rewrite or a
 * different sentence cannot silently match.
 */
function semanticComparableEditText(value: string): ComparableEditText {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let changed = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (/\s/u.test(char) || isQuoteGlyph(char)) {
      changed = true;
      continue;
    }
    text += char;
    starts.push(index);
    ends.push(index + 1);
  }
  return { text, starts, ends, changed };
}

function includeInvisibleLineEndWhitespace(value: string, end: number): number {
  const whitespaceEnd = horizontalWhitespaceRunEnd(value, end);
  return whitespaceEnd > end && (whitespaceEnd === value.length || value[whitespaceEnd] === '\n')
    ? whitespaceEnd
    : end;
}

function occurrenceIndexes(value: string, needle: string): number[] {
  const indexes: number[] = [];
  let offset = 0;
  while (offset <= value.length - needle.length) {
    const found = value.indexOf(needle, offset);
    if (found < 0) break;
    indexes.push(found);
    offset = found + Math.max(1, needle.length);
  }
  return indexes;
}

interface ComparableEditText {
  text: string;
  starts: number[];
  ends: number[];
  changed: boolean;
}

function comparableEditText(value: string): ComparableEditText {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let changed = false;
  for (let index = 0; index < value.length; ) {
    const whitespaceEnd = horizontalWhitespaceRunEnd(value, index);
    if (
      whitespaceEnd > index &&
      (index === 0 || value[index - 1] === '\n')
    ) {
      changed = true;
      index = whitespaceEnd;
      continue;
    }
    if (
      whitespaceEnd > index &&
      (whitespaceEnd === value.length || value[whitespaceEnd] === '\n')
    ) {
      changed = true;
      index = whitespaceEnd;
      continue;
    }
    const char = value[index]!;
    const comparable = comparableQuoteGlyph(char);
    if (comparable !== char) changed = true;
    text += comparable;
    starts.push(index);
    ends.push(index + 1);
    index += 1;
  }
  return { text, starts, ends, changed };
}

function horizontalWhitespaceRunEnd(value: string, start: number): number {
  let end = start;
  while (end < value.length && /[\t \u00a0\u3000]/u.test(value[end]!)) end += 1;
  return end;
}

function comparableQuoteGlyph(value: string): string {
  if (isQuoteGlyph(value)) return '"';
  return value;
}

function isQuoteGlyph(value: string): boolean {
  return /["'“”„‟＂‘’‚‛＇「」『』]/u.test(value);
}

function isSemanticBoundaryIgnorable(value: string): boolean {
  return isQuoteGlyph(value) || /[\t \u00a0\u3000]/u.test(value);
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
  return planWorkspaceProseFileWrite({
    blocks: input.blocks,
    content: afterText,
    idempotencyKey: input.idempotencyKey,
  });
}

/**
 * Replace a complete virtual prose file, including an empty manuscript. This
 * shares the same identity-preserving planner as edit_file but does not invent
 * an impossible non-empty oldText for a blank document.
 */
export async function planWorkspaceProseFileWrite(input: {
  blocks: readonly YjsProseBlock[];
  content: string;
  idempotencyKey: string;
}): Promise<YjsProseOperation> {
  const requestedBlocks = parseAgentProseMarkdown(input.content);
  const beforeKeys = input.blocks.map(workspaceProseBlockMatchKey);
  const requestedKeys = requestedBlocks.map(agentMarkdownBlockMatchKey);
  const exactPairs = longestCommonSubsequencePairs(beforeKeys, requestedKeys);
  const desiredBlocks: YjsProseBlock[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  let inserted = 0;

  for (const [oldMatch, newMatch] of [
    ...exactPairs,
    [input.blocks.length, requestedBlocks.length] as [number, number],
  ]) {
    const oldGap = input.blocks.slice(oldCursor, oldMatch);
    const newGap = requestedBlocks.slice(newCursor, newMatch);
    const paired = Math.min(oldGap.length, newGap.length);
    for (let index = 0; index < paired; index += 1) {
      desiredBlocks.push(blockWithAgentMarkdown(oldGap[index]!, newGap[index]!));
    }
    for (let index = paired; index < newGap.length; index += 1) {
      desiredBlocks.push(
        await newBlockFromAgentMarkdown(
          newGap[index]!,
          await deterministicBlockId(input.idempotencyKey, inserted),
        ),
      );
      inserted += 1;
    }
    if (oldMatch < input.blocks.length && newMatch < requestedBlocks.length) {
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
  return renderAgentProseMarkdownBlock(workspaceBlockToAgentMarkdown(block));
}

function workspaceProseBlockMatchKey(block: YjsProseBlock): string {
  const rendered = renderWorkspaceProseBlock(block);
  return isSchemaAllowedWorkspaceBlock(block)
    ? `allowed:${rendered}`
    : `legacy:${block.type}:${rendered}`;
}

function agentMarkdownBlockMatchKey(block: AgentMarkdownBlock): string {
  return `allowed:${renderAgentProseMarkdownBlock(block)}`;
}

function isSchemaAllowedWorkspaceBlock(block: YjsProseBlock): boolean {
  if (block.type === 'heading') return headingLevel(block) !== null;
  return (
    block.type === 'paragraph' ||
    block.type === 'blockquote' ||
    block.type === 'horizontalRule'
  );
}

function workspaceBlockToAgentMarkdown(block: YjsProseBlock): AgentMarkdownBlock {
  if (block.type === 'horizontalRule') return { type: 'horizontalRule', inline: [] };
  const inline =
    block.type === 'blockquote'
      ? flattenYjsBlockquoteInline(block.content ?? [])
      : yjsNodesToAgentInline(block.content ?? []);
  if (block.type === 'heading') {
    const level = headingLevel(block);
    if (level) return { type: 'heading', level, inline };
  }
  if (block.type === 'blockquote') return { type: 'blockquote', inline };
  return { type: 'paragraph', inline };
}

function headingLevel(block: YjsProseBlock): 1 | 2 | 3 | null {
  const level = block.attrs?.level;
  if (level == null) return 1;
  return level === 1 || level === 2 || level === 3 ? level : null;
}

function flattenYjsBlockquoteInline(nodes: readonly YjsProseNode[]): AgentMarkdownInline[] {
  return nodes.flatMap((node, index) => [
    ...(index > 0 ? ([{ kind: 'hardBreak' }, { kind: 'hardBreak' }] as const) : []),
    ...(node.kind === 'text'
      ? yjsNodesToAgentInline([node])
      : yjsNodesToAgentInline(node.content ?? [])),
  ]);
}

function yjsNodesToAgentInline(nodes: readonly YjsProseNode[]): AgentMarkdownInline[] {
  const inline: AgentMarkdownInline[] = [];
  for (const node of nodes) {
    if (node.kind === 'element') {
      if (node.type === 'hardBreak') inline.push({ kind: 'hardBreak' });
      else inline.push(...yjsNodesToAgentInline(node.content ?? []));
      continue;
    }
    const marks = yjsMarksToAgentMarkdown(node.marks);
    inline.push({
      kind: 'text',
      text: node.text,
      ...(Object.keys(marks).length > 0 ? { marks } : {}),
    });
  }
  return inline;
}

function yjsMarksToAgentMarkdown(
  marks: YjsProseTextNode['marks'],
): AgentMarkdownMarks {
  if (!marks) return {};
  const linkRecord = marks.link;
  const link =
    linkRecord && typeof linkRecord === 'object' && !Array.isArray(linkRecord)
      ? normalizeAgentMarkdownLink(linkRecord.href)
      : null;
  return {
    ...(marks.bold ? { bold: true } : {}),
    ...(marks.italic ? { italic: true } : {}),
    ...(marks.strike ? { strike: true } : {}),
    ...(marks.underline ? { underline: true } : {}),
    ...(link ? { link } : {}),
  };
}

function blockWithAgentMarkdown(
  block: YjsProseBlock,
  parsed: AgentMarkdownBlock,
): YjsProseBlock {
  if (parsed.type !== block.type) {
    return makeBlock(block.id, parsed, undefined);
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
          ...(parsed.inline.length > 0
            ? {
                content: agentInlineHasFormatting(parsed.inline)
                  ? preserveOpaqueInlineMarks(
                      current,
                      agentMarkdownInlineToYjs(parsed.inline),
                    )
                  : replaceMarkedText(current, agentInlinePlainText(parsed.inline)),
              }
            : {}),
        },
      ],
    };
  }
  if (block.type === 'paragraph' || block.type === 'heading') {
    return {
      ...block,
      ...(block.type === 'heading' && parsed.type === 'heading'
        ? { attrs: { ...(block.attrs ?? {}), level: parsed.level } }
        : {}),
      content:
        parsed.inline.length === 0
          ? []
          : agentInlineHasFormatting(parsed.inline)
            ? preserveOpaqueInlineMarks(
                block.content ?? [],
                agentMarkdownInlineToYjs(parsed.inline),
              )
            : replaceMarkedText(block.content ?? [], agentInlinePlainText(parsed.inline)),
    };
  }
  if (block.type === 'horizontalRule') return { ...block, content: [] };
  return makeBlock(block.id, parsed, undefined);
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

function agentInlineHasFormatting(inline: readonly AgentMarkdownInline[]): boolean {
  return inline.some(
    (node) => node.kind === 'hardBreak' || (node.marks && Object.keys(node.marks).length > 0),
  );
}

function agentInlinePlainText(inline: readonly AgentMarkdownInline[]): string {
  return inline.map((node) => (node.kind === 'hardBreak' ? '\n' : node.text)).join('');
}

function agentMarkdownInlineToYjs(inline: readonly AgentMarkdownInline[]): YjsProseNode[] {
  return inline.flatMap((node): YjsProseNode[] => {
    if (node.kind === 'hardBreak') return [{ kind: 'element', type: 'hardBreak' }];
    if (!node.text) return [];
    const marks: Record<string, NonNullable<YjsProseTextNode['marks']>[string]> = {};
    if (node.marks?.bold) marks.bold = {};
    if (node.marks?.italic) marks.italic = {};
    if (node.marks?.strike) marks.strike = {};
    if (node.marks?.underline) marks.underline = {};
    const link = normalizeAgentMarkdownLink(node.marks?.link);
    if (link) marks.link = { href: link };
    return [
      {
        kind: 'text',
        text: node.text,
        ...(Object.keys(marks).length > 0 ? { marks } : {}),
      },
    ];
  });
}

const AGENT_MARK_NAMES = new Set(['bold', 'italic', 'strike', 'underline', 'link']);

/**
 * Entity links and future editor-only marks are intentionally invisible in the
 * virtual Markdown file. When the model edits visible Markdown styling, keep
 * those opaque marks on unchanged prefix/suffix text instead of silently
 * deleting product semantics that the model could not see.
 */
function preserveOpaqueInlineMarks(
  previous: readonly YjsProseNode[],
  desired: readonly YjsProseNode[],
): YjsProseNode[] {
  if (!previous.every(isFlatInlineNode) || !desired.every(isFlatInlineNode)) return [...desired];
  const oldText = yjsInlinePlainText(previous);
  const newText = yjsInlinePlainText(desired);
  let prefix = 0;
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldText.length - prefix &&
    suffix < newText.length - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const opaqueByOldOffset: Array<YjsProseTextNode['marks']> = [];
  for (const node of previous) {
    if (node.kind === 'element') {
      opaqueByOldOffset.push(undefined);
      continue;
    }
    const opaque = opaqueMarks(node.marks);
    for (let index = 0; index < node.text.length; index += 1) opaqueByOldOffset.push(opaque);
  }

  const output: YjsProseNode[] = [];
  let newOffset = 0;
  for (const node of desired) {
    if (node.kind === 'element') {
      output.push(node);
      newOffset += 1;
      continue;
    }
    for (let index = 0; index < node.text.length; index += 1) {
      const absolute = newOffset + index;
      const oldOffset =
        absolute < prefix
          ? absolute
          : absolute >= newText.length - suffix
            ? oldText.length - (newText.length - absolute)
            : null;
      const opaque = oldOffset === null ? undefined : opaqueByOldOffset[oldOffset];
      output.push({
        kind: 'text',
        text: node.text[index]!,
        ...mergeYjsMarks(node.marks, opaque),
      });
    }
    newOffset += node.text.length;
  }
  return mergeYjsInlineNodes(output);
}

function isFlatInlineNode(node: YjsProseNode): boolean {
  return node.kind === 'text' || node.type === 'hardBreak';
}

function yjsInlinePlainText(nodes: readonly YjsProseNode[]): string {
  return nodes.map((node) => (node.kind === 'text' ? node.text : '\n')).join('');
}

function opaqueMarks(marks: YjsProseTextNode['marks']): YjsProseTextNode['marks'] {
  if (!marks) return undefined;
  const opaque = Object.fromEntries(
    Object.entries(marks).filter(([name]) => !AGENT_MARK_NAMES.has(name)),
  );
  return Object.keys(opaque).length > 0 ? opaque : undefined;
}

function mergeYjsMarks(
  visible: YjsProseTextNode['marks'],
  opaque: YjsProseTextNode['marks'],
): Pick<YjsProseTextNode, 'marks'> | Record<string, never> {
  const marks = { ...(visible ?? {}), ...(opaque ?? {}) };
  return Object.keys(marks).length > 0 ? { marks } : {};
}

function mergeYjsInlineNodes(nodes: readonly YjsProseNode[]): YjsProseNode[] {
  const merged: YjsProseNode[] = [];
  for (const node of nodes) {
    const previous = merged[merged.length - 1];
    if (
      node.kind === 'text' &&
      previous?.kind === 'text' &&
      JSON.stringify(previous.marks ?? {}) === JSON.stringify(node.marks ?? {})
    ) {
      merged[merged.length - 1] = { ...previous, text: previous.text + node.text };
    } else {
      merged.push(node);
    }
  }
  return merged;
}

async function newBlockFromAgentMarkdown(
  block: AgentMarkdownBlock,
  id: string,
): Promise<YjsProseBlock> {
  return makeBlock(id, block, undefined);
}

function makeBlock(
  id: string,
  block: AgentMarkdownBlock,
  attrs: YjsProseBlock['attrs'],
): YjsProseBlock {
  if (block.type === 'blockquote') {
    return {
      id,
      type: block.type,
      ...(attrs ? { attrs } : {}),
      content: [
        {
          kind: 'element',
          type: 'paragraph',
          ...(block.inline.length > 0
            ? { content: agentMarkdownInlineToYjs(block.inline) }
            : {}),
        },
      ],
    };
  }
  if (block.type === 'horizontalRule') {
    return {
      id,
      type: block.type,
      ...(attrs ? { attrs } : {}),
      content: [],
    };
  }
  return {
    id,
    type: block.type,
    ...((attrs || block.type === 'heading')
      ? {
          attrs: {
            ...(attrs ?? {}),
            ...(block.type === 'heading' ? { level: block.level } : {}),
          },
        }
      : {}),
    content: agentMarkdownInlineToYjs(block.inline),
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

function previewText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  const preview = compact.length > 120 ? `${compact.slice(0, 117)}…` : compact;
  return JSON.stringify(preview);
}
