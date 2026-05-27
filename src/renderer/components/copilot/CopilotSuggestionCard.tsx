/**
 * CopilotSuggestionCard — pure presentational card for copilot-source
 * manuscript comments. Accept / reject are wired by the parent (CommentRail);
 * this component just renders + reports clicks.
 *
 * Keyboard shortcuts (Tab to accept, Esc to reject) are no longer handled
 * here. CommentRail owns a global keydown router scoped to the editor
 * scroll container — see useEffect there. This avoids the "first Tab focuses
 * the card, second Tab accepts" double-press problem and lets keyboard
 * acceptance work directly while the user is typing in the editor.
 */
import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import { Check, Minimize2, X } from 'lucide-react';
import type { ManuscriptComment } from '../../domain/manuscript-comment';
import { decodeCopilotMetadata } from '../../domain/copilot-suggestion';
import { getCopilotCapabilityForMetadataKind } from '../../lib/copilot/capability';

interface CopilotSuggestionCardProps {
  comment: ManuscriptComment;
  /** Absolute positioning style (top or bottom) within the rail. */
  style?: CSSProperties;
  /** Tab/Esc currently routes here. Accept button shows a glow pulse. */
  isActive: boolean;
  /** Active window expired. Mouse still works; keyboard does not route here. */
  isStale: boolean;
  /** Target block was deleted. Card shows a "原文已删除" tag instead of evidence. */
  isOrphan?: boolean;
  onAccept: () => Promise<unknown>;
  onReject: () => Promise<unknown>;
  /** Opens the snapshot modal. Only meaningful when isOrphan is true. */
  onShowSnapshot?: () => void;
  /** Collapses this card to a chip in the rail. */
  onCollapse?: () => void;
}

export function CopilotSuggestionCard({
  comment,
  style,
  isActive,
  isStale,
  isOrphan = false,
  onAccept,
  onReject,
  onShowSnapshot,
  onCollapse,
}: CopilotSuggestionCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const metadata = useMemo(() => decodeCopilotMetadata(comment.metadataJson), [comment.metadataJson]);
  const capability = useMemo(
    () => (metadata ? getCopilotCapabilityForMetadataKind(metadata.kind) : null),
    [metadata],
  );
  const summary = useMemo(
    () => (capability && metadata ? capability.renderSummary?.(metadata) : null),
    [capability, metadata],
  );

  const handleAccept = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAccept();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
    // On success the comment row is converted; parent re-renders and this
    // card unmounts, so no need to reset busy.
  }, [busy, onAccept]);

  const handleReject = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onReject();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [busy, onReject]);

  const baseClasses = ['mnote', 'mnote--copilot'];
  if (isStale) baseClasses.push('mnote--stale');
  if (isOrphan) baseClasses.push('mnote--orphan');

  // Graceful fallback when capability isn't registered (e.g. user has a
  // stale copilot comment for a feature we no longer ship).
  if (!metadata || !capability) {
    return (
      <div className={baseClasses.join(' ')} style={style}>
        {!isOrphan && <div className="mnote__leader" aria-hidden="true" />}
        <div className="mnote__head">
          <span className="mnote__head-l">
            <span className="mnote__head-glyph">⚠</span>
            <span>COPILOT (unknown)</span>
          </span>
        </div>
        <div className="mnote__title">Unknown capability — safe to dismiss.</div>
        <div className="mnote__actions">
          <button type="button" className="mnote__btn" disabled={busy} onClick={() => void handleReject()}>
            <X size={12} />
            <span>关闭</span>
          </button>
        </div>
      </div>
    );
  }

  const title = summary?.title ?? `Copilot suggestion (${metadata.kind})`;
  const subtitle = summary?.subtitle;
  const evidence = summary?.evidence;
  const acceptLabel = summary?.actionLabel ?? 'Accept';

  const acceptClasses = ['mnote__btn', 'mnote__btn--primary'];
  if (isActive) acceptClasses.push('mnote__btn--glow');

  return (
    <div className={baseClasses.join(' ')} style={style}>
      {!isOrphan && <div className="mnote__leader" aria-hidden="true" />}
      <div className="mnote__head">
        <span className="mnote__head-l">
          <span className="mnote__head-glyph">✦</span>
          <span>COPILOT</span>
        </span>
        <span className="mnote__head-r">
          {subtitle && <span className="mnote__head-conf">{subtitle}</span>}
          {onCollapse && (
            <button
              type="button"
              className="mnote__icon-btn"
              onClick={onCollapse}
              aria-label="折叠"
              title="折叠为 chip"
            >
              <Minimize2 size={11} />
            </button>
          )}
        </span>
      </div>
      <div className="mnote__title">{title}</div>
      {isOrphan ? (
        <button
          type="button"
          className="mnote__tag"
          onClick={() => onShowSnapshot?.()}
          disabled={!onShowSnapshot}
          title={onShowSnapshot ? '查看原文快照' : '无原文快照'}
        >
          原文已删除
        </button>
      ) : (
        evidence && <div className="mnote__quote">{evidence}</div>
      )}
      {error && (
        <div className="mnote__quote" style={{ color: 'var(--accent-warn, #c33)' }}>
          {error}
        </div>
      )}
      <div className="mnote__actions">
        <button
          type="button"
          className={acceptClasses.join(' ')}
          disabled={busy}
          onClick={() => void handleAccept()}
          title={isActive ? 'Tab' : undefined}
        >
          <Check size={12} />
          <span>{acceptLabel}</span>
        </button>
        <button
          type="button"
          className="mnote__btn"
          disabled={busy}
          onClick={() => void handleReject()}
          title={isActive ? 'Esc' : undefined}
        >
          <X size={12} />
          <span>忽略</span>
        </button>
      </div>
    </div>
  );
}
