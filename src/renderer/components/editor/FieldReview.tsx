/**
 * In-page review affordance for the agent's NON-PROSE field edits (summary / kv /
 * template kv). The agent's write already landed in the store (soft-approval,
 * like prose); this surfaces it for the user, and is rendered INSTEAD of the
 * field's own control while a change is pending (so the diff and the applied
 * result are never both on screen — the control returns once the change resolves).
 *
 *   - approve mode: static red/green diff + ✓ / ✗. ✓ plays the typewriter reveal
 *                   then keeps the value; ✗ reverts the field to its old value.
 *   - auto mode:    once on screen, the diff lingers briefly then types itself in
 *                   (erase deletions, type insertions) and settles — mirrors the
 *                   prose reveal's "apply when seen".
 *
 * Shares the structure-agnostic token diff (`diffTokens`) + the typewriter logic
 * with the prose reveal; the prose-only machinery (ProseMirror decorations, the
 * rect-tracking portal overlay) doesn't apply to a form field and isn't needed.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import { diffTokens, type AgentBlockChange } from '../../lib/agent/block-diff';

/** Static red (deleted) / green (inserted) token diff of two strings. */
export function FieldDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const segs = useMemo(() => diffTokens(oldText, newText), [oldText, newText]);
  return (
    <span className="field-diff">
      {segs.map((s, i) =>
        s.kind === 'equal' ? (
          <span key={i}>{s.text}</span>
        ) : s.kind === 'del' ? (
          <del key={i} className="field-diff__del">
            {s.text}
          </del>
        ) : (
          <ins key={i} className="field-diff__ins">
            {s.text}
          </ins>
        ),
      )}
    </span>
  );
}

// Typewriter pacing — per character, clamped (matches the prose reveal feel).
const CHAR_MS = 24;
const MIN_REVEAL_MS = 320;
const MAX_REVEAL_MS = 1800;
// Auto mode: show the diff this long before it types itself in.
const AUTO_HOLD_MS = 650;

/**
 * Inline typewriter that morphs old text → new text: deletions erase from the
 * front (red), insertions type in from the front (green), then `onDone` fires.
 * The in-flow analogue of AgentEditAnimator's RevealOverlay, minus the
 * positioning (a field's review card is already laid out where it belongs).
 */
function FieldReveal({
  oldText,
  newText,
  onDone,
}: {
  oldText: string;
  newText: string;
  onDone: () => void;
}) {
  const segs = useMemo(() => diffTokens(oldText, newText), [oldText, newText]);
  const { delChars, insChars } = useMemo(() => {
    let d = 0;
    let i = 0;
    for (const s of segs) {
      if (s.kind === 'del') d += s.text.length;
      else if (s.kind === 'ins') i += s.text.length;
    }
    return { delChars: d, insChars: i };
  }, [segs]);
  const total = delChars + insChars;

  const [progress, setProgress] = useState(0);
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  });

  useEffect(() => {
    const duration = Math.max(MIN_REVEAL_MS, Math.min(MAX_REVEAL_MS, total * CHAR_MS));
    let raf = 0;
    let start = 0;
    const tick = (ts: number) => {
      if (!start) start = ts;
      const t = total === 0 ? 1 : Math.min(1, (ts - start) / duration);
      setProgress(Math.round(t * total));
      if (t < 1) raf = window.requestAnimationFrame(tick);
      else doneRef.current();
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [total]);

  const erased = Math.min(progress, delChars);
  const shownIns = Math.max(0, progress - delChars);
  const nodes: ReactNode[] = [];
  let delOff = 0;
  let insOff = 0;
  segs.forEach((s, idx) => {
    if (s.kind === 'equal') {
      nodes.push(<span key={idx}>{s.text}</span>);
      return;
    }
    if (s.kind === 'del') {
      const removed = Math.min(Math.max(erased - delOff, 0), s.text.length);
      delOff += s.text.length;
      const rest = s.text.slice(removed);
      if (rest)
        nodes.push(
          <del key={idx} className="field-diff__del">
            {rest}
          </del>,
        );
      return;
    }
    const shown = Math.min(Math.max(shownIns - insOff, 0), s.text.length);
    insOff += s.text.length;
    if (shown)
      nodes.push(
        <ins key={idx} className="field-diff__ins">
          {s.text.slice(0, shown)}
        </ins>,
      );
  });
  if (progress < total) nodes.push(<span key="caret" className="agent-reveal__caret" />);

  return <span className="field-diff">{nodes}</span>;
}

export function FieldReview({
  change,
  onAccept,
  onReject,
}: {
  change: AgentBlockChange;
  /** Keep the change (value already applied), after the typewriter settles. */
  onAccept: () => void;
  /** Revert the field to its old value (approve ✗ only — no typewriter). */
  onReject: () => void;
}) {
  const mode = change.mode ?? 'approve';
  const ref = useRef<HTMLDivElement>(null);
  // Once true, the diff types itself in; its onDone resolves the change.
  const [committing, setCommitting] = useState(false);
  const acceptRef = useRef(onAccept);
  useEffect(() => {
    acceptRef.current = onAccept;
  });

  // Auto mode: once the card is on screen, hold the diff briefly, then commit.
  useEffect(() => {
    if (mode !== 'auto') return undefined;
    const el = ref.current;
    if (!el) return undefined;
    let hold = 0;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio >= 0.5 && !hold) {
            io.disconnect();
            hold = window.setTimeout(() => setCommitting(true), AUTO_HOLD_MS);
          }
        }
      },
      { threshold: [0, 0.5, 1] },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (hold) window.clearTimeout(hold);
    };
  }, [mode, change.blockId]);

  // For a KV row the key isn't part of the value diff, so show it as a prefix —
  // colored with the op (new = green, deleted = red struck) so a new fact reads
  // as a plain green "key：value" with no explanatory label.
  const key = change.field?.kind === 'kv' || change.field?.kind === 'templatekv'
    ? change.field?.key
    : undefined;
  const keyNode = key ? (
    <span
      className={`field-kv-key${change.op === 'new' ? ' field-diff__ins' : change.op === 'deleted' ? ' field-diff__del' : ''}`}
    >
      {key}：
    </span>
  ) : null;
  return (
    <div ref={ref} className={`field-review${committing ? ' field-review--committing' : ''}`}>
      <span className="field-review__body">
        {keyNode}
        {committing ? (
          <FieldReveal
            oldText={change.oldText}
            newText={change.newText}
            onDone={() => acceptRef.current()}
          />
        ) : (
          <FieldDiff oldText={change.oldText} newText={change.newText} />
        )}
      </span>
      {!committing && mode === 'approve' && (
        <span className="field-review__actions">
          <button
            type="button"
            className="field-review__btn field-review__btn--ok"
            title="采纳这处改动"
            onClick={() => setCommitting(true)}
          >
            <Check size={12} />
          </button>
          <button
            type="button"
            className="field-review__btn field-review__btn--no"
            title="拒绝并还原"
            onClick={onReject}
          >
            <X size={12} />
          </button>
        </span>
      )}
    </div>
  );
}

/** A stack of field reviews — used above a KvEditor for its row-level changes. */
export function FieldReviewStrip({
  changes,
  onAccept,
  onReject,
}: {
  changes: AgentBlockChange[];
  onAccept: (c: AgentBlockChange) => void;
  onReject: (c: AgentBlockChange) => void;
}) {
  if (changes.length === 0) return null;
  return (
    <div className="field-review-strip">
      {changes.map((c) => (
        <FieldReview
          key={c.blockId}
          change={c}
          onAccept={() => onAccept(c)}
          onReject={() => onReject(c)}
        />
      ))}
    </div>
  );
}
