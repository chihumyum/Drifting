# Mobile Project Home management — 2026-09-05

Project Home now has an options button next to its title, with four actions:

- Project details: save the name and summary through `useProject.updateProject`.
- Writing goals: edit the project and daily word targets through the existing
  device-local writing-statistics store. Zero disables a goal; inputs require
  non-negative whole numbers. Home and shelf progress use the same project goal.
- Project Trash: open the existing project-scoped Trash surface and return to
  Home through the shared workspace Back resolver.
- Delete project: a separated destructive menu item opens a second dialog
  naming the project and explaining that its contents cannot be recovered.

The menu uses the shared body-portaled, fixed-position popover and menu styles.
Its rows and dialog actions retain 44px touch targets. Form inputs use 16px
text. The Settings gear keeps its existing standalone `/settings` route.

Saving/deleting is guarded against duplicate submission. While pending, the
dialog cannot be dismissed. Failed or rejected project writes retain the
dialog and show an error. The delete dialog initially focuses Cancel. Only a
successful `deleteProject` result invokes the shell's completion callback:
forget current and legacy mobile paper sessions for this project, then replace
the route with the shelf. Project content and durable deletion remain owned by
the existing transaction/repository implementation; no schema change or second
deletion path is introduced.

## Acceptance

The iPhone 17 Pro Simulator (iOS 26.5) ran a fresh Debug build with a synthetic
project created for this check. Simulator screenshots were visually inspected;
form input and additional menu actions used the explicitly `synthetic-dom`
frontend-debug bridge.

- The four actions fit in a secondary menu beside the project title; Delete is
  separated and uses the shared destructive color.
- Saving the name and summary updates Home. Project and daily goals of 80,000
  and 600 update the Home target to 80k and remain populated when reopened.
- Trash opens for the current project and Back returns to the same Home.
- Delete shows the correct project name and irreversible scope, focuses
  Cancel, and cancellation leaves the project and Home intact.
- Persistent project information and writing targets were rechecked after
  terminating and relaunching the Simulator app.
- Confirming deletion of this synthetic empty project returns to the shelf,
  removes both mobile session keys, and leaves the existing project visible.
  After another process restart, the deleted project remains absent.

Only the synthetic empty project created for acceptance was deleted. Project
cascade, rollback, prose and asset-inventory isolation additionally use the synthetic file-backed
`project-deletion-repo.integration.test.ts` suite. The new session-storage test
ensures a deleted project's old papers cannot reappear through the legacy
fallback and another project's session remains unchanged. The Home acceptance
contract checks menu placement, shared write owners, confirmation, error and
post-commit navigation wiring. Native IME/physical-device ergonomics remain
outside this Simulator/DOM acceptance.

The isolated commit candidate passed `pnpm ci:contract:check`,
`pnpm public:check`, `pnpm typecheck`, `pnpm lint`,
`pnpm agent:capabilities:check`, and `pnpm test --maxWorkers=2`.
The full suite passed 2,038 tests across 343 files, with one existing skipped
test/file. Lint reported zero errors and 35 existing warnings outside this change.
