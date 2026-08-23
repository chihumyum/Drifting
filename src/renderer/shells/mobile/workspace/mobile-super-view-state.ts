import type { MobileWorkspaceSessionState } from './mobile-workspace-session';

export interface MobileSuperViewLocation {
  pathname: string;
  search: string;
  hash: string;
}

export interface MobileSuperViewReturnPoint {
  paperKeys: string[];
  activeKey: string | null;
  scrollTopByKey: Record<string, number>;
  location: MobileSuperViewLocation;
}

/**
 * Immutable paper/route identity captured before the independent full-screen
 * surface mounts. The optional live scroll value closes the debounce window
 * between a visible scroll and session persistence.
 */
export function captureMobileSuperViewReturnPoint(
  session: MobileWorkspaceSessionState,
  location: MobileSuperViewLocation,
  liveActiveScrollTop?: number,
): MobileSuperViewReturnPoint {
  const scrollTopByKey = Object.fromEntries(
    session.papers.map((paper) => [
      paper.key,
      paper.key === session.activeKey && Number.isFinite(liveActiveScrollTop)
        ? Math.max(0, liveActiveScrollTop ?? 0)
        : paper.scrollTop,
    ]),
  );
  return {
    paperKeys: session.papers.map((paper) => paper.key),
    activeKey: session.activeKey,
    scrollTopByKey,
    location: {
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
    },
  };
}

export function mobileSuperViewReturnPointMatches(
  returnPoint: MobileSuperViewReturnPoint,
  session: MobileWorkspaceSessionState,
  location: MobileSuperViewLocation,
  liveActiveScrollTop?: number,
): boolean {
  if (
    returnPoint.activeKey !== session.activeKey ||
    returnPoint.location.pathname !== location.pathname ||
    returnPoint.location.search !== location.search ||
    returnPoint.location.hash !== location.hash ||
    returnPoint.paperKeys.length !== session.papers.length
  ) {
    return false;
  }
  return session.papers.every(
    (paper, index) =>
      returnPoint.paperKeys[index] === paper.key &&
      returnPoint.scrollTopByKey[paper.key] ===
        (paper.key === session.activeKey && Number.isFinite(liveActiveScrollTop)
          ? Math.max(0, liveActiveScrollTop ?? 0)
          : paper.scrollTop),
  );
}
