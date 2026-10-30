import { useLayoutEffect, type RefObject } from 'react';
import { useUiStore } from '../../store/ui-store';

/** The parts of the workspace root that covering it touches. */
type CoverableRoot = Pick<HTMLElement, 'inert' | 'contains'>;

/**
 * While a Super View is open it covers the whole window and the workspace
 * under it is inert: no pointer, focus or key reaches it and it leaves the
 * accessibility tree, so nothing behind the Super View (the account cell's
 * Home, the sidebar toggles, a focused editor) can be used blind. Whatever had
 * focus in the workspace gets it back once the Super View has closed, unless
 * something else has taken it by then.
 */
export function coverWorkspace(root: CoverableRoot) {
  let restore: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const set = (covered: boolean) => {
    if (root.inert === covered) return;
    clearTimeout(timer);
    if (covered) {
      const active = document.activeElement as HTMLElement | null;
      restore = active && active !== document.body && root.contains(active) ? active : null;
      root.inert = true;
      return;
    }
    root.inert = false;
    const target = restore;
    restore = null;
    if (!target) return;
    // After React has taken the Super View away, and the focus it held.
    timer = setTimeout(() => {
      const active = document.activeElement;
      if (target.isConnected && (!active || active === document.body)) target.focus({ preventScroll: true });
    }, 0);
  };
  const dispose = () => {
    clearTimeout(timer);
    root.inert = false;
  };
  return { set, dispose };
}

/** Keeps the desktop workspace root inert while any Super View is open. */
export function useInertUnderSuperView(rootRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const cover = coverWorkspace(root);
    // Set straight from the store, so the workspace does not re-render.
    cover.set(useUiStore.getState().activeSuperView !== 'none');
    const unsubscribe = useUiStore.subscribe((state) => cover.set(state.activeSuperView !== 'none'));
    return () => {
      unsubscribe();
      cover.dispose();
    };
  }, [rootRef]);
}
