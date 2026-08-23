import { useEffect, useLayoutEffect, useRef } from 'react';
import {
  MOBILE_WORKSPACE_BACK_EVENT,
  isMobileWorkspaceBackPreflight,
  type MobileWorkspaceBackEventDetail,
} from '../shells/mobile/workspace/mobile-workspace-back';

export interface SuperViewEscapeLayer {
  /** Stable while this specific surface is open. Include an entity id when it can switch in place. */
  id: string;
  active: boolean;
  onEscape: () => void;
}

type EscapeLayerOrder = ReadonlyMap<string, number>;

/** Returns the active layer that was opened most recently. */
export function resolveTopSuperViewEscapeLayer(
  layers: readonly SuperViewEscapeLayer[],
  openedAt: EscapeLayerOrder,
): SuperViewEscapeLayer | null {
  let top: SuperViewEscapeLayer | null = null;
  let topOrder = Number.NEGATIVE_INFINITY;

  for (const layer of layers) {
    if (!layer.active) continue;
    const order = openedAt.get(layer.id) ?? Number.NEGATIVE_INFINITY;
    if (order < topOrder) continue;
    top = layer;
    topOrder = order;
  }

  return top;
}

export function dispatchSuperViewEscape(
  layers: readonly SuperViewEscapeLayer[],
  openedAt: EscapeLayerOrder,
  onRootBack: () => void,
): string {
  const top = resolveTopSuperViewEscapeLayer(layers, openedAt);
  if (top) {
    top.onEscape();
    return top.id;
  }
  onRootBack();
  return 'root';
}

/**
 * Gives every Super View the same Escape contract:
 *
 * 1. A transient surface that consumes Escape keeps ownership of that press.
 * 2. Otherwise the most recently opened view-local layer closes.
 * 3. With no child layer left, the Super View closes and reveals the route/tab
 *    that was already underneath it.
 */
export function useSuperViewEscapeStack(
  layers: readonly SuperViewEscapeLayer[],
  onRootBack: () => void,
): void {
  const latestRef = useRef({ layers, onRootBack });
  const activeIdsRef = useRef<Set<string>>(new Set());
  const openedAtRef = useRef<Map<string, number>>(new Map());
  const sequenceRef = useRef(0);

  useLayoutEffect(() => {
    const nextActiveIds = new Set<string>();
    for (const layer of layers) {
      if (!layer.active) continue;
      nextActiveIds.add(layer.id);
      if (!activeIdsRef.current.has(layer.id)) {
        sequenceRef.current += 1;
        openedAtRef.current.set(layer.id, sequenceRef.current);
      }
    }

    for (const id of activeIdsRef.current) {
      if (!nextActiveIds.has(id)) openedAtRef.current.delete(id);
    }
    activeIdsRef.current = nextActiveIds;
    latestRef.current = { layers, onRootBack };
  }, [layers, onRootBack]);

  useEffect(() => {
    const dispatchCurrentLayer = () => {
      const { layers: currentLayers, onRootBack: currentRootBack } = latestRef.current;
      dispatchSuperViewEscape(currentLayers, openedAtRef.current, currentRootBack);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        isMobileWorkspaceBackPreflight(event)
      ) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      dispatchCurrentLayer();
    };
    const handleMobileBack = (event: Event) => {
      const request = event as CustomEvent<MobileWorkspaceBackEventDetail>;
      request.preventDefault();
      request.stopImmediatePropagation();
      dispatchCurrentLayer();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener(MOBILE_WORKSPACE_BACK_EVENT, handleMobileBack);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener(MOBILE_WORKSPACE_BACK_EVENT, handleMobileBack);
    };
  }, []);
}
