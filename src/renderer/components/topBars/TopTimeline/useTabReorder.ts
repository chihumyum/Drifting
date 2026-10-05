import { useLayoutEffect, useRef, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { useUiStore, type AnyTab } from '../../../store/ui-store';
import { installTabReorder } from './tab-reorder';

export function useTabReorder(
  container: RefObject<HTMLDivElement | null>,
  projectId: string | undefined,
  tabs: readonly AnyTab[],
  widths: readonly number[],
) {
  const controller = useRef<ReturnType<typeof installTabReorder> | null>(null);
  useLayoutEffect(() => {
    if (!container.current || !projectId) return;
    const instance = installTabReorder(container.current, (from, to) => {
      // Update DOM order before measuring the final landing position.
      flushSync(() => useUiStore.getState().reorderTabs(projectId, from, to));
    });
    controller.current = instance;
    return () => { instance.dispose(); controller.current = null; };
  }, [container, projectId]);
  useLayoutEffect(() => { controller.current?.invalidate(); }, [tabs, widths]);
}
