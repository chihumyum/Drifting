# Mobile search focus regression

Status: source repair complete; physical-device verification pending.

The regression had three coupled symptoms: Back from edit-owned Search fell to
read mode, deleting the final query character restored selected prose, and
Previous/Next dismissed the software keyboard.

The required behavior is:

- read -> Search -> Back returns to read and closes the keyboard;
- edit -> Search -> Back restores edit navigation, selection, caret, and the
  already-open keyboard;
- clearing the query leaves it empty;
- Previous/Next changes only the highlighted match and paper scroll position;
  it never focuses ProseMirror or dismisses the search keyboard.

Deterministic coverage lives in `mobile-workspace-controller.test.ts`,
`mobile-paper-search.test.ts`, and `mobile-v2-editing.acceptance.test.ts`.
Real iOS focus transfer and IME continuity remain user-owned device checks.
