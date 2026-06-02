/**
 * Pure diff helpers for the agent's NON-PROSE field edits (summary / kv /
 * template kv / group), mirroring block-diff.ts for prose. An agent write to a
 * structured field is turned into one or more {@link AgentBlockChange}s carrying
 * a {@link AgentFieldRef} and a SYNTHETIC blockId (`field:summary`,
 * `field:kv:<key>`), so the existing edit-store / review pipeline (which keys on
 * blockId) covers them with no parallel state — only the leaf renderer and the
 * accept/revert dispatch branch on `field`.
 *
 * PURE: no store/DOM access. The handler reads before/after values, calls these,
 * and records the result; the field-review affordance renders + reverts it.
 */
import { parseKv, stringifyKv } from '../../domain/kv';
import type { AgentBlockChange, AgentFieldKind, AgentFieldRef } from './block-diff';

export const FIELD_BLOCK_PREFIX = 'field:';

/** Synthetic, stable blockId for a field change. KV-ish kinds append their key. */
export function fieldBlockId(kind: AgentFieldKind, key?: string): string {
  return key ? `${FIELD_BLOCK_PREFIX}${kind}:${key}` : `${FIELD_BLOCK_PREFIX}${kind}`;
}

/** Is this change a structured-field edit (vs a prose block edit)? */
export function isFieldChange(
  c: AgentBlockChange,
): c is AgentBlockChange & { field: AgentFieldRef } {
  return !!c.field;
}

/** Build one field change, or null when nothing actually changed. op is cosmetic
 *  for fields (drives the review label): empty→value = new, value→empty = deleted. */
function fieldChange(
  field: AgentFieldRef,
  blockId: string,
  oldText: string,
  newText: string,
): AgentBlockChange | null {
  if (oldText === newText) return null;
  const op = oldText === '' ? 'new' : newText === '' ? 'deleted' : 'changed';
  return { blockId, op, oldText, newText, afterPrevId: null, field };
}

/** Summary edit (all summary-bearing entities). */
export function summaryFieldChange(
  oldText: string | null | undefined,
  newText: string | null | undefined,
): AgentBlockChange | null {
  return fieldChange(
    { kind: 'summary', label: '摘要' },
    fieldBlockId('summary'),
    oldText ?? '',
    newText ?? '',
  );
}

/** Group-name edit (element only). */
export function groupFieldChange(
  oldText: string | null | undefined,
  newText: string | null | undefined,
): AgentBlockChange | null {
  return fieldChange(
    { kind: 'group', label: '分组' },
    fieldBlockId('group'),
    oldText ?? '',
    newText ?? '',
  );
}

/**
 * Row-level diff of two KV (or template-KV) JSON blobs, by key — so the agent
 * setting one fact surfaces as one reviewable row, not a whole-blob change.
 * Added keys → op 'new', removed → op 'deleted', value changed → 'changed'.
 * Duplicate keys (mid-edit) collapse to the last value (matches a Map view).
 */
export function kvFieldChanges(
  kind: 'kv' | 'templatekv',
  beforeJson: string | null | undefined,
  afterJson: string | null | undefined,
): AgentBlockChange[] {
  const before = parseKv(beforeJson);
  const after = parseKv(afterJson);
  const beforeByKey = new Map(before.map((r) => [r.key, r.value]));
  const afterByKey = new Map(after.map((r) => [r.key, r.value]));
  const changes: AgentBlockChange[] = [];

  // Changed / added — walked in post-edit order so the review reads top-down.
  for (const { key, value } of after) {
    if (!key) continue;
    const c = fieldChange(
      { kind, key, label: key },
      fieldBlockId(kind, key),
      beforeByKey.get(key) ?? '',
      value,
    );
    if (c) changes.push(c);
  }
  // Removed — present before, gone after.
  for (const { key, value } of before) {
    if (!key || afterByKey.has(key)) continue;
    const c = fieldChange({ kind, key, label: key }, fieldBlockId(kind, key), value, '');
    if (c) changes.push(c);
  }
  return changes;
}

/**
 * Reconstruct the JSON that REVERTS one KV row change, applied to the CURRENT
 * (post-edit) blob — restore the row's old value (re-adding it for a deletion),
 * or drop it for an agent-added row. Touches only the one key, so concurrent
 * user edits to other rows survive.
 */
export function applyKvRevert(currentJson: string, change: AgentBlockChange): string {
  const key = change.field?.key ?? '';
  const rows = parseKv(currentJson);
  if (change.op === 'new') {
    return stringifyKv(rows.filter((r) => r.key !== key));
  }
  const idx = rows.findIndex((r) => r.key === key);
  if (idx >= 0) {
    const next = rows.slice();
    next[idx] = { key, value: change.oldText };
    return stringifyKv(next);
  }
  return stringifyKv([...rows, { key, value: change.oldText }]);
}
