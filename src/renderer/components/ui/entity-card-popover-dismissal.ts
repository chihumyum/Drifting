export function shouldDismissEntityCardPopoverOnKeyDown(
  event: Pick<KeyboardEvent, 'key' | 'defaultPrevented'>,
): boolean {
  return event.key === 'Escape' && !event.defaultPrevented;
}
