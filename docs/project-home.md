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

On mobile, Project Home is the same `ProjectDashboard`, shown on the paper as
the desk's `home` stage: the dock shows no pill and its plus stands selected
(`docs/mobile-ui-foundation.md`). Opening a book picks up the paper the author
left; the plus goes to Home with the create row floating, the account cell's
torii with the Agent floating. Visible and Android Back share one order: the
desk's layers, then paper to Home, then (Android) Home to the shelf. Settings
from the account menu navigates to the standalone `/settings` route and
returns to the page it came from.

Both platforms open with a General Agent entry and the check-in cards the
Agent prepared from recent changes (`agent-runtime/project-checkin.md`); on
desktop the Agent section also offers an organize card for what the author
wrote since the last organize and shows the latest organize run
(`agent-runtime/project-organize.md`). Nothing on a card runs until the author
opens it, and the 设定 view's 主动建议 switch turns all of it off. Both
platforms edit the project's `PROJECT_MEMORY.md` in the 设定 view (see
`agent-runtime/domain-crud-transaction-protocol.md` §9). On mobile a card's
task opens the right desk on the Agent view it was routed into
(`revealDesktopAgentView` emits `agent:reveal`).

UI-storage v4 removes legacy desktop Dashboard leaves and collapses mixed
Dashboard splits. Mobile session v2 reads v1 once and filters
`dashboard:self`. These are renderer-state migrations only; SQLite, Yjs,
assets, and sync contracts are unchanged.

Machine acceptance:

```bash
pnpm exec vitest run src/renderer/app/project-home.acceptance.test.ts \
  src/renderer/store/project-checkin-store.test.ts \
  src/renderer/store/project-organize-store.test.ts \
  src/renderer/usecase/useProjectOrganize.test.ts \
  src/renderer/shells/desktop/project-home/home-agent.render.test.ts \
  src/renderer/shells/desktop/project-home/project-home-create.acceptance.test.ts \
  src/renderer/shells/desktop/project-home/home-create.test.ts \
  src/renderer/store/ui-store.workspace-tabs.test.ts \
  src/renderer/shells/mobile/desk/mobile-desk-controller.test.ts \
  src/renderer/shells/mobile/workspace/mobile-workspace-session-storage.test.ts
```
