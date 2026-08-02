import { workspaceCommandFromArguments } from './drifting-workspace-tool-runtime';
import type { AgentAuthoringEntity } from './writing-intelligence';
import type { AgentToolExecutionRequest } from './types';

export type AgentWritingScopeDecision =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'WRITING_SCOPE_UNRESOLVED'
        | 'WRITING_CANON_PATCH_REQUIRED'
        | 'WRITING_SCOPE_ENTITY_MISMATCH'
        | 'WRITING_SCOPE_SELECTION_MISMATCH'
        | 'WRITING_SCOPE_BLOCK_MISMATCH';
      error: string;
    };

const PROSE_COMMANDS = new Set([
  'edit_prose_file',
  'edit_block',
  'edit_blocks',
  'append_paragraph',
  'insert_blocks',
  'remove_blocks',
  'replace_block_range',
]);

function normalizePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = `/${value.trim().replace(/^\/+|\/+$/gu, '')}`;
  return normalized === '/' ? '/' : normalized;
}

function focusDirectory(path: string): string {
  return path.replace(/\/(?:prose|body)\.md$/u, '');
}

function pathMatchesFocus(path: string, focusPath: string): boolean {
  const normalized = normalizePath(path);
  if (!normalized) return false;
  return normalized === focusPath || normalized === focusDirectory(focusPath);
}

function targetNames(arguments_: Record<string, unknown>): string[] {
  return ['entity', 'node', 'chapter', 'drift', 'element', 'storyline', 'category'].flatMap(
    (key) => {
      const value = arguments_[key];
      return typeof value === 'string' && value.trim() ? [value.trim()] : [];
    },
  );
}

function entityMatches(
  request: AgentToolExecutionRequest,
  arguments_: Record<string, unknown>,
  entity: AgentAuthoringEntity,
): boolean {
  const path = normalizePath(request.arguments.path);
  if (path) return pathMatchesFocus(path, entity.path);
  const names = targetNames(arguments_);
  if (names.length === 0) return false;
  return names.every((name) => name === entity.name || name === entity.id);
}

function entityMatchesFocus(
  request: AgentToolExecutionRequest,
  arguments_: Record<string, unknown>,
): boolean {
  const focus = request.context.writing?.focus;
  return focus ? entityMatches(request, arguments_, focus.entity) : false;
}

function normalizedSpan(value: string): string {
  return value.replace(/\r\n?/gu, '\n').replace(/\n+/gu, '\n').trim();
}

function selectedWitnesses(request: AgentToolExecutionRequest): string[] {
  const focus = request.context.writing?.focus;
  if (!focus) return [];
  return [
    focus.selectedText,
    ...focus.selectedBlocks.map((block) => block.text),
    focus.selectedBlocks.map((block) => block.text).join('\n\n'),
  ]
    .map(normalizedSpan)
    .filter(Boolean);
}

function replacementStaysInsideSelection(
  request: AgentToolExecutionRequest,
  arguments_: Record<string, unknown>,
): boolean {
  if (!Array.isArray(arguments_.replacements)) return false;
  const witnesses = selectedWitnesses(request);
  return (
    arguments_.replacements.length > 0 &&
    arguments_.replacements.every((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
      const oldText = (raw as Record<string, unknown>).oldText;
      if (typeof oldText !== 'string' || !oldText) return false;
      const normalized = normalizedSpan(oldText);
      return witnesses.some((witness) => witness.includes(normalized));
    })
  );
}

function selectedBlockSets(request: AgentToolExecutionRequest): {
  ids: Set<string>;
  ordinals: Set<number>;
} {
  const blocks = request.context.writing?.focus?.selectedBlocks ?? [];
  return {
    ids: new Set(blocks.map((block) => block.id)),
    ordinals: new Set(blocks.map((block) => block.ordinal)),
  };
}

function blockTargetMatches(
  request: AgentToolExecutionRequest,
  arguments_: Record<string, unknown>,
): boolean {
  const selected = selectedBlockSets(request);
  const matches = (block: unknown, blockId: unknown): boolean =>
    (typeof blockId === 'string' && selected.ids.has(blockId)) ||
    (typeof block === 'number' && selected.ordinals.has(block));

  if (Array.isArray(arguments_.edits)) {
    return (
      arguments_.edits.length > 0 &&
      arguments_.edits.every((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
        const row = raw as Record<string, unknown>;
        return matches(row.block, row.blockId);
      })
    );
  }
  if (Array.isArray(arguments_.blockIds) || Array.isArray(arguments_.blockNumbers)) {
    const ids = Array.isArray(arguments_.blockIds) ? arguments_.blockIds : [];
    const ordinals = Array.isArray(arguments_.blockNumbers) ? arguments_.blockNumbers : [];
    return (
      ids.length + ordinals.length > 0 &&
      ids.every((value) => typeof value === 'string' && selected.ids.has(value)) &&
      ordinals.every((value) => typeof value === 'number' && selected.ordinals.has(value))
    );
  }
  if (
    'fromBlock' in arguments_ ||
    'fromBlockId' in arguments_ ||
    'toBlock' in arguments_ ||
    'toBlockId' in arguments_
  ) {
    return (
      matches(arguments_.fromBlock, arguments_.fromBlockId) &&
      matches(arguments_.toBlock, arguments_.toBlockId)
    );
  }
  if ('afterBlock' in arguments_ || 'afterBlockId' in arguments_) {
    return matches(arguments_.afterBlock, arguments_.afterBlockId);
  }
  return matches(arguments_.block, arguments_.blockId);
}

/**
 * Enforce product-derived authoring scope after workspace paths have resolved
 * to hidden commands but before any certified mutation can observe them.
 */
export function validateAgentWritingScope(
  request: AgentToolExecutionRequest,
): AgentWritingScopeDecision {
  const writing = request.context.writing;
  if (!writing) return { ok: true };
  const command = workspaceCommandFromArguments(request.arguments);
  const name = command?.name ?? request.name;
  const arguments_ = command?.arguments ?? request.arguments;
  const isProse = PROSE_COMMANDS.has(name);

  if (writing.intent.clarificationRequired && isProse) {
    return {
      ok: false,
      code: 'WRITING_SCOPE_UNRESOLVED',
      error:
        'The author referred to nearby text, but no active editor scope was available. Ask the author which passage to change before writing.',
    };
  }
  if (writing.canonImpact.requiresSanctionedPatch && isProse) {
    return {
      ok: false,
      code: 'WRITING_CANON_PATCH_REQUIRED',
      error:
        'This prose mutation would embody an explicit change to established canon. Record and approve the sanctioned canon evolution first, then use a new author instruction to bind the resulting prose scope.',
    };
  }
  if (!writing.intent.hardFocusScope) {
    if (
      isProse &&
      writing.intent.scopeKind === 'explicit' &&
      writing.resolvedTargets.length > 0 &&
      !writing.resolvedTargets.some((target) => entityMatches(request, arguments_, target))
    ) {
      return {
        ok: false,
        code: 'WRITING_SCOPE_ENTITY_MISMATCH',
        error:
          'This prose mutation is outside the product-resolved entities explicitly named by the author. Re-read the named target set instead of substituting another entity.',
      };
    }
    return { ok: true };
  }
  if (!entityMatchesFocus(request, arguments_)) {
    return {
      ok: false,
      code: 'WRITING_SCOPE_ENTITY_MISMATCH',
      error:
        "This mutation targets a different manuscript entity than the author's active editor focus. Do not broaden scope without an explicit later instruction.",
    };
  }
  if (!isProse || writing.intent.scopeKind === 'focus_entity') return { ok: true };

  if (name === 'edit_prose_file') {
    if (replacementStaysInsideSelection(request, arguments_)) return { ok: true };
    return {
      ok: false,
      code: 'WRITING_SCOPE_SELECTION_MISMATCH',
      error:
        'The proposed file edit is not proven to stay inside the author-selected text. Use exact oldText from the focused span, or ask the author to broaden scope.',
    };
  }
  if (writing.intent.scopeKind === 'focus_selection') {
    return {
      ok: false,
      code: 'WRITING_SCOPE_SELECTION_MISMATCH',
      error:
        'A partial text selection can only be changed through an exact replacement of that selected source span.',
    };
  }
  if (name === 'append_paragraph' || !blockTargetMatches(request, arguments_)) {
    return {
      ok: false,
      code: 'WRITING_SCOPE_BLOCK_MISMATCH',
      error:
        'The proposed prose operation is outside the focused paragraph. Use the focused block id/ordinal or ask the author to broaden scope.',
    };
  }
  return { ok: true };
}

export function assertAgentWritingScope(request: AgentToolExecutionRequest): void {
  const decision = validateAgentWritingScope(request);
  if (!decision.ok) throw new Error(`${decision.code}: ${decision.error}`);
}
