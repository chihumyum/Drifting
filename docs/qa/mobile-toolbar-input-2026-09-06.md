# Paper toolbar input ownership and Agent surface

Date: 2026-09-06. Fresh native Debug build from the working checkout,
iPhone 17 Pro, iOS 26.5 Simulator, 402 × 874 CSS pixels.

- Native touch opened Plot and Timeline from prose editing. Each suspended the
  keyboard and editor focus; Back restored both and the original caret. Reducer
  tests also cover formatting mode, late blur callbacks, switching tools,
  Plot input dismissal, and discarding the return mode when leaving the paper.
- The Agent input reuses the unified accessory surface and Back component.
  Back lives in the lower action row. First Back dismisses the Agent keyboard
  while retaining its session; the next restores the original prose editor.
- Recent sessions extend upward from the accessory as one surface. Their bottom
  equals the input section's top, with no separator border or intervening gap.
  Selected conversations use a flat plane spanning all 402px, with a 44px header
  starting at y=70 below the status bar. Only the accessory is raised.
- With the native keyboard open, a native tap on Latest returned the log to its
  bottom without moving focus out of the composer. The log was scrolled through
  the frontend debug bridge before that tap. Session selection also retained focus.
- Native Send used a temporary local transport stub. The submitted prompt matched
  the synthetic input exactly, with no added context. Read-only startup retained
  input focus and the keyboard. This does not assert a live model response.

The generated `mobile-toolbar-input-2026-09-06.json` contains 17 evaluated
geometry, focus, return-state, and dispatch assertions. Synthetic conversations
and the synthetic TODO produced during interaction checks were removed. Temporary
transport overrides and Simulator keyboard settings were restored. Physical-device
acceptance remains separate.

The final history-picker check retains the accessory's rounded outer contour
until a session is selected. The selected conversation alone becomes flat.

In an isolated candidate excluding unrelated worktree changes, all six required
checks passed: `ci:contract:check`, `public:check`, `lint`, `typecheck`, `test`,
and `agent:capabilities:check`. Full Vitest: 2054 passed, 1 skipped; lint: 0 errors,
35 existing warnings. After the final presentation selector refinement, typecheck,
targeted lint, 50 focused tests, and the native history-picker check passed again.
