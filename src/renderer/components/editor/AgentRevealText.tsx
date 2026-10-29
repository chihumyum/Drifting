import { useLayoutEffect, useMemo, useRef } from 'react';
import type { DiffSeg } from '../../lib/agent/block-diff';
import { agentRevealFrame, agentRevealPieces, placeAgentRevealCaret } from './agent-edit-animation';

/** Keep the entire old/new phase in layout while revealing it. Laying out only
 * the visible prefix lets word wrapping, punctuation and text-wrap: pretty move
 * already-painted characters at every line end. Hidden text must reserve space;
 * only the active phase participates, never old and new text together.
 *
 * `overwrite` (the desktop) plays each changed place in place instead: the old
 * words are deleted from the front or overwritten, and the new ones written
 * over them, one character a step (agentRevealFrame); `progress` counts steps. */
export function AgentRevealText({
  segments,
  progress,
  showCaret = true,
  classPrefix = 'agent-reveal',
  mode = 'typewriter',
}: {
  segments: readonly DiffSeg[];
  progress: number;
  showCaret?: boolean;
  classPrefix?: 'agent-reveal' | 'field-diff';
  mode?: 'typewriter' | 'overwrite';
}) {
  const boundaryRef = useRef<HTMLSpanElement>(null);
  const caretRef = useRef<HTMLSpanElement>(null);
  const pieces = useMemo(() => (mode === 'overwrite' ? agentRevealPieces(segments) : null), [mode, segments]);
  useLayoutEffect(() => {
    if (caretRef.current && boundaryRef.current) {
      placeAgentRevealCaret(caretRef.current, boundaryRef.current, boundaryRef.current.dataset.caretEnd === 'true');
    }
  });

  if (pieces) {
    const { runs, caret } = agentRevealFrame(pieces, progress);
    const hasCaret = showCaret && caret >= 0 && runs.length > 0;
    // The caret measures the run it stands before, or the end of the last run.
    const boundary = hasCaret ? Math.min(caret, runs.length - 1) : -1;
    const caretAtEnd = hasCaret && caret >= runs.length;
    return (
      <>
        {runs.map((run, index) => (
          <span
            key={index}
            ref={index === boundary ? boundaryRef : undefined}
            data-caret-end={index === boundary && caretAtEnd ? 'true' : undefined}
            className={run.mark ? `${classPrefix}__${run.mark}` : undefined}
          >
            {run.text}
          </span>
        ))}
        {hasCaret && <span ref={caretRef} className="agent-reveal__caret" style={{ visibility: 'hidden' }} />}
      </>
    );
  }

  const deleted = segments.reduce(
    (sum, segment) => sum + (segment.kind === 'del' ? segment.text.length : 0),
    0,
  );
  const erasing = progress < deleted;
  const phaseProgress = erasing ? progress : progress - deleted;
  let offset = 0;

  let hasCaret = false;
  const nodes = [];
  for (const [index, segment] of segments.entries()) {
    if (segment.kind === 'equal') {
      nodes.push(<span key={index}>{segment.text}</span>);
      continue;
    }
    if (segment.kind !== (erasing ? 'del' : 'ins')) continue;

    let boundary = Math.min(Math.max(phaseProgress - offset, 0), segment.text.length);
    // A frame counter counts UTF-16 units, but must not split a surrogate pair.
    if (boundary > 0 && boundary < segment.text.length && /[\uD800-\uDBFF]/.test(segment.text[boundary - 1])) {
      boundary--;
    }
    const caret = showCaret && phaseProgress >= offset && phaseProgress < offset + segment.text.length;
    hasCaret ||= caret;
    offset += segment.text.length;
    const before = segment.text.slice(0, boundary);
    const after = segment.text.slice(boundary);
    const visibleClass = `${classPrefix}__${segment.kind}`;
    nodes.push(
      <span key={index}>
        <span className={erasing ? 'agent-reveal__unshown' : visibleClass}>{before}</span>
        <span ref={caret ? boundaryRef : undefined} className={erasing ? visibleClass : 'agent-reveal__unshown'}>
          {after}
        </span>
      </span>
    );
  }
  return (
    <>
      {nodes}
      {hasCaret && <span ref={caretRef} className="agent-reveal__caret" style={{ visibility: 'hidden' }} />}
    </>
  );
}
