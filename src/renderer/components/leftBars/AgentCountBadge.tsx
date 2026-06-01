/**
 * The count that replaces a layer's glyph (group dot / tab glyph) once the
 * agent has left unviewed changes beneath it — see agentActivityBubble.ts for
 * the cell → group → tab bubble it's part of. Static, high-contrast monochrome
 * at rest (matching the still "done" cell marker); accent + blink while a fresh
 * run is still working over the pending changes.
 */
export function AgentCountBadge({
  count,
  busy,
  title,
}: {
  count: number;
  busy: boolean;
  title?: string;
}) {
  return (
    <span
      aria-hidden
      className={`agent-count${busy ? ' agent-count--busy' : ''}`}
      title={title}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
