/**
 * Inline-edit runner — the manual, local "improve this span" capability
 * (Cmd+I / copilot menu input box). Unlike the debounced capabilities, this
 * is NOT a registered CopilotCapability: it's interactive (takes a free-text
 * instruction, applies its result straight back into the editor) and so
 * doesn't fit the detect()→persist-comment→accept lifecycle. The popover UI
 * calls runInlineEdit() directly.
 *
 * Guard against scope creep into ghostwriting lives in two layers:
 *   1. A cheap client-side pre-filter here (instructionRequestsNewContent)
 *      short-circuits the unambiguous "continue the story" asks without
 *      spending a model call.
 *   2. The prompt itself refuses the nuanced ones (output.refused).
 * Both are bypassed when the author opts into allowNewContent.
 */
import type { Editor, Content } from '@tiptap/core';
import { callStructured } from '../ai/call-structured';
import { inlineEditPrompt } from '../ai/prompts/templates/inline-edit';
import { copilotRuntime } from './runtime';

export interface InlineEditTarget {
  /** Document position of the span start (ProseMirror absolute pos). */
  from: number;
  /** Document position of the span end. */
  to: number;
  /** Plain text of the span [from, to]. */
  selectedText: string;
  /** Plain text of the enclosing block, for context. */
  blockContext: string;
  /** Plain text of adjacent blocks, for local context. */
  nearbyContext?: string;
}

export interface InlineEditResult {
  from: number;
  to: number;
  originalText: string;
  editedText: string;
  /** True when a new-content request was declined (no edit applied). */
  refused: boolean;
  /** Short note: why it refused, or what it changed. */
  reason: string;
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

export async function runInlineEdit(params: {
  target: InlineEditTarget;
  instruction: string;
  allowNewContent: boolean;
  signal?: AbortSignal;
}): Promise<InlineEditResult> {
  const { target, instruction, allowNewContent, signal } = params;
  const base = {
    from: target.from,
    to: target.to,
    originalText: target.selectedText,
  };

  // Pre-flight refusal — skip the model entirely on an obvious new-content ask.
  if (!allowNewContent && instructionRequestsNewContent(instruction)) {
    return {
      ...base,
      editedText: target.selectedText,
      refused: true,
      reason:
        '行内修改只做局部润色，不生成新情节。如需续写，请在设置中开启“允许生成新内容”' +
        '（会因缺少全局上下文而降低质量）。',
    };
  }

  const client = await copilotRuntime.getClient();
  const out = await callStructured(
    client,
    inlineEditPrompt,
    {
      instruction,
      selectedText: target.selectedText,
      blockContext: target.blockContext,
      nearbyContext: target.nearbyContext,
      allowNewContent,
    },
    { signal },
  );

  return {
    ...base,
    editedText: out.editedText,
    refused: out.refused,
    reason: out.reason,
  };
}

/**
 * Replace the target span with the edited text in the live editor, as ONE
 * transaction (so a single Cmd+Z restores the original). Preserves block
 * structure: a within-block edit stays one block (newlines flattened to
 * spaces); a multi-block selection is rebuilt as separate paragraphs instead
 * of collapsing into one. Returns false if the range is no longer valid.
 */
export function applyInlineEdit(
  editor: Editor,
  result: Pick<InlineEditResult, 'from' | 'to' | 'editedText'>,
): boolean {
  const { from, to, editedText } = result;
  const docSize = editor.state.doc.content.size;
  if (from < 0 || to > docSize || from > to) return false;

  const $from = editor.state.doc.resolve(from);
  const $to = editor.state.doc.resolve(to);
  const singleBlock = $from.sameParent($to);

  let content: Content;
  if (singleBlock) {
    // One block: a stray newline would be dropped by a plain-text insert, so
    // flatten it to a space and keep the span as inline text.
    content = editedText.replace(/\s*\n\s*/g, ' ').trim();
  } else {
    // Spanned multiple blocks: rebuild as separate paragraphs so block
    // boundaries survive instead of squashing into a single paragraph.
    const paragraphs = editedText
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }));
    content = paragraphs.length > 0 ? paragraphs : '';
  }

  // Single insertContentAt = one history entry. addToHistory defaults true, so
  // the Yjs/ProseMirror undo manager captures it and Cmd+Z restores the prior
  // text.
  return editor.chain().focus().insertContentAt({ from, to }, content).run();
}
