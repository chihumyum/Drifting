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
import { Check, X } from 'lucide-react';
import type { ManuscriptComment } from '../../domain/manuscript-comment';
import { decodeCopilotMetadata } from '../../domain/copilot-suggestion';
import { getCopilotCapabilityForMetadataKind } from '../../lib/copilot/capability';

interface CopilotSuggestionCardProps {
  comment: ManuscriptComment;
  /** Pixel top within the rail container. Ignored in floating variant. */
  top?: number;
  /** 'rail' = absolute in margin rail; 'floating' = inside a chip popover. */
  variant?: 'rail' | 'floating';
  /** Tab/Esc currently routes here. Accept button shows a glow pulse. */
  isActive: boolean;
  /** Active window expired. Mouse still works; keyboard does not route here. */
  isStale: boolean;
  onAccept: () => Promise<unknown>;
  onReject: () => Promise<unknown>;
  /** Render an X in the header (used by the floating popover variant). */
  onClose?: () => void;
}

export function CopilotSuggestionCard({
  comment,
  top,
  variant = 'rail',
  isActive,
  isStale,
  onAccept,
  onReject,
  onClose,
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
  if (variant === 'floating') baseClasses.push('mnote--floating');
  if (isStale) baseClasses.push('mnote--stale');

  const style: CSSProperties | undefined = variant === 'rail' ? { top } : undefined;

  // Graceful fallback when capability isn't registered (e.g. user has a
  // stale copilot comment for a feature we no longer ship).
  if (!metadata || !capability) {
    return (
      <div className={baseClasses.join(' ')} style={style}>
        {variant === 'rail' && <div className="mnote__leader" aria-hidden="true" />}
        <div className="mnote__head">
          <span className="mnote__head-l">
            <span className="mnote__head-glyph">⚠</span>
            <span>COPILOT (unknown)</span>
          </span>
          {onClose && (
            <button
              type="button"
              className="mnote__icon-btn"
              onClick={onClose}
              aria-label="Close"
            >
              <X size={12} />
            </button>
          )}
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
      {variant === 'rail' && <div className="mnote__leader" aria-hidden="true" />}
      <div className="mnote__head">
        <span className="mnote__head-l">
          <span className="mnote__head-glyph">✦</span>
          <span>COPILOT</span>
        </span>
        {onClose ? (
          <button
            type="button"
            className="mnote__icon-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={12} />
          </button>
        ) : (
          subtitle && <span className="mnote__head-conf">{subtitle}</span>
        )}
      </div>
      <div className="mnote__title">{title}</div>
      {evidence && <div className="mnote__quote">{evidence}</div>}
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
