export const AGENT_FINAL_RESPONSE_MARKER = 'FINAL_RESPONSE:' as const;

export function stripAgentFinalResponseMarker(value: string): string {
  const index = value.indexOf(AGENT_FINAL_RESPONSE_MARKER);
  if (index < 0) return value;
  return value.slice(index + AGENT_FINAL_RESPONSE_MARKER.length).replace(/^\s+/, '');
}
