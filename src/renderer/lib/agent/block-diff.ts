/**
 * Pure block-level + token-level diff helpers for the agent-edit indicators (#4).
 *
 * `computeBlockChanges` compares a chapter's prose BEFORE an agent write against
 * the AFTER state (both as TipTap/ProseMirror JSON), keying on the stable block
 * uuids the block-id extension assigns, and reports which top-level blocks the
 * agent created, rewrote, or deleted — with the old + new text of each. This is
 * what drives the colored scrollbar ticks, the per-block reveal animation, and
 * the approve-mode review cards. It's PURE UI data: the entity content is already
 * the post-edit version; nothing here mutates the doc.
 *
 * `diffTokens` produces the word/char-level segments the reveal animation plays
 * (deleted runs fade out, inserted runs fade in). It tokenizes CJK per-character
 * and Latin per-word so it reads naturally for mixed Chinese/English prose.
 */
import { docToBlocks } from './serialize';

export type AgentBlockChangeOp = 'new' | 'changed' | 'deleted';

/** The structured (non-prose) field an agent edit targeted. Carried on
 *  {@link AgentBlockChange.field} so the prose surfaces (reveal animator /
 *  in-place decorations / scroll ticks) skip these, and the in-page field-review
 *  affordance renders only them. When set, `blockId` is a synthetic key
 *  (`field:summary`, `field:kv:<key>`) — never a real prose block uuid. */
export type AgentFieldKind = 'summary' | 'kv' | 'templatekv' | 'group';
export interface AgentFieldRef {
  kind: AgentFieldKind;
  /** For kv / templatekv: the row key. Undefined for summary / group. */
  key?: string;
  /** Human label for the review affordance header, e.g. "摘要" / a kv key. */
  label: string;
}

export interface AgentBlockChange {
  /** Stable uuid of the block (for new blocks: the freshly minted id). */
  blockId: string;
  op: AgentBlockChangeOp;
  /** Text before the edit ('' for a brand-new block). */
  oldText: string;
  /** Text after the edit ('' for a deleted block). */
  newText: string;
  /**
   * The id of the block immediately preceding this one in the POST-edit doc, or
   * null when it sits at the very top. For deletions this is the nearest block
   * that still exists after the edit — the anchor the deletion ghost hangs under.
   */
  afterPrevId: string | null;
  /**
   * The review mode in effect when this change was RECORDED (stamped by the edit
   * store, not computeBlockChanges). Carried per-change so flipping the global
   * toggle only governs FUTURE edits: an 'approve' change keeps its ✓/✗ even
   * after switching to auto, and an 'auto' change reveals + applies even after
   * switching to approve. Absent on freshly-diffed changes (stamped on record).
   */
  mode?: 'auto' | 'approve';
  /**
   * Set when this change targets a structured NON-PROSE field (summary / kv /
   * template kv), not a prose block. Prose surfaces ignore changes with `field`
   * set; the field-review surface renders only these. See {@link AgentFieldRef}.
   */
  field?: AgentFieldRef;
}

/**
 * Diff two prose snapshots into the set of top-level blocks the agent touched.
 * Blocks without a stable id are ignored (can't be anchored or animated).
 */
export function computeBlockChanges(beforeJson: string, afterJson: string): AgentBlockChange[] {
  const before = docToBlocks(beforeJson).filter((b): b is { blockId: string; type: string; text: string } => !!b.blockId);
  const after = docToBlocks(afterJson).filter((b): b is { blockId: string; type: string; text: string } => !!b.blockId);
  const beforeMap = new Map(before.map((b) => [b.blockId, b.text]));
  const afterSet = new Set(after.map((b) => b.blockId));

  const changes: AgentBlockChange[] = [];

  // New + changed blocks, walked in post-edit order (so the animation runs in
  // document order and afterPrevId is the real preceding block).
  after.forEach((b, i) => {
    const afterPrevId = i > 0 ? after[i - 1].blockId : null;
    const prevText = beforeMap.get(b.blockId);
    if (prevText === undefined) {
      changes.push({ blockId: b.blockId, op: 'new', oldText: '', newText: b.text, afterPrevId });
    } else if (prevText !== b.text) {
      changes.push({ blockId: b.blockId, op: 'changed', oldText: prevText, newText: b.text, afterPrevId });
    }
  });

  // Deleted blocks, anchored under the nearest surviving predecessor.
  let lastSurviving: string | null = null;
  for (const b of before) {
    if (afterSet.has(b.blockId)) {
      lastSurviving = b.blockId;
      continue;
    }
    changes.push({ blockId: b.blockId, op: 'deleted', oldText: b.text, newText: '', afterPrevId: lastSurviving });
  }

  return changes;
}

/**
 * Merge a fresh batch of block changes into the ones already pending for an
 * entity (the agent may touch a block several times across a turn). The ORIGINAL
 * oldText is preserved so the reveal animation always plays from the text the
 * user last saw to the latest text. Returns a new array; never mutates inputs.
 */
export function mergeBlockChanges(
  prev: AgentBlockChange[],
  incoming: AgentBlockChange[],
): AgentBlockChange[] {
  const map = new Map(prev.map((c) => [c.blockId, c]));
  for (const c of incoming) {
    const old = map.get(c.blockId);
    if (!old) {
      map.set(c.blockId, c);
      continue;
    }
    // A block created then deleted in the same run nets to nothing.
    if (old.op === 'new' && c.op === 'deleted') {
      map.delete(c.blockId);
      continue;
    }
    const op: AgentBlockChangeOp = old.op === 'new' ? 'new' : c.op;
    map.set(c.blockId, { ...c, op, oldText: old.oldText });
  }
  return [...map.values()];
}

// ---- token-level diff for the reveal animation -----------------------------

export type DiffSegKind = 'equal' | 'del' | 'ins';
export interface DiffSeg {
  kind: DiffSegKind;
  text: string;
}

const CJK = /[㐀-鿿豈-﫿぀-ヿ가-힯]/;

/** Split into diff tokens: each CJK char on its own, Latin runs + whitespace kept whole. */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let buf = '';
  for (const ch of text) {
    if (CJK.test(ch) || ch === '\n') {
      if (buf) {
        tokens.push(buf);
        buf = '';
      }
      tokens.push(ch);
    } else {
      buf += ch;
      // Break Latin runs on whitespace so words diff independently.
      if (/\s/.test(ch)) {
        tokens.push(buf);
        buf = '';
      }
    }
  }
  if (buf) tokens.push(buf);
  return tokens;
}

/**
 * Word/char-level diff of two strings, as an ordered list of equal/del/ins
 * segments (deletes before inserts at each divergence). Classic LCS — fine for
 * paragraph-sized prose. Adjacent same-kind segments are coalesced.
 */
export function diffTokens(oldText: string, newText: string): DiffSeg[] {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const raw: DiffSeg[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ kind: 'equal', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      raw.push({ kind: 'ins', text: b[j] });
      j++;
    }
  }
  while (i < n) raw.push({ kind: 'del', text: a[i++] });
  while (j < m) raw.push({ kind: 'ins', text: b[j++] });

  // Coalesce adjacent segments of the same kind.
  const out: DiffSeg[] = [];
  for (const seg of raw) {
    const last = out[out.length - 1];
    if (last && last.kind === seg.kind) last.text += seg.text;
    else out.push({ ...seg });
  }
  return out;
}
