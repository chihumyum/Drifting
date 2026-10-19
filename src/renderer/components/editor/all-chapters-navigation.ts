export interface AllChaptersDestination {
  chapterId: string | null;
  blockId?: string;
  actId?: string;
}

function chapterRow(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector(`[data-chapter-id="${CSS.escape(id)}"]`);
}

// Whole-book anchors may not exist until their chapter has loaded. Keep the
// destination chapter laid out, wait for its actual prose, then scroll only the
// owning pane. Smooth scrolling against intrinsic-size estimates can finish at
// an obsolete offset as nearby rows hydrate.
export function createAllChaptersNavigator({
  getRoot,
  prepareChapter,
}: {
  getRoot: () => HTMLElement | null;
  prepareChapter: (chapterId: string) => Promise<unknown>;
}) {
  let cancelPending: (() => void) | null = null;

  const cancel = () => {
    cancelPending?.();
    cancelPending = null;
  };

  const navigate = (destination: AllChaptersDestination): Promise<boolean> => {
    cancel();
    const root = getRoot();
    if (!root) return Promise.resolve(false);
    const inputRoot = root.closest('.editor-body') ?? root;

    return new Promise((resolve) => {
      let cancelled = false;
      let frame = 0;
      const finish = (success: boolean) => {
        if (cancelled) return;
        cancelled = true;
        cancelAnimationFrame(frame);
        for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
          inputRoot.removeEventListener(type, interrupt);
        }
        if (cancelPending === interrupt) cancelPending = null;
        resolve(success);
      };
      const interrupt = () => finish(false);
      cancelPending = interrupt;
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
        inputRoot.addEventListener(type, interrupt, { passive: true });
      }

      const prepared = destination.chapterId
        ? prepareChapter(destination.chapterId)
        : Promise.resolve();
      void prepared.then(() => {
        if (cancelled) return;
        const started = performance.now();
        let alignedAt: number | null = null;
        let stableSince = started;
        const align = (now: number) => {
          if (cancelled) return;
          if (!root.isConnected || getRoot() !== root) return finish(false);
          const row = destination.chapterId ? chapterRow(root, destination.chapterId) : null;
          // prepareChapter resolves the read; React still needs to commit the
          // real row before its heading and layout are available.
          const ready = !destination.chapterId || row?.dataset.contentReady === 'true';
          const target = destination.actId
            ? root.querySelector<HTMLElement>(`[data-act-id="${CSS.escape(destination.actId)}"]`)
            : destination.blockId
              ? Array.from(row?.querySelectorAll<HTMLElement>(
                `[data-block-id="${CSS.escape(destination.blockId)}"]`,
              ) ?? []).find((element) => !element.closest('[aria-hidden="true"]'))
              : row;
          if (ready && target) {
            const rootTop = root.getBoundingClientRect().top + root.clientTop;
            const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
            const padding = parseFloat(getComputedStyle(root).scrollPaddingTop) || 0;
            const wanted = Math.max(0, Math.min(
              root.scrollHeight - root.clientHeight,
              root.scrollTop + target.getBoundingClientRect().top - rootTop - margin - padding,
            ));
            if (alignedAt === null || Math.abs(root.scrollTop - wanted) > 1) {
              // `instant` also cancels an older native smooth-scroll animation.
              root.scrollTo({ top: wanted, behavior: 'instant' });
              stableSince = now;
            }
            alignedAt ??= now;
            // Nearby lazy rows can change height after the first landing.
            // Reconcile their layout for a short quiet window, unless the user
            // takes over. Never require a manual wheel event to paint the row.
            if (now - stableSince >= 250 || now - alignedAt >= 2000) return finish(true);
          }
          if (alignedAt === null && now - started >= 3000) return finish(false);
          frame = requestAnimationFrame(align);
        };
        frame = requestAnimationFrame(align);
      }, () => finish(false));
    });
  };

  return { navigate, cancel, isNavigating: () => cancelPending !== null };
}
