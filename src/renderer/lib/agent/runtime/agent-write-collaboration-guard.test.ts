import { describe, expect, it } from 'vitest';

import {
  AgentWriteCollaborationGuard,
  AgentWriteCollaborationConflictError,
  AgentWriteCollaborationConflictLimitError,
} from './agent-write-collaboration-guard';
import { attributeYjsRevisionConflict } from './agent-write-conflict-attribution';

const target = {
  sessionId: 'session-a',
  turnId: 'turn-a',
  entityKind: 'node_prose',
  entityId: 'chapter-1',
};

describe('Agent write collaboration guard', () => {
  it('allows one reconciliation and blocks the target after the second conflict', () => {
    const guard = new AgentWriteCollaborationGuard();

    guard.recordConflict(target);
    expect(() => guard.assertAllowed(target)).not.toThrow();
    guard.recordConflict(target);
    expect(() => guard.assertAllowed(target)).toThrow(
      AgentWriteCollaborationConflictLimitError,
    );
  });

  it('isolates sibling sessions and clears the streak after a successful write', () => {
    const guard = new AgentWriteCollaborationGuard();
    const sibling = { ...target, sessionId: 'session-b' };

    guard.recordConflict(target);
    guard.recordConflict(target);
    expect(() => guard.assertAllowed(sibling)).not.toThrow();

    guard.recordSuccess(target);
    expect(() => guard.assertAllowed(target)).not.toThrow();
  });

  it('distinguishes self, another Agent, the user, and missing durable provenance', () => {
    const attribution = attributeYjsRevisionConflict({
      expectedRevision: 7,
      currentRevision: 11,
      currentAgent: { sessionId: 'session-a', turnId: 'turn-a' },
      provenance: [
        {
          docId: 'node-content:chapter-1',
          revision: 8,
          source: {
            kind: 'agent',
            collaborator: {
              sessionId: 'session-a',
              turnId: 'turn-a',
              callId: 'call-self',
            },
          },
          createdAt: '2026-08-05T00:00:00.000Z',
        },
        {
          docId: 'node-content:chapter-1',
          revision: 9,
          source: {
            kind: 'agent',
            collaborator: {
              sessionId: 'session-b',
              turnId: 'turn-b',
              callId: 'call-other',
            },
          },
          createdAt: '2026-08-05T00:00:01.000Z',
        },
        {
          docId: 'node-content:chapter-1',
          revision: 10,
          source: { kind: 'user' },
          createdAt: '2026-08-05T00:00:02.000Z',
        },
      ],
    });

    expect(attribution).toEqual({
      kind: 'mixed',
      actors: ['self', 'other-agent', 'user', 'external-or-unknown'],
    });
    expect(new AgentWriteCollaborationConflictError(target, attribution).message).toContain(
      'this General Agent turn, another General Agent conversation, the author, an external or unattributed source',
    );
  });

  it('carries the last attributed writer into the two-conflict stop', () => {
    const guard = new AgentWriteCollaborationGuard();
    const attribution = {
      kind: 'other-agent',
      actors: ['other-agent'],
    } as const;

    guard.recordConflict(target, attribution);
    guard.recordConflict(target, attribution);

    expect(() => guard.assertAllowed(target)).toThrow(
      /Another General Agent conversation changed this authored object/,
    );
  });

  it('does not report an already-durable write from this turn as a failed save', () => {
    const attribution = attributeYjsRevisionConflict({
      expectedRevision: 3,
      currentRevision: 4,
      currentAgent: { sessionId: 'session-a', turnId: 'turn-a' },
      provenance: [
        {
          docId: 'node-content:chapter-1',
          revision: 4,
          source: {
            kind: 'agent',
            collaborator: {
              sessionId: 'session-a',
              turnId: 'turn-a',
              callId: 'earlier-successful-call',
            },
          },
          createdAt: '2026-08-05T00:00:00.000Z',
        },
      ],
    });

    expect(attribution.kind).toBe('self');
    expect(new AgentWriteCollaborationConflictError(target, attribution).message).toContain(
      'That earlier write may have succeeded; do not treat this conflict as evidence that it failed.',
    );
  });
});
