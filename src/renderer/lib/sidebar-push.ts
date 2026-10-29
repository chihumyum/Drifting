// A tab switch pushes a pane's strip of panels like heavy ice (PUSH_MS and
// PUSH_EASING in lib/motion.ts): slow to start, then fast. The glass block
// under the chosen panel tab rides the same push.

/** A panel on a sidebar pane's pushed strip and where it sits now, in px from the pane's left edge. */
export interface StripPanel {
  key: string;
  x: number;
}

export interface StripMove {
  key: string;
  from: number;
  to: number;
}

/**
 * Plans the push that brings `target` to rest at 0. The pane's panels form
 * one contiguous strip that always moves as a whole, so a switch made while
 * an earlier push is still running carries on from where everything is
 * instead of dropping or snapping a panel. Panels already wholly outside the
 * pane leave the strip. A target not on it joins at the end it enters from:
 * `dir` 1 enters from the left (pushing right), -1 from the right.
 */
export function planSidebarPush(panels: StripPanel[], target: string, width: number, dir: 1 | -1): StripMove[] {
  const kept = panels.filter((panel) => panel.key === target || Math.abs(panel.x) < width - 0.5);
  const others = kept.filter((panel) => panel.key !== target);
  const xs = others.map((panel) => panel.x);
  const start = kept.find((panel) => panel.key === target)?.x
    ?? (!xs.length ? -dir * width : dir === 1 ? Math.min(...xs) - width : Math.max(...xs) + width);
  const delta = -start;
  return [
    ...others.map((panel) => ({ key: panel.key, from: panel.x, to: panel.x + delta })),
    { key: target, from: start, to: 0 },
  ];
}
