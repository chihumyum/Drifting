# Super View navigation

The three full-window Super Views are overlays above the current editor route:

- `StoryGraphView`
- `SuperElementView`
- `SuperMemoMaterialView`

Closing a Super View sets `activeSuperView` to `none`. It does not mutate router
history, so the editor tab or singleton page that was visible before opening the
Super View is revealed intact.

## Escape contract

`Escape` walks outward one layer per key press:

1. A focused editor field or self-contained transient surface (modal, card
   popover, anchored popover, or context menu) consumes the key first.
2. Otherwise, the most recently opened view-local layer closes. This includes
   edge/link selection state and the bottom Drift Panel in Story Graph and Super
   Element, plus the bottom orphan/archive drawer in Memo & Material.
3. When no child layer is open, `Escape` closes the Super View and reveals the
   previous editor surface.

The shared `useSuperViewEscapeStack` hook owns steps 2 and 3. Child surfaces
must call `preventDefault()` and `stopPropagation()` when they handle `Escape`,
so one key press cannot remove two layers.

Expanded entity-card editors listen after the focused input or TipTap editor.
If that inner editor consumes `Escape`, the card stays open; otherwise the same
keypress closes the expanded card, including while `contentEditable` has focus.

## Machine-checkable acceptance

```sh
pnpm --dir client exec vitest run src/renderer/hooks/useSuperViewEscapeStack.test.ts
pnpm --dir client exec vitest run src/renderer/components/ui/EntityCardPopoverShell.test.ts
pnpm --dir client typecheck
```
