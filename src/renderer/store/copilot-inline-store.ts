/**
 * copilot-inline-store — transient open/close state for the Cmd+Shift+I / context-
 * menu inline Copilot popover (the "输入框 + 菜单二合一" surface, Tasks 4/6/7).
 *
 * The editor resolves the target (selection, or the current block when there's
 * no selection) + nearby context + screen coords and calls open(); the popover
 * mounted in ChapterEditor renders when the context's project/node matches its own
 * (so virtualized multi-chapter views only pop the right one).
 *
 * Not persisted — purely ephemeral UI state.
 */
import { create } from 'zustand';
import type { InlineEditSpanSource } from '../lib/copilot/inline-edit-apply';

/** One whole block in the inline-edit target region, used by the block-by-block
 *  edit pipeline (multi-block / whole-block / Cmd+A targets). */
export interface InlineTargetBlock {
  /** BlockId of the block in the live doc — how apply locates it again. */
  id: string;
  /** 'heading' | 'paragraph' — preserved across the edit. */
  kind: string;
  /** Heading level, when kind is 'heading'. */
  level?: number;
  /** Block's current plain text. */
  text: string;
  /** Exact original node, including marks/attrs; local apply precondition only. */
  sourceJson: string;
}

export interface CopilotInlineCtx {
  /** Chapter (BookNode) this invocation belongs to — disambiguates which
   *  mounted popover renders, and scopes manual-run capability events. */
  nodeId: string;
  projectId: string;
  /** 'selection' = revise the selected span; 'block' = no selection, so the
   *  current block is the inline-edit target. */
  mode: 'selection' | 'block';
  /** Inline-edit target span (ProseMirror absolute positions). */
  from: number;
  to: number;
  /** Text of the target span (selection, or the whole current block). */
  selectedText: string;
  /** Enclosing block's plain text, for model context + display. */
  blockContext: string;
  /** Blocks ABOVE the invocation region (上文) — the INLINE_CONTEXT_WINDOW
   *  blocks before the first covered block, joined. Local context, never
   *  edited. Kept separate from contextAfter so the model can place the
   *  target between its 上文 and 下文 instead of one undifferentiated blob. */
  contextBefore: string;
  /** Blocks BELOW the invocation region (下文) — the INLINE_CONTEXT_WINDOW
   *  blocks after the last covered block, joined. Local context, never edited. */
  contextAfter: string;
  /** Rolling segment summaries overlapping the context window — the local
   *  narrative arc, for grounding the edit. */
  segmentSummaries: string[];
  /** Block ids covered by the selection (Task 6 capability runs). Empty in
   *  'block' mode — those run on the rolling context (Task 7). */
  selectionBlockIds: string[];
  /** Whole blocks covered by this invocation, in doc order — the unit the
   *  block-by-block edit pipeline revises and applies. */
  targetBlocks: InlineTargetBlock[];
  /** True when the target is a partial span inside ONE block (e.g. a few
   *  selected words). Then we revise just that span, not whole blocks. */
  spanWithinBlock: boolean;
  /** Exact selected fragment and block identity; never included in model input. */
  spanSource: InlineEditSpanSource | null;
  /** Viewport coords to anchor the popover near the selection/caret. */
  clientX: number;
  clientY: number;
}

interface CopilotInlineState {
  ctx: CopilotInlineCtx | null;
  open: (ctx: CopilotInlineCtx) => void;
  /** An old owner may release only its own invocation. */
  close: (expected?: CopilotInlineCtx) => void;
}

export const useCopilotInlineStore = create<CopilotInlineState>((set) => ({
  ctx: null,
  open: (ctx) => set({ ctx }),
  close: (expected) => set(state => expected && state.ctx !== expected ? state : { ctx: null }),
}));
