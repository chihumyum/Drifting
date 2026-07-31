/**
 * Authority policy for the pre-runtime whole-turn checkpoint feature.
 *
 * The old checkpoint payload is only a UI diff and has no durable review or
 * long-task settlement semantics. It may therefore be used only for a
 * conversation that is durably and unambiguously a legacy SDK session, and
 * only while the project has never crossed into provider-neutral writes.
 */

export interface LegacyTurnCheckpointRef {
  turnId: string;
  convId: string;
  projectId: string;
}

export interface TurnCheckpointConversationIdentity {
  id: string;
  projectId: string;
  sdkSessionId: string | null;
  runtimeSessionId: string | null;
}

export function isExplicitLegacyTurnCheckpoint(
  checkpoint: LegacyTurnCheckpointRef,
  conversation: TurnCheckpointConversationIdentity | null | undefined,
): boolean {
  return Boolean(
    conversation &&
      conversation.id === checkpoint.convId &&
      conversation.projectId === checkpoint.projectId &&
      conversation.sdkSessionId?.trim() &&
      conversation.runtimeSessionId === null,
  );
}

/**
 * Return targets whose entire newest-first rollback suffix is legacy-safe.
 *
 * A target cannot skip a later checkpoint: the original algorithm composes
 * inverses newest-first. One ambiguous/provider-neutral row in that suffix
 * therefore makes the target unavailable rather than permitting a partial or
 * ledger-blind rollback.
 */
export function selectLegacyRevertableTurnIds(
  checkpoints: readonly LegacyTurnCheckpointRef[],
  conversations: ReadonlyMap<string, TurnCheckpointConversationIdentity | null>,
  providerNeutralProjectSealed: boolean,
): Set<string> {
  if (providerNeutralProjectSealed) return new Set();

  const revertable = new Set<string>();
  let suffixIsLegacy = true;
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    const checkpoint = checkpoints[index];
    if (!checkpoint) continue;
    suffixIsLegacy =
      suffixIsLegacy &&
      isExplicitLegacyTurnCheckpoint(
        checkpoint,
        conversations.get(checkpoint.convId),
      );
    if (suffixIsLegacy) revertable.add(checkpoint.turnId);
  }
  return revertable;
}
