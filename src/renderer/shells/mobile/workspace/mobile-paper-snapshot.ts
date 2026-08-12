import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { isProseEntityType, proseDocId } from '../../../lib/yjs-doc-id';
import { getLiveYDoc } from '../../../lib/yjs-doc-registry';
import type { MobilePaper } from './mobile-workspace-session';

/** Capture the exact prose currently shown by the one live mobile editor. */
export function freezeLiveMobilePaperContent(paper: MobilePaper): string | undefined {
  const { entityType, id } = paper.target;
  if (!isProseEntityType(entityType)) return undefined;
  const liveDoc = getLiveYDoc(proseDocId(entityType, id));
  if (!liveDoc) return undefined;
  return JSON.stringify(yDocToProsemirrorJSON(liveDoc, 'default'));
}

export function mobilePaperSnapshotIsLoading(
  paper: MobilePaper,
  frozenContentJson: string | undefined,
  nodeProjectionResolved: boolean,
): boolean {
  return (
    paper.target.entityType === 'node' && frozenContentJson === undefined && !nodeProjectionResolved
  );
}
