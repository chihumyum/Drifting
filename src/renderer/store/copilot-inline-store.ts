/**
 * copilot-inline-store — transient open/close state for the Cmd+I / context-
 * menu inline Copilot popover (the "输入框 + 菜单二合一" surface, Tasks 4/6/7).
 *
 * The editor resolves the target (selection, or the current block when there's
 * no selection) + nearby context + screen coords and calls open(); the popover
 * mounted in ChapterEditor renders when the context's nodeId matches its own
 * (so virtualized multi-chapter views only pop the right one).
 *
 * Not persisted — purely ephemeral UI state.
 */
import { create } from 'zustand';

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
  /** Blocks around the whole invocation region (before first / after last
   *  covered block), joined — local context the model must not edit. */
  nearbyContext: string;
  /** Rolling segment summaries overlapping the context window — the local
   *  narrative arc, for grounding the edit. */
  segmentSummaries: string[];
  /** Block ids covered by the selection (Task 6 capability runs). Empty in
   *  'block' mode — those run on the rolling context (Task 7). */
  selectionBlockIds: string[];
  /** Viewport coords to anchor the popover near the selection/caret. */
  clientX: number;
  clientY: number;
}

interface CopilotInlineState {
  ctx: CopilotInlineCtx | null;
  open: (ctx: CopilotInlineCtx) => void;
  close: () => void;
}

export const useCopilotInlineStore = create<CopilotInlineState>((set) => ({
  ctx: null,
  open: (ctx) => set({ ctx }),
  close: () => set({ ctx: null }),
}));
