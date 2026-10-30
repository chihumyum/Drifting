import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closingPoint, DOCK_MARK_WIDTH } from './dock-leave';

const before = [
  { key: 'a', left: 100, width: 120 },
  { key: 'b', left: 220, width: 140 },
  { key: 'c', left: 360, width: 100 },
];

describe('a closed dock pill folds to where its neighbours meet', () => {
  it('folds between the slots that stay on either side', () => {
    // A centred strip: the left pill moves right and the right pill left by half the gap.
    const after = new Map([['a', { left: 170, right: 290 }], ['c', { left: 290, right: 390 }]]);
    expect(closingPoint(before, 1, after)).toBe(290);
  });

  it('folds onto the only neighbour that stays at either end', () => {
    expect(closingPoint(before, 0, new Map([['b', { left: 100, right: 240 }]]))).toBe(100);
    expect(closingPoint(before, 2, new Map([['b', { left: 220, right: 360 }]]))).toBe(360);
  });

  it('skips neighbours that close with it and folds in place when none stay', () => {
    expect(closingPoint(before, 1, new Map([['c', { left: 250, right: 350 }]]))).toBe(250);
    expect(closingPoint(before, 1, new Map())).toBe(290);
  });

  it('folds a pill back to the width a mark grows from', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/desktop-shell.css'), 'utf8');
    const grow = css.slice(css.indexOf('@keyframes dock-pill-grow {'), css.indexOf('@keyframes dock-pill-content'));
    expect(grow).toContain(`width: ${DOCK_MARK_WIDTH}px;`);
  });
});
