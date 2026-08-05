/**
 * Public product contract for concurrent General Agent conversations.
 *
 * Keep transport, write-conflict enforcement, generated capability evidence,
 * and acceptance documentation derived from this single definition.
 */
export const DRIFTING_AGENT_CONCURRENCY_CONTRACT = {
  admissionPolicy: 'unbounded-user-owned',
  activeTurnCardinality: 'one-per-conversation',
  projectScope: 'same-mounted-project',
  controlRouting: 'session-and-turn-scoped',
  readScheduling: 'concurrent',
  writeScheduling: 'shared-reader-writer-barrier',
  staleWritePolicy: 'revision-cas-stop-after-two-conflicts-per-target-turn',
  yjsCollaboratorIdentity: 'session-turn-call-origin',
  yjsRevisionProvenance: 'durable-per-revision-agent-user-remote-system-legacy',
  conflictAttribution: 'self-other-agent-user-mixed-external',
  restartBehavior: 'durable-plans-manual-resume-no-active-turn-replay',
} as const;

export const MAX_AGENT_TARGET_CONFLICTS_PER_TURN = 2;
