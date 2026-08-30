/**
 * CopilotCapability — the framework boundary that lets each Copilot feature
 * (element-candidate detection, element-patch proposals, inline-rewrite, …)
 * plug in without touching the runner, the comment integration, the
 * settings UI, or the suggestion lifecycle code.
 *
 * Capabilities are register-once units. The framework (runtime + useCopilot
 * hook + shared Review card) treats them opaquely:
 *
 *   ┌── feature-agnostic ──────────────────────────────────────────────────┐
 *   │  useCopilot → runs detect() on debounced editor updates              │
 *   │  ReviewItemCard → renderSummary() + accept() / reject hooks          │
 *   │  Settings AI panel → lists capabilities for per-feature toggles      │
 *   │  Metering → tags requests with capability.id                         │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * Adding a new capability is: implement this interface, register it at
 * bootstrap, done. The framework needs no edits.
 *
 * Trigger types are deliberately small and additive. Today only
 * `editor-block-debounced` is wired; later capabilities (inline-chat,
 * future workflows) may need 'manual', 'editor-block-on-leave', 'scene-on-save'.
 */
import type { Editor } from '@tiptap/core';
import type { BookElement } from '../../domain/book-element';
import type {
  AcceptCopilotResult,
  CopilotSuggestionMetadata,
} from '../../domain/copilot-suggestion';
import type {
  Comment,
  CommentTargetKind,
} from '../../domain/comment';
import type { LLMClient } from '../ai/client/llm-client';
import type { BaseBlockContext } from '../ai/context/types';
import type { BYOKProvider } from '../byok-keychain';

/**
 * Input to createElement — minimal shape capabilities need. Mirrors
 * usecase/useBookElement's CreateBookElementInput so we don't pull a hook
 * type into the framework boundary. categoryId is required (non-null);
 * capabilities that don't know the right category should pick a fallback
 * before calling this (e.g., first category in the project).
 */
export interface CreateElementInput {
  categoryId: string;
  name: string;
  /**
   * Optional initial summary. Element-candidate uses this to seed the new
   * element with the model's brief description; future capabilities can
   * leave it empty.
   */
  summary?: string;
}

/**
 * Services injected into capability accept handlers. Capabilities call
 * these instead of taking hook helpers directly — the hook layer
 * (ReviewItemCard) wires concrete React-bound implementations in.
 *
 * Additive: future capabilities will need more (applyPatch, replaceText,
 * etc.). Extending this interface doesn't break existing capabilities since
 * they only consume what they need.
 */
export interface CopilotServices {
  createElement(input: CreateElementInput): Promise<BookElement>;
}

/**
 * When a capability AUTO-runs. Each value corresponds to a runner the
 * framework knows how to wire to editor / app events.
 *
 *   - 'editor-block-debounced': fires on its own debounce after edits.
 *   - 'manual': never auto-fires; only runs when the user invokes it
 *     (Cmd+Shift+I / copilot menu). Note that 'editor-block-debounced' capabilities
 *     are ALSO manually runnable on demand — `trigger` describes the *auto*
 *     surface, not whether a capability can be hand-triggered.
 */
export type CopilotTrigger = 'editor-block-debounced' | 'manual';

/**
 * Capability-agnostic runtime services injected into every capability call.
 * Hides "where does the LLM client come from" etc. so capabilities don't
 * each re-implement credentials + caching.
 */
export interface CopilotRuntime {
  /** Get the shared LLM client. Lazy-built on first use; cached across capabilities. */
  getClient(provider?: BYOKProvider): Promise<LLMClient>;
  /** Invalidate the cached client (e.g. after the user changes their API key). */
  resetClient(): void;
}

/**
 * Context passed to `detect()`. The runner builds this per trigger fire and
 * hands the capability everything it needs to do its work.
 */
export interface CapabilityDetectContext {
  runtime: CopilotRuntime;
  editor: Editor;
  projectId: string;
  /** What the editor's content belongs to — passed straight to createCopilotSuggestion. */
  targetKind: CommentTargetKind;
  targetId: string;
  /**
   * Shared block context for this debounce — edited blocks + (PR C) prior
   * section summaries. Capabilities consume this directly instead of
   * re-extracting from the editor; framework-level concerns (which blocks
   * the user touched, which rolling summaries are still valid) stay out of
   * capability code.
   */
  baseContext: BaseBlockContext;
  /**
   * Free-text steer the user typed when MANUALLY running this capability
   * (Cmd+Shift+I / context menu). Undefined on automatic debounced fires.
   * Capabilities should pass it into their prompt as an optional bias —
   * never letting it override their hard rules. Lets the author lightly
   * direct an otherwise-autonomous task ("只关注地名", "重点看主角").
   */
  userInstruction?: string;
  /** Cancelled when the chapter triggers again or the editor unmounts. */
  signal: AbortSignal;
}

/**
 * One suggestion the capability wants persisted. The runner handles the
 * actual `createCopilotSuggestion` call so we don't duplicate persistence
 * code in every capability.
 */
export interface CapabilityDetectResult {
  metadata: CopilotSuggestionMetadata;
  /** Encoded CommentAnchorPayload — typically the evidence span. */
  anchorJson: string;
  /**
   * Override the comment's target block id. Default = focusBlockId from
   * detect context. Useful if a capability anchors its suggestion to a
   * different block than the trigger block.
   */
  overrideTargetBlockId?: string;
}

/**
 * Context passed to `accept()`. The runner has already loaded the comment
 * and decoded its metadata before calling this.
 */
export interface CapabilityAcceptContext {
  runtime: CopilotRuntime;
  /** Side-effect services the capability may use (createElement, …). */
  services: CopilotServices;
  comment: Comment;
  metadata: CopilotSuggestionMetadata;
  projectId: string;
  userId: string;
  /** May be null if accepted from outside an editor view (e.g. a global panel). */
  editor: Editor | null;
}

/**
 * What ReviewItemCard needs to render a copilot comment card. All fields are
 * advisory — the rail can fall back to a generic layout if `renderSummary`
 * returns nothing.
 */
export interface CapabilityRenderHint {
  title: string;
  subtitle?: string;
  /** A short verbatim excerpt to quote in the card (typically evidence). */
  evidence?: string;
  /** Label for the primary accept button (e.g. "Add as Character"). */
  actionLabel?: string;
}

export interface CopilotCapability {
  /**
   * Stable id used as the registry map key AND as the settings task-id
   * (see store/settings-store.ts CopilotTaskId). Must match one of the
   * pre-defined COPILOT_TASKS entries for the settings UI to surface it.
   */
  id: string;
  /**
   * Discriminator on `metadata.kind` — used by ReviewItemCard to look up
   * which capability owns a copilot comment. Decoupled from `id` because
   * settings ids ('elementExtract') and metadata kinds ('element-candidate')
   * carry different responsibilities and may evolve independently.
   */
  metadataKind: string;
  displayName: string;
  description: string;
  /** What event surface fires this capability. */
  trigger: CopilotTrigger;
  /**
   * Default debounce in ms when the user hasn't overridden in settings.
   * Capabilities tune their own default based on cost / cadence — cheap
   * frequent capabilities (element-candidate) want low values; heavy
   * reflection capabilities (element-patch) want high values. Settings UI
   * uses this as the initial slider value and as the "reset to default"
   * target.
   */
  defaultDebounceMs: number;

  /**
   * Run detection. Return zero or more suggestions to persist. Honor `signal`
   * — if it aborts, return early. Throw on irrecoverable error; the runner
   * will swallow `AIError('aborted')` and log others.
   */
  detect(ctx: CapabilityDetectContext): Promise<CapabilityDetectResult[]>;

  /**
   * Handle user-accept. Perform whatever side effect the capability owns
   * (create a BookElement, apply a patch, etc.) and return the result that
   * should be recorded on the `comment_action` row's resultJson.
   */
  accept(ctx: CapabilityAcceptContext): Promise<AcceptCopilotResult>;

  /** Optional: tell ReviewItemCard how to render this capability's cards. */
  renderSummary?(meta: CopilotSuggestionMetadata): CapabilityRenderHint;
}

// ─── Registry ────────────────────────────────────────────────────────────

const registry = new Map<string, CopilotCapability>();

/**
 * Register a capability. Called once at app bootstrap (see main.tsx).
 * Re-registering the same id is a programming error and logs a warning —
 * the new registration wins, but if you're seeing this in dev you've got
 * two boot paths fighting each other.
 */
export function registerCopilotCapability(capability: CopilotCapability): void {
  if (registry.has(capability.id)) {
    console.warn(
      `[copilot] capability "${capability.id}" re-registered — overwriting`,
    );
  }
  registry.set(capability.id, capability);
}

export function getCopilotCapability(id: string): CopilotCapability | null {
  return registry.get(id) ?? null;
}

export function allCopilotCapabilities(): CopilotCapability[] {
  return [...registry.values()];
}

export function capabilitiesForTrigger(trigger: CopilotTrigger): CopilotCapability[] {
  return allCopilotCapabilities().filter((c) => c.trigger === trigger);
}

/**
 * Look up the capability that owns a given metadata.kind. Used by
 * ReviewItemCard to dispatch render/accept for copilot-source comments.
 */
export function getCopilotCapabilityForMetadataKind(
  metadataKind: string,
): CopilotCapability | null {
  return allCopilotCapabilities().find((c) => c.metadataKind === metadataKind) ?? null;
}
