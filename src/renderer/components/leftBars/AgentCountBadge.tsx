/**
 * The count that replaces a layer's glyph (group dot / tab glyph) once a run has
 * finished and left unviewed changes beneath it — see agentActivityBubble.ts for
 * the cell → group → tab bubble it's part of. A plain, low-key number (no pill,
 * no blink), as quiet as the glyph it stands in for. It only shows once the run
 * is done; while a child is still busy the layer keeps its blinking glyph.
 */
export function AgentCountBadge({
  count,
  title,
}: {
  count: number;
  title?: string;
}) {
  return (
    <span aria-hidden className="agent-count" title={title}>
      {count > 99 ? '99+' : count}
    </span>
  );
}
