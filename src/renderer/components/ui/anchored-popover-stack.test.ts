import { describe, expect, it } from 'vitest';
import { inPopoverAbove, isTopAnchoredPopover, openAnchoredPopover } from './anchored-popover-stack';

/** An element holding the given nodes. */
const surface = (...inside: object[]) => ({ contains: (node: object) => inside.includes(node) }) as unknown as Element;

describe('anchored popovers opened from one another', () => {
  it('counts a press on a list opened from a menu as inside the menu, and gives Escape to the list', () => {
    const option = {} as Node;
    const elsewhere = {} as Node;
    const menu = surface();
    const list = surface(option);
    const closeMenu = openAnchoredPopover(menu);
    const closeList = openAnchoredPopover(list);

    // The language list in the account menu: choosing a language does not close the menu.
    expect(inPopoverAbove(menu, option)).toBe(true);
    expect(inPopoverAbove(menu, elsewhere)).toBe(false);
    expect(inPopoverAbove(list, option)).toBe(false);
    expect(isTopAnchoredPopover(list)).toBe(true);
    expect(isTopAnchoredPopover(menu)).toBe(false);

    closeList();
    expect(inPopoverAbove(menu, option)).toBe(false);
    expect(isTopAnchoredPopover(menu)).toBe(true);
    closeMenu();
    expect(isTopAnchoredPopover(menu)).toBe(false);
  });
});
