import { describe, expect, it } from 'vitest';
import { shouldDismissEntityCardPopoverOnKeyDown } from './entity-card-popover-dismissal';

describe('EntityCardPopoverShell Escape dismissal', () => {
  it('dismisses an expanded card when Escape was not consumed by the editor', () => {
    expect(
      shouldDismissEntityCardPopoverOnKeyDown({ key: 'Escape', defaultPrevented: false }),
    ).toBe(true);
  });

  it('keeps the card open when an inner editor surface consumed Escape', () => {
    expect(
      shouldDismissEntityCardPopoverOnKeyDown({ key: 'Escape', defaultPrevented: true }),
    ).toBe(false);
  });

  it('ignores unrelated keys', () => {
    expect(
      shouldDismissEntityCardPopoverOnKeyDown({ key: 'Enter', defaultPrevented: false }),
    ).toBe(false);
  });
});
