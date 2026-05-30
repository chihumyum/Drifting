/**
 * Inline-edit runner — the manual, local "improve this span" capability
 * (Cmd+Shift+I / copilot menu input box). Unlike the debounced capabilities, this
 * is NOT a registered CopilotCapability: it's interactive (takes a free-text
 * instruction, applies its result straight back into the editor) and so
 * doesn't fit the detect()→persist-comment→accept lifecycle. The popover UI
 * calls runInlineEdit() directly.
 *
 * Two shapes of edit, picked by the target:
 *   - SPAN: a partial selection inside one block (a few words). We revise just
 *     that span (inlineEditPrompt) and replace [from,to] in place.
 *   - BLOCKS: a multi-block / whole-block / Cmd+A target. We revise it block by
 *     block (inlineEditBlocksPrompt → one entry per block) and replace each
 *     block's content in place, preserving its type/id. This is what stops the
 *     old "many paragraphs collapse into one" bug: structure is explicit on
 *     both the model and the apply side, and the apply is a single, clean,
 *     undoable transaction.
 *
 * Guard against scope creep into ghostwriting lives in two layers:
 *   1. A cheap client-side pre-filter here (instructionRequestsNewContent)
 *      short-circuits the unambiguous "continue the story" asks without
 *      spending a model call.
 *   2. The prompt itself refuses the nuanced ones (output.refused).
 * Both are bypassed when the author opts into allowNewContent.
 */
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { runStructured } from '../ai/remote/run-structured';
import { inlineEditPrompt } from '../ai/prompts/templates/inline-edit';
import { inlineEditBlocksPrompt } from '../ai/prompts/templates/inline-edit-blocks';
import type { InlineTargetBlock } from '../../store/copilot-inline-store';
import { diffChars, type DiffChunk } from './text-diff';

export interface InlineEditTarget {
  /** True for a partial span inside one block; false for a block-level target. */
  spanWithinBlock: boolean;
  /** Span mode — document position of the span start (ProseMirror absolute pos). */
  from: number;
  /** Span mode — document position of the span end. */
  to: number;
  /** Span mode — plain text of the span [from, to]. */
  selectedText: string;
  /** Span mode — enclosing block text, for context. Empty in block mode. */
  blockContext: string;
  /** Block mode — the whole blocks to revise, in doc order. */
  targetBlocks: InlineTargetBlock[];
  /** Blocks above the target region (上文), for local context. */
  contextBefore?: string;
  /** Blocks below the target region (下文), for local context. */
  contextAfter?: string;
  /** Rolling segment summaries overlapping the region, for arc grounding. */
  segmentSummaries?: string[];
}

/** One block's before/after in a block-level edit. */
export interface InlineEditBlockChange {
  /** BlockId of the block in the live doc — how apply locates it. */
  id: string;
  /** 'heading' | 'paragraph' — for the panel label. */
  kind: string;
  oldText: string;
  newText: string;
  /** Whether the model actually changed this block. */
  changed: boolean;
  /** Character-level diff for the panel display. */
  diff: DiffChunk[];
}

export interface InlineEditResult {
  /** True when a new-content request was declined (no edit applied). */
  refused: boolean;
  /** Short note: why it refused, or what it changed. */
  reason: string;
  /** Block-level result (multi-block / whole-block targets). */
  blocks?: InlineEditBlockChange[];
  /** Span-level result (a partial selection within one block). */
  span?: {
    from: number;
    to: number;
    oldText: string;
    newText: string;
    diff: DiffChunk[];
  };
}

/**
 * Phrases that unambiguously request NEW story content. When the author
 * hasn't opted into new-content generation we refuse these without a model
 * call. Deliberately conservative — only the clear "write more" asks. The
 * model makes the nuanced call for everything else.
 */
const NEW_CONTENT_PATTERNS: RegExp[] = [
  /续写|接着写|往下写|写下去|后续剧情|接下来(发生|写)|加一?段|新增一?段|添一?段|扩写|展开剧情|编一?个|虚构一?个|脑补|帮我想/,
  /\bcontinue\b|what happens next|write (the )?(next|more)|add a (new )?(scene|paragraph|chapter)|expand the (plot|story)|make up|invent (a|an)/i,
];

/** Does this instruction read as a request to generate new content? */
export function instructionRequestsNewContent(instruction: string): boolean {
  return NEW_CONTENT_PATTERNS.some((re) => re.test(instruction));
}

/** Collapse internal whitespace the way block text is stored, so "changed"
 *  detection and diffs ignore incidental reflowing. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export async function runInlineEdit(params: {
  target: InlineEditTarget;
  instruction: string;
  allowNewContent: boolean;
  /** Project whose output-language setting governs this edit's language. */
  projectId: string;
  signal?: AbortSignal;
}): Promise<InlineEditResult> {
  const { target, instruction, allowNewContent, projectId, signal } = params;

  // Pre-flight refusal — skip the model entirely on an obvious new-content ask.
  if (!allowNewContent && instructionRequestsNewContent(instruction)) {
    return {
      refused: true,
      reason:
        '行内修改只做局部润色，不生成新情节。如需续写，请在设置中开启“允许生成新内容”' +
        '（会因缺少全局上下文而降低质量）。',
    };
  }

  // SPAN MODE — revise just the selected sub-span of one block.
  if (target.spanWithinBlock) {
    const out = await runStructured(
      inlineEditPrompt,
      {
        instruction,
        selectedText: target.selectedText,
        blockContext: target.blockContext,
        contextBefore: target.contextBefore,
        contextAfter: target.contextAfter,
        priorSummaries: target.segmentSummaries,
        allowNewContent,
      },
      { signal, projectId },
    );
    if (out.refused) return { refused: true, reason: out.reason };
    const oldText = target.selectedText;
    const newText = out.editedText;
    return {
      refused: false,
      reason: out.reason,
      span: { from: target.from, to: target.to, oldText, newText, diff: diffChars(oldText, newText) },
    };
  }

  // BLOCK MODE — revise the covered blocks one-for-one.
  const inputBlocks = target.targetBlocks.map((b, i) => ({
    index: i + 1,
    kind: b.kind,
    text: b.text,
  }));
  const out = await runStructured(
    inlineEditBlocksPrompt,
    {
      instruction,
      blocks: inputBlocks,
      contextBefore: target.contextBefore,
      contextAfter: target.contextAfter,
      priorSummaries: target.segmentSummaries,
      allowNewContent,
    },
    { signal, projectId },
  );
  if (out.refused) return { refused: true, reason: out.reason };

  // Map the model's blocks back to ours by 1-based index. A missing index =
  // the model left that block untouched. Extra indices (a split) are ignored —
  // block mode edits in place and never invents new blocks.
  const byIndex = new Map<number, string>();
  for (const ob of out.blocks) {
    if (typeof ob.index === 'number' && !byIndex.has(ob.index)) byIndex.set(ob.index, ob.text);
  }
  const blocks: InlineEditBlockChange[] = target.targetBlocks.map((b, i) => {
    const raw = byIndex.has(i + 1) ? byIndex.get(i + 1)! : b.text;
    const newText = normalize(raw);
    return {
      id: b.id,
      kind: b.kind,
      oldText: b.text,
      newText,
      changed: newText !== b.text,
      diff: diffChars(b.text, newText),
    };
  });

  return { refused: false, reason: out.reason, blocks };
}

/**
 * Apply an inline-edit result to the live editor. Dispatches by shape; both
 * shapes commit as ONE ProseMirror transaction, so a single Cmd+Z restores the
 * prior text. Returns false if the target is no longer valid.
 */
export function applyInlineEdit(editor: Editor, result: InlineEditResult): boolean {
  if (result.refused) return false;
  if (result.span) return applySpan(editor, result.span);
  if (result.blocks) return applyBlocks(editor, result.blocks);
  return false;
}

/** Replace a partial span [from,to] inside one block. */
function applySpan(
  editor: Editor,
  span: { from: number; to: number; newText: string },
): boolean {
  const { from, to, newText } = span;
  const docSize = editor.state.doc.content.size;
  if (from < 0 || to > docSize || from > to) return false;
  // One block → a stray newline can't become a paragraph break, so flatten it.
  const text = newText.replace(/\s*\n\s*/g, ' ').trim();
  if (!text) return editor.chain().focus().deleteRange({ from, to }).run();
  return editor.chain().focus().insertContentAt({ from, to }, text).run();
}

/**
 * Replace each changed block's content IN PLACE, located by its BlockId. The
 * block node itself (type, heading level, id, alignment) is untouched — only
 * its inline content is swapped — so headings stay headings and blocks never
 * collapse. All edits go in one transaction, applied back-to-front so earlier
 * positions stay valid. Because no blocks are added/removed, the BlockId
 * extension's id-backfill (an addToHistory:false transaction) never fires over
 * this edit, which keeps the Yjs undo entry clean and Cmd+Z working.
 */
function applyBlocks(editor: Editor, blocks: InlineEditBlockChange[]): boolean {
  const changed = blocks.filter((b) => b.changed);
  if (changed.length === 0) return true; // nothing to apply — treat as a no-op success

  const { state } = editor;
  const { schema } = state;

  // Locate every editable block by id in the CURRENT doc.
  const posById = new Map<string, { pos: number; node: PMNode }>();
  state.doc.descendants((node, pos) => {
    const id = node.attrs?.id as string | undefined;
    if (node.isTextblock && id) posById.set(id, { pos, node });
    return true;
  });

  const edits = changed
    .map((b) => ({ b, loc: posById.get(b.id) }))
    .filter((e): e is { b: InlineEditBlockChange; loc: { pos: number; node: PMNode } } => !!e.loc)
    .sort((a, b) => b.loc.pos - a.loc.pos); // back-to-front

  if (edits.length === 0) return false; // none of the target blocks still exist

  const tr = state.tr;
  for (const { b, loc } of edits) {
    const start = loc.pos + 1;
    const end = loc.pos + loc.node.nodeSize - 1;
    if (b.newText) tr.replaceWith(start, end, schema.text(b.newText));
    else tr.delete(start, end);
  }

  editor.view.focus();
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}
