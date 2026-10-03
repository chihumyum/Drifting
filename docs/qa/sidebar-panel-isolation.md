# Desktop sidebar view isolation

Each view belongs to `(project, side, stable pane, Tab)`. Duplicate tabs can use
different sorting, display modes, filters, folds, selections and scroll positions.
Review additionally owns its scope and sort order. Library owns its relation
filter and relation visibility. Tab remounts and narrowing never transfer these
values to a different pane. Global/mobile preferences seed a new desktop view and
remain unchanged when that view changes a preference.

With one visible editor, the left sidebar highlights only that editor's current
entity in one matching pane. Inactive editor tabs and remembered pane selections
do not light up other rows when the sidebar widens, remounts or changes tabs.
If both panes show the same entity type, the focused matching pane owns the
highlight (otherwise the first matching pane). Project Home, creation and
aggregate views have no entity-row highlight. Split editors retain pane-local
selections; returning to one editor immediately restores the single highlight.

Review, Library and Stats continue to follow the current editor content. They do
not add independent entity selectors or pinning controls. Editing
project data, adding/deleting entities, sticky-note placement and Agent activity
remain shared domain operations. Agent conversation isolation retains its own
existing view/runtime boundary; account and model defaults remain app settings.

Display preferences persist across launches. Folds, local selection,
filters and scroll are retained in memory across tab switches/close/reopen. Dialogs
and menus are local mounted UI; changing Tab dismisses them. Mobile and standalone
panels retain their prior state owners.

Executable acceptance uses synthetic entities and real stores:

```bash
pnpm exec vitest run src/renderer/store/sidebar-panel-isolation.acceptance.test.ts src/renderer/shells/desktop/desktop-sidebar-tabs.acceptance.test.ts src/renderer/store/agent-chat-views.integration.test.ts
```

These checks cover pane/project/Tab identity, Review preferences, fold/selection/
filter/scroll retention under narrowing and unchanged global preferences, plus
single-editor highlight ownership across chapter/drift/element navigation,
sidebar widening, duplicate panes, Home and unsplitting the editor. The rendered
sidebar checks use the real shell and selection hook with synthetic entity rows.
They do not establish native input or real
provider acceptance.
