// Imported only by the isolated browser build's instrumentation transform.
export const agentPanelRenders = { panel: 0, composer: 0, message: 0, transcript: 0 };
export const agentMobileRows = { renders: 0 };
export const agentHistoryWork = { rowElements: 0 };
export function resetAgentPanelRenders() {
  for (const key of Object.keys(agentPanelRenders) as Array<keyof typeof agentPanelRenders>) agentPanelRenders[key] = 0;
}

export const agentTranscriptWork = { copiedTreeNodes: 0, copiedTreeSlots: 0, copiedArraySlots: 0, flatMaterializations: 0, flattenedMessages: 0 };
export function resetAgentTranscriptWork() { for (const key of Object.keys(agentTranscriptWork) as Array<keyof typeof agentTranscriptWork>) agentTranscriptWork[key] = 0; }

export const agentRecoveryWork = { groupedMessageVisits: 0, promptMessageVisits: 0, recoveredTurnVisits: 0, visibleUserCandidates: 0 };
