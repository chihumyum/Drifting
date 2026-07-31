import { describe, expect, it } from 'vitest';
import {
  isExplicitLegacyTurnCheckpoint,
  selectLegacyRevertableTurnIds,
  type TurnCheckpointConversationIdentity,
} from './turn-revert-policy';

const checkpoint = (turnId: string, convId: string) => ({
  turnId,
  convId,
  projectId: 'project-1',
});

const conversation = (
  id: string,
  overrides: Partial<TurnCheckpointConversationIdentity> = {},
): TurnCheckpointConversationIdentity => ({
  id,
  projectId: 'project-1',
  sdkSessionId: `sdk:${id}`,
  runtimeSessionId: null,
  ...overrides,
});

describe('legacy whole-turn revert authority', () => {
  it('requires durable legacy SDK identity and rejects provider-neutral or ambiguous rows', () => {
    const ref = checkpoint('turn-1', 'conv-1');

    expect(isExplicitLegacyTurnCheckpoint(ref, conversation('conv-1'))).toBe(true);
    expect(
      isExplicitLegacyTurnCheckpoint(
        ref,
        conversation('conv-1', { runtimeSessionId: 'runtime-1' }),
      ),
    ).toBe(false);
    expect(
      isExplicitLegacyTurnCheckpoint(ref, conversation('conv-1', { sdkSessionId: null })),
    ).toBe(false);
    expect(
      isExplicitLegacyTurnCheckpoint(
        ref,
        conversation('conv-1', { projectId: 'other-project' }),
      ),
    ).toBe(false);
    expect(isExplicitLegacyTurnCheckpoint(ref, null)).toBe(false);
  });

  it('allows only targets whose complete rollback suffix is explicitly legacy', () => {
    const checkpoints = [
      checkpoint('legacy-old', 'conv-old'),
      checkpoint('runtime-middle', 'conv-runtime'),
      checkpoint('legacy-new', 'conv-new'),
    ];
    const identities = new Map<string, TurnCheckpointConversationIdentity | null>([
      ['conv-old', conversation('conv-old')],
      [
        'conv-runtime',
        conversation('conv-runtime', {
          sdkSessionId: null,
          runtimeSessionId: 'runtime-1',
        }),
      ],
      ['conv-new', conversation('conv-new')],
    ]);

    expect(
      [...selectLegacyRevertableTurnIds(checkpoints, identities, false)],
    ).toEqual(['legacy-new']);
  });

  it('fails closed for every legacy checkpoint after a provider-neutral project barrier', () => {
    const checkpoints = [
      checkpoint('legacy-old', 'conv-old'),
      checkpoint('legacy-new', 'conv-new'),
    ];
    const identities = new Map<string, TurnCheckpointConversationIdentity | null>([
      ['conv-old', conversation('conv-old')],
      ['conv-new', conversation('conv-new')],
    ]);

    expect(
      selectLegacyRevertableTurnIds(checkpoints, identities, true).size,
    ).toBe(0);
  });
});
