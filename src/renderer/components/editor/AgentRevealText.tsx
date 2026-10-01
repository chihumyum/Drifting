import { useLayoutEffect, useRef } from 'react';
import type { DiffSeg } from '../../lib/agent/block-diff';
import { placeAgentRevealCaret } from './agent-edit-animation';

/** Keep the entire old/new phase in layout while revealing it. Laying out only
 * the visible prefix lets word wrapping, punctuation and text-wrap: pretty move
 * already-painted characters at every line end. Hidden text must reserve space;
 * only the active phase participates, never old and new text together. */
export function AgentRevealText({
  segments,
  progress,
  showCaret = true,
  classPrefix = 'agent-reveal',
}: {
  segments: readonly DiffSeg[];
  progress: number;
  showCaret?: boolean;
  classPrefix?: 'agent-reveal' | 'field-diff';
}) {
  const boundaryRef = useRef<HTMLSpanElement>(null);
  const caretRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (caretRef.current && boundaryRef.current) {
      placeAgentRevealCaret(caretRef.current, boundaryRef.current);
    }
  });
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
