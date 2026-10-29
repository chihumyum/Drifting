import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as motion from './motion';

const source = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
const root = (() => {
  const materials = source('src/styles/materials.css');
  return materials.slice(materials.indexOf(':root {'), materials.indexOf('}', materials.indexOf(':root {')));
})();
const cssValue = (name: string) => root.match(new RegExp(`--${name}: ([^;]+);`))?.[1];
const ms = (value: string | undefined) =>
  value?.endsWith('ms') ? Number(value.slice(0, -2)) : value?.endsWith('s') ? Number(value.slice(0, -1)) * 1000 : NaN;

describe('motion vocabulary', () => {
  it('gives CSS the same durations and curves as the module', () => {
    expect(ms(cssValue('motion-structural'))).toBe(motion.STRUCTURAL_MS);
    expect(cssValue('motion-structural-ease')).toBe(motion.STRUCTURAL_EASING);
    expect(ms(cssValue('motion-push'))).toBe(motion.PUSH_MS);
    expect(cssValue('motion-push-ease')).toBe(motion.PUSH_EASING);
    expect(ms(cssValue('motion-spring'))).toBe(motion.SPRING_MS);
    expect(ms(cssValue('motion-sweep'))).toBe(1125);
    expect(cssValue('motion-sweep-ease')).toBe('cubic-bezier(0.4, 0.1, 0.35, 1)');
    expect(ms(cssValue('motion-glass-bleed'))).toBe(240);
    expect(ms(cssValue('motion-glass-settle'))).toBe(280);
    expect(ms(cssValue('motion-glass-press'))).toBe(40);
    expect(ms(cssValue('motion-glass-drift'))).toBe(15000);
    expect(ms(cssValue('motion-flow-fade'))).toBe(320);
    expect(ms(cssValue('motion-loading-delay'))).toBe(240);
  });

  it('keeps the values the design system names', () => {
    expect([motion.STRUCTURAL_MS, motion.PUSH_MS, motion.PUSH_OUTLINE_FADE_MS, motion.SPRING_K, motion.SPRING_MS])
      .toEqual([420, 265, 340, 150, 520]);
    expect([motion.WAVE_BASE_MS, motion.WAVE_PER_ITEM_MS, motion.WAVE_MAX_ITEMS, motion.WAVE_SETTLE_MS])
      .toEqual([230, 70, 4, 300]);
    expect([
      motion.HOVER_PREVIEW_DELAY_MS, motion.HOVER_CARD_GRACE_MS, motion.SCROLL_REST_MS,
      motion.SELECTION_BAR_SETTLE_MS, motion.FORMATS_CLOSE_MS, motion.DOCK_COLLAPSE_DELAY_MS,
      motion.OPTIONS_CLOSE_MS, motion.DRAG_LEAVE_GRACE_MS, motion.PRESS_WINDOW_MS,
    ]).toEqual([220, 220, 180, 180, 140, 260, 160, 150, 1500]);
  });

  it('samples the spring from rest to exactly its end, never past it', () => {
    const points = motion.springEasing().slice('linear('.length, -1).split(', ').map(Number);
    expect(points).toHaveLength(25);
    expect(points[0]).toBe(0);
    expect(points[points.length - 1]).toBe(1);
    for (let index = 1; index < points.length; index += 1) {
      expect(points[index]).toBeGreaterThanOrEqual(points[index - 1]);
      expect(points[index]).toBeLessThanOrEqual(1);
    }
  });

  it('is the one place the numbers live', () => {
    // Components reference the names; none keeps its own copy.
    expect(source('src/renderer/components/Sidebar.tsx')).not.toMatch(/= 420;/);
    expect(source('src/renderer/shells/desktop/DesktopSidebarLayout.tsx')).not.toMatch(/= (420|340);/);
    expect(source('src/renderer/shells/desktop/TimelineDrawer.tsx')).not.toMatch(/= 420;/);
    expect(source('src/renderer/lib/sidebar-push.ts')).not.toContain('cubic-bezier');
    expect(source('src/renderer/lib/glass-wave.ts')).not.toMatch(/= (230|70|300);/);
    const tabs = source('src/renderer/components/topBars/TopTimeline/tab-reorder.ts');
    expect(tabs).not.toMatch(/const SPRING_|function springEasing|= 150;/);
    const slider = source('src/renderer/components/ui/GlassSlider.tsx');
    expect(slider).not.toContain('tab-reorder');
    expect(slider).not.toMatch(/= (520|160);/);
    expect(source('src/renderer/features/graph/chapter-lane-drag.ts')).not.toContain('= 150;');
    // CSS reads the custom properties; only materials.css's :root spells them out.
    for (const file of ['desktop-shell.css', 'ui-controls.css', 'index.css', 'act-rail.css', 'material-workbench.css', 'loading-status.css']) {
      const css = source(`src/styles/${file}`);
      expect(css, file).not.toMatch(/420ms|1\.125s|15s linear|cubic-bezier\(0\.32, 0\.72, 0, 1\)/);
    }
    const materials = source('src/styles/materials.css').replace(root, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(materials).not.toMatch(/1\.125s|15s linear|0\.04s|0\.28s|0\.32s/);
  });
});
