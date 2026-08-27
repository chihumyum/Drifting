# Project Home

Project Home is the project-level boundary between the shelf and authored
content. Its canonical URL is `/project/:projectId`; `/home` is compatibility
only. Home is deliberately absent from `WorkspaceTarget`, desktop `openTabs`,
and mobile `papers`.

On desktop, Home keeps the complete workspace chrome and is represented by a
null active tab. Background tabs remain open. The desktop shelf supplies a
one-shot resume marker for existing projects; after Project Runtime has pruned
stale tabs, the shell resumes `lastActiveContentTabKey` or stays on Home. Direct
root navigation always means Home. Universal Create uses `/new` and remains a
session-only tab. Activating Universal Create from Home is a forward navigation
transition: the tab-store update may render before the router reaches `/new`,
so that intermediate Home frame must not clear the newly active create tab.
The header Home action derives its active ink state from the root route, so it
turns active as soon as the Dashboard is visible. Ordinary tab clicks retain
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

UI-storage v4 removes legacy desktop Dashboard leaves and collapses mixed
Dashboard splits. Mobile session v2 reads v1 once and filters
`dashboard:self`. These are renderer-state migrations only; SQLite, Yjs,
assets, and sync contracts are unchanged.

Machine acceptance:

```bash
pnpm exec vitest run src/renderer/app/project-home.acceptance.test.ts \
  src/renderer/components/editor/useSyncSplitFocusedUrl.test.ts \
  src/renderer/shells/desktop/entity-create/desktop-universal-create.acceptance.test.ts \
  src/renderer/store/ui-store.workspace-tabs.test.ts \
  src/renderer/shells/mobile/workspace/mobile-workspace-controller.test.ts \
  src/renderer/shells/mobile/workspace/mobile-workspace-session-storage.test.ts
```
