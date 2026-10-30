# Project Home

Project Home is the project-level boundary between the shelf and authored
content. Its canonical URL is `/project/:projectId`; `/home` is compatibility
only. Home is deliberately absent from `WorkspaceTarget`, desktop `openTabs`,
and mobile `papers`.

On desktop, Home keeps the complete workspace chrome and is represented by a
null active tab. Background tabs remain open. The desktop shelf supplies a
one-shot resume marker for existing projects; after Project Runtime has pruned
stale tabs, the shell resumes `lastActiveContentTabKey` or stays on Home. Direct
root navigation always means Home. Creating happens on Home (the former
session-only 新建… tab and its `/new` route are retired; `/new` redirects
Home): the dock's `+` and `⌘N` arrive with the create row floating at the foot
of the page, every other arrival floats the Agent, and Home scrolls to the top
each time. The structure, the floating sets and the create flow are specified
in `design-system/components.md` (「作品主页」) and
`renderer-ui-architecture.md` (Project Home create). The account cell's Home
action derives its active ink state from the root route, so it turns active as soon as the Dashboard is visible. Ordinary tab clicks retain
their established activation semantics; in particular, preview-tab clicks are
not overloaded as a Home toggle.

On mobile, Project Home is a controller surface separate from the paper deck.
The shelf always opens Home. Entity URLs open or activate real papers. Visible
and Android Back share the same order: transient/editor/panel layers, then
paper to Home, then Home to the shelf. Overview and Super Views remember
whether they were entered from Home or a paper. The top-right Settings action
navigates to the standalone `/settings` route and records the canonical project
root as its return destination; it never mounts the desktop-oriented
`ProjectDashboard` inside mobile Home. In an empty project, the New Chapter
action opens the Chapters structure overlay instead of sharing the Settings
navigation path.

Both platforms open with a General Agent entry and the check-in cards the
Agent prepared from recent changes (`agent-runtime/project-checkin.md`), and
both edit the project's `PROJECT_MEMORY.md` (desktop: the 设定 view; mobile:
end of the Home flow; see `agent-runtime/domain-crud-transaction-protocol.md`
§9). The mobile entry opens the full-screen voice Agent surface.

UI-storage v4 removes legacy desktop Dashboard leaves and collapses mixed
Dashboard splits. Mobile session v2 reads v1 once and filters
`dashboard:self`. These are renderer-state migrations only; SQLite, Yjs,
assets, and sync contracts are unchanged.

Machine acceptance:

```bash
pnpm exec vitest run src/renderer/app/project-home.acceptance.test.ts \
  src/renderer/store/project-checkin-store.test.ts \
  src/renderer/shells/desktop/project-home/project-home-create.acceptance.test.ts \
  src/renderer/shells/desktop/project-home/home-create.test.ts \
  src/renderer/store/ui-store.workspace-tabs.test.ts \
  src/renderer/shells/mobile/workspace/mobile-workspace-controller.test.ts \
  src/renderer/shells/mobile/workspace/mobile-workspace-session-storage.test.ts
```
