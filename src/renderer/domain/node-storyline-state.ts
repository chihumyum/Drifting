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
  const members = new Map<string, Set<string>>();
  const primary = new Map<string, string>();

  for (const link of links) {
    let nodeIds = members.get(link.storylineId);
    if (!nodeIds) { nodeIds = new Set(); members.set(link.storylineId, nodeIds); }
    nodeIds.add(link.nodeId);
    if (link.isPrimary) primary.set(link.nodeId, link.storylineId);
  }

  return {
    storylineNodeMapping: Object.fromEntries([...members].map(([id, nodeIds]) => [id, [...nodeIds]])),
    primaryStorylineByNode: Object.fromEntries(primary),
  };
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
