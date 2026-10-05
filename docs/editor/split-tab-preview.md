# Split tab preview lifecycle

Each side of a desktop split owns the same `LeafTab.isPreview` state as an
ordinary tab. A single click focuses it; a double click on its label pins only
that side. Existing edit promotion and the pin shortcut act on the focused
side. Preview labels are italic; dedicated labels use normal text.

- Splitting existing tabs preserves their preview/dedicated states. A new
  entity opened into a split starts as a preview.
- Opening an entity that already exists activates its tab or split side.
- A new entity preview replaces only the focused split preview. Its sibling,
  split identity, and width ratio stay unchanged.
- When the focused side is dedicated, both sides remain open. The target uses
  the ordinary top-level preview slot, replacing that preview or appending one.
  An unfocused split preview is never used as a replacement slot.
- Explicit dedicated opens and All Chapters follow the ordinary top-level
  rules. Explicit drag/context-menu split operations may move a new entity
  into a selected side; an entity displaced by that action returns to the strip.
- Session persistence preserves each side's state. Extracting, closing one
  side, or dissolving a split retains the existing dedicated-survivor behavior.

No SQLite or Yjs migration is needed. Existing splits with dedicated leaves
stay dedicated and are protected from subsequent preview navigation.

## Acceptance

Run `node scripts/run-split-tab-preview-acceptance.mjs` to regenerate
[`acceptance/split-tab-preview.json`](acceptance/split-tab-preview.json), then
run the same command with `--check` to verify the source fingerprint. It covers
the store transition matrix, session restoration, and the production tab strip
with the desktop navigator in an isolated Chromium profile using synthetic
entities. Browser checks include both double-click targets, italic state,
focused-preview replacement, dedicated-side preservation, existing-target
activation, and URL changes. Native Tauri input and prose-editor/IME behavior
remain separate acceptance boundaries.
