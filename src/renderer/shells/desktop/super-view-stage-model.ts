/** Which Super Views are on screen, and the push between them. */
export interface SuperViewStage<View extends string> {
  /** The open view; null when no Super View is open. */
  shown: View | null;
  /** Views pushed away but still on the strip, as they were when left. */
  behind: View[];
  /** The running push: `dir` 1 enters from the left (pushing right), -1 from the right. */
  push: { id: number; dir: 1 | -1 } | null;
}

/**
 * The stage after `next` is chosen. Switching from one open view to another
 * pushes along the switcher's `order`: toward the right when the new view
 * lies to the left (and the reverse), keeping the one left on the strip.
 * Opening and closing do not push, and closing drops everything at once.
 */
export function chooseSuperView<View extends string>(
  stage: SuperViewStage<View>,
  next: View | null,
  order: readonly View[],
): SuperViewStage<View> {
  if (next === stage.shown) return stage;
  if (!next || !stage.shown) return { shown: next, behind: [], push: null };
  return {
    shown: next,
    behind: [...stage.behind.filter((view) => view !== next), stage.shown],
    push: {
      id: (stage.push?.id ?? 0) + 1,
      dir: order.indexOf(next) < order.indexOf(stage.shown) ? 1 : -1,
    },
  };
}
