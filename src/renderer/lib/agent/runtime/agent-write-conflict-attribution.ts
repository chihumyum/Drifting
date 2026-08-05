import type { YjsRevisionProvenanceRow } from '../../../sqlite-repo/yjs-repo';

export type AgentWriteConflictActor =
  | 'self'
  | 'other-agent'
  | 'agent-unknown'
  | 'user'
  | 'external-or-unknown';

export interface AgentWriteConflictAttribution {
  kind: AgentWriteConflictActor | 'mixed';
  actors: readonly AgentWriteConflictActor[];
}

export interface CurrentAgentWriterIdentity {
  sessionId: string;
  turnId: string;
}

const ACTOR_ORDER: readonly AgentWriteConflictActor[] = [
  'self',
  'other-agent',
  'agent-unknown',
  'user',
  'external-or-unknown',
];

export const UNKNOWN_AGENT_WRITE_CONFLICT_ATTRIBUTION: AgentWriteConflictAttribution = {
  kind: 'external-or-unknown',
  actors: ['external-or-unknown'],
};

/**
 * Attribute every durable revision between the Agent's read and the current
 * Yjs generation. Missing provenance is explicit: it must never be guessed to
 * mean a user edit merely because no Agent receipt was found.
 */
export function attributeYjsRevisionConflict(input: {
  expectedRevision: number;
  currentRevision: number;
  provenance: readonly YjsRevisionProvenanceRow[];
  currentAgent: CurrentAgentWriterIdentity;
}): AgentWriteConflictAttribution {
  const actors = new Set<AgentWriteConflictActor>();
  const covered = new Set<number>();
  let sawSystemRevision = false;

  for (const entry of input.provenance) {
    if (
      entry.revision <= input.expectedRevision ||
      entry.revision > input.currentRevision
    ) {
      continue;
    }
    covered.add(entry.revision);
    if (entry.source.kind === 'user') {
      actors.add('user');
      continue;
    }
    if (entry.source.kind === 'system') {
      // Deterministic normalization (for example adding stable block IDs) may
      // advance immediately after an authored edit. It is not a second author
      // and should not obscure the user/Agent that caused the stale read.
      sawSystemRevision = true;
      continue;
    }
    if (entry.source.kind !== 'agent') {
      actors.add('external-or-unknown');
      continue;
    }
    const collaborator = entry.source.collaborator;
    if (!collaborator) {
      actors.add('agent-unknown');
      continue;
    }
    actors.add(
      collaborator.sessionId === input.currentAgent.sessionId &&
        collaborator.turnId === input.currentAgent.turnId
        ? 'self'
        : 'other-agent',
    );
  }

  for (
    let revision = input.expectedRevision + 1;
    revision <= input.currentRevision;
    revision += 1
  ) {
    if (!covered.has(revision)) actors.add('external-or-unknown');
  }
  if (input.currentRevision <= input.expectedRevision) {
    actors.add('external-or-unknown');
  }
  if (actors.size === 0 && sawSystemRevision) {
    actors.add('external-or-unknown');
  }

  const ordered = ACTOR_ORDER.filter((actor) => actors.has(actor));
  if (ordered.length === 0) return UNKNOWN_AGENT_WRITE_CONFLICT_ATTRIBUTION;
  return {
    kind: ordered.length === 1 ? ordered[0]! : 'mixed',
    actors: ordered,
  };
}

export function describeAgentWriteConflictAttribution(
  attribution: AgentWriteConflictAttribution,
): string {
  if (attribution.kind === 'self') {
    return 'An earlier write from this same General Agent turn already changed this authored object after the cited read. That earlier write may have succeeded; do not treat this conflict as evidence that it failed.';
  }
  if (attribution.kind === 'other-agent') {
    return 'Another General Agent conversation changed this authored object after the cited read.';
  }
  if (attribution.kind === 'agent-unknown') {
    return 'An Agent execution changed this authored object after the cited read, but its older provenance does not identify the exact session.';
  }
  if (attribution.kind === 'user') {
    return 'The author changed this authored object after the cited read.';
  }
  if (attribution.kind === 'external-or-unknown') {
    return 'This authored object changed after the cited read, but the durable provenance cannot attribute it reliably. Do not assume that an earlier write from this turn failed.';
  }
  const labels = attribution.actors.map((actor) => {
    switch (actor) {
      case 'self':
        return 'this General Agent turn';
      case 'other-agent':
        return 'another General Agent conversation';
      case 'agent-unknown':
        return 'an older Agent execution';
      case 'user':
        return 'the author';
      case 'external-or-unknown':
        return 'an external or unattributed source';
    }
  });
  return `This authored object changed through multiple sources after the cited read: ${labels.join(', ')}.`;
}
