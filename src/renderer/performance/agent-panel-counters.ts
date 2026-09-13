// Imported only by the isolated browser build's instrumentation transform.
export const agentPanelRenders = { panel: 0, composer: 0, message: 0, transcript: 0 };
export function resetAgentPanelRenders() {
  for (const key of Object.keys(agentPanelRenders) as Array<keyof typeof agentPanelRenders>) agentPanelRenders[key] = 0;
}
