export interface NodeStorylineLinkState {
  nodeId: string;
  storylineId: string;
  isPrimary: boolean;
}

export interface DerivedNodeStorylineState {
  storylineNodeMapping: Record<string, string[]>;
  primaryStorylineByNode: Record<string, string | null>;
}

/** Derive the renderer's forward membership map and primary lookup from link rows. */
export function deriveNodeStorylineState(
  links: NodeStorylineLinkState[],
): DerivedNodeStorylineState {
  const storylineNodeMapping: Record<string, string[]> = {};
  const primaryStorylineByNode: Record<string, string | null> = {};

  for (const link of links) {
    const nodeIds = storylineNodeMapping[link.storylineId] ?? [];
    if (!nodeIds.includes(link.nodeId)) {
      storylineNodeMapping[link.storylineId] = [...nodeIds, link.nodeId];
    }
    if (link.isPrimary) primaryStorylineByNode[link.nodeId] = link.storylineId;
  }

  return { storylineNodeMapping, primaryStorylineByNode };
}

/**
 * Resolve the storyline that owns a chapter's presentation lane. A declared
 * primary wins only while it is still a current membership; otherwise use the
 * first hydrated membership as the same defensive fallback as timeline views.
 */
export function resolvePrimaryStorylineId(
  declaredPrimaryId: string | null | undefined,
  storylineIds: string[],
): string | null {
  if (declaredPrimaryId && storylineIds.includes(declaredPrimaryId)) {
    return declaredPrimaryId;
  }
  return storylineIds[0] ?? null;
}
