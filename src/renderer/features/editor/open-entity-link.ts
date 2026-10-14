import type { EntityLinkRef } from '../../lib/extensions/entity-link';
import { scrollToBlockWhenReady } from '../../lib/scroll-to-block';
import type { WorkspaceNavigator } from '../workspace/navigation/workspace-target';

/**
 * Open a clicked entity link. A location link (one carrying a paragraph anchor,
 * see docs/location-links.md) also lands on and flashes its cited paragraphs.
 */
export function openEntityLinkTarget(
  open: WorkspaceNavigator['open'],
  ref: EntityLinkRef,
  scrollToBlock: typeof scrollToBlockWhenReady = scrollToBlockWhenReady,
): void {
  // patch: no default destination yet.
  if (ref.targetKind !== 'node' && ref.targetKind !== 'element' &&
      ref.targetKind !== 'storyline' && ref.targetKind !== 'category') return;
  open({ entityType: ref.targetKind, id: ref.targetId });
  if (ref.targetBlockId) {
    scrollToBlock(ref.targetId, ref.targetBlockId, { endBlockId: ref.targetEndBlockId ?? null });
  }
}
