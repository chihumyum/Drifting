import { AgentChangeIndicator } from './AgentChangeIndicator';

/**
 * The count shown in a group's activity slot once a run has
 * finished and left unviewed changes beneath it — see agentActivityBubble.ts for
 * the cell → group → tab bubble it's part of. A plain, low-key number (no pill,
 * no blink), as quiet as the glyph it stands in for. It only shows once the run
 * is done; while a child is still busy the layer keeps its blinking glyph.
 */
export function AgentCountBadge({
  count,
  title,
  onClick,
}: {
  count: number;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <AgentChangeIndicator className="agent-count" title={title} onClick={onClick}>
      {count > 99 ? '99+' : count}
    </AgentChangeIndicator>
  );
}
