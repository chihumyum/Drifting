# IME composition and inactive Copilot

The October 2026 investigation follows reports of freezing while selecting
Chinese input candidates. These are verified competing code paths, not a
reproduction of the intermittent native WebKit symptom or an app-wide latency
measurement.

## Composition policy

An IME candidate pause must not be treated as an idle, completed edit. While
ProseMirror reports `view.composing`:

- The 400 ms derived prose projection timer waits instead of serializing the
  whole document. Explicit save and editor teardown still flush pending work.
- Automatic entity linking waits before scanning text or applying marks,
  including callers of the explicit auto-detect flush helper.
- Typewriter scrolling skips caret geometry, scrolling and caret repaint,
  including animation frames queued before composition began. Composition end
  schedules alignment again.
- Automatic Markdown projection waits before capture and checks again between
  asynchronous capture stages. Manual refresh and lifecycle flush remain forced.
- Automatic Copilot context preparation and TODO reconciliation wait. A pending
  TODO write cannot start an overlapping scan; a changed document is rescanned
  before any subsequent write uses the old marker snapshot.

These guards leave authoritative Yjs incremental persistence in place. They
defer derived work; they do not move all work to a background thread or interrupt
a synchronous scan already in progress. Yjs snapshots and other renderer work
remain outside the scope of this change.

## Intermittently selected pinyin

The reported abnormal state selects the whole uncommitted Latin composition;
normal input has only an underline and a caret. Being able to choose a candidate,
or having the highlight disappear on commit, does not establish that the expanded
selection is normal. It also occurs without pending Agent review marks, so the
review path below is not an established root cause.

The editor maintainer's [WebKit composition investigation](https://discuss.codemirror.net/t/bug-ime-selection-is-not-updated-when-decoration-mark-contains-multiple-decoration-replace-decorations/9785/4)
describes Safari changing marked-text selection after DOM changes before the
composition. This is a relevant browser mechanism, not a reproduction in Drifting.
Do not force a collapsed DOM selection during composition: it can abort the IME.

One competing path was verified: local edits with pending review recomputed the
diff and could remove a deletion widget before the caret. The controller now
lets the plugin map existing decorations during composition and delays its extra
rebuild until commit. A capture listener covers ProseMirror's initial DOM flush,
before `view.composing` is set. New review/masking state still installs immediately;
blur and disposal release the guard and pending timer. This prevents an extra
rewrite, not all ProseMirror DOM changes or widget replacement.

The focused runner also drives Chromium's engine through `Input.imeSetComposition`
and `Input.insertText`, yielding trusted browser composition/input events. Plain
prose, pending review and linked prose retain a collapsed caret, focus and exact
Yjs content through commit. The [historical investigation baseline](acceptance/editor-ime-selection-before.json)
recorded one review-decoration rebuild during composition; the current report
requires zero. Neither baseline nor current Chromium run reproduces the author's
spontaneous expanded-selection symptom; neither uses WebKit or the macOS IME.

The author's follow-up screenshot shows both the highlighted marked text and
the status bar's selected-word count. That count reads ProseMirror TextSelection,
not pixels. A local development trace independently captured matching expanded
DOM/PM ranges with focus retained and no Agent-decoration/entity-link transaction.
The trace predates that screenshot and does not establish its exact trigger.
The prose caret is already WebView-native; typewriter compensation is inactive
when typewriter mode is off. Removing that inactive path is not a fix.

The temporary live-selection recorder, native Selection method wrappers and
local diagnostic logging were removed when this investigation was stopped.
The development probe below later traced the symptom to ProseMirror's cursor
wrapper after an entity link.

### WebKit mechanism

WebKit's `Editor::setComposition` inserts each marked-text update as a selected
range and dispatches `input` before it locates the insertion again. Only if both
selection ends are still in one text node spanning the marked text does it
register the composition (underline) and apply the input method's caret;
otherwise the whole marked text stays selected without a composition.
ProseMirror listens to `input` on WebKit, so its mutation flush runs inside that
dispatch and records the selected range as editor state until the following
`selectionchange`. Either window can produce the symptom: a DOM change during
the `input` dispatch, or a transaction that writes that stale selection back to
the DOM before `selectionchange`. No Drifting path has been attributed to either.

### Development probe

Debug desktop builds install a [probe](../../src/renderer/lib/dev-ime-probe.ts)
(2026-10-05) that attaches to whichever editor receives `compositionstart` and
listens at the document, so composition events sent elsewhere after a focus
move are still seen. It appends JSON lines to `logs/ime-selection.log` beside
`renderer-stalls.log`:

| `kind` | Written when |
| --- | --- |
| `probe-installed`, `probe-attached`, `probe-error` | The page loads, the probe follows another editor, or setup fails. |
| `composition` | Every composition ends: counts of updates, expanded selections, repeated starts, focus losses and `focus()` calls, out-of-band transactions and their meta keys, Yjs remote applications, script selection writes and DOM child-list changes. |
| `baseline` | The first ordinary composition per page load, in full, as the engine's normal event order. |
| `focus-lost` | The editor or the window lost focus during a composition. |
| `compositionstart-repeated` | `compositionstart` arrives again before `compositionend`; WebKit only does this after losing its composition. |
| `after-input-expanded`, `selectionchange-expanded` | The DOM selection is still expanded after the `input` event or at a `selectionchange`. |
| `cursor-wrapper` | The first ten ordinary compositions per page load that start in ProseMirror's cursor wrapper, in full, for comparison. |
| `manual-dump` | ⌃⌥⌘I: the last five compositions in full. |

Full records list composition, input, selection and focus events,
transactions, `Selection` writes, `focus()`/`blur()` calls and script writes to
editor DOM nodes (with call stacks outside WebKit's own `input`/`selectionchange`)
and editor DOM mutations with the added and removed node shapes,
preceded by the last 30 entries. They hold positions, lengths, element shapes
and stacks, never prose; at most 20 anomaly records are written per page load.
Input methods that legitimately select marked text, such as Japanese clause
conversion, are reported too. The dev terminal announces every record except
`composition`.

```bash
pnpm exec vitest run src/renderer/lib/dev-ime-probe.test.ts
cargo test --manifest-path src-tauri/Cargo.toml --lib dev_watchdog
```

A temporary hook in the `--editor-ime` runner drove the first version in
headless Chromium through CDP: ordinary composition produced no report and a
composition with `selectionStart: 0` produced one. That version followed the
active-editor registry and wrote nothing when the author next saw the symptom.

In the running debug app, WebKit confirmed the expected order for ordinary
compositions: `input` carries the inserted range, ProseMirror adopts it, and the
next `selectionchange` collapses both to the caret. Two abnormal compositions
were captured on 2026-10-05 (01:50 and 02:00). Both started in ProseMirror's
cursor wrapper: the caret followed an `entityLink` mark, which is
`inclusive: false`, so ProseMirror's `compositionstart` handler set `markCursor`
and moved the DOM caret into a wrapper widget. On a following marked-text update
the paragraph's child list changed during the `input` dispatch; WebKit then
dispatched `compositionstart` again on every key and left the marked text
selected. Of 898 logged compositions, 56 started in the cursor wrapper; both
failures were among them and none occurred elsewhere. The author then reproduced it
on demand (three of three attempts) by composing right after a linked name with
plain text following it. Script DOM-write stacks show the mechanism: WebKit
composes in its own text node after the wrapper, while ProseMirror's model merges
the composed text with the following plain text. On every marked-text update,
inside WebKit's `input` dispatch, ProseMirror's composition protection
(`updateChildren` → `TextViewDesc.update`, then `protectLocalComposition` and
`renderDescs`) writes the merged text into the following sibling node, inserts a
fresh node for the remainder and removes the old one. WebKit lost its composition
within the first keys each time. Cursor-wrapper compositions at the end of a
paragraph, with no following text to merge, did not churn and did not fail. The
`blur` in the first capture was incidental.

### Fix: compose inside the link

Since 2026-10-05, `EntityLink` composes input-method text that starts at a
link's end inside the link
([entity-link-composition.ts](../../src/renderer/lib/extensions/entity-link-composition.ts)).
At `compositionstart`, before ProseMirror's own handler, the link counts as
inclusive for that composition only. ProseMirror then skips its cursor wrapper,
and WebKit composes in the link's existing text node, which the model agrees
with. After `compositionend`, once ProseMirror has ended the composition (or at
the next `compositionstart`, or when an end never reached the editor), the
characters past the link's original text leave the link. The document is the
same as before; while composing, the marked text shows in the link's color.

The option `composeInsideLinkEnd` defaults to Apple WebKit, where the symptom
occurs; other engines keep ProseMirror's path. Compositions after a link with
stored marks or another non-inclusive mark still use the cursor wrapper. A
dangling-link decoration around the link may still split its DOM.

The focused IME run drives both paths with trusted Chromium composition at the
caret after a linked word with text following it, and after a link the
auto-linker has just added. With the workaround off, ProseMirror inserts its
cursor wrapper and removes a text node on each of the six composition updates;
with it on, there is no wrapper, no node removal, the composition stays inside
the link, and after commit the link text is unchanged, the new text is plain
and Yjs matches. Unit tests cover the boundary detection, the inclusive window
and the strip.

In the author's debug app the workaround composed a following-text case inside
the link with no DOM writes (2026-10-05 02:32). One composition still failed
(02:30): it started 0.2 s after the auto-linker linked the just-committed name,
and on the first update ProseMirror rebuilt that paragraph's link span and the
21-character text node beside it. Chromium does not reproduce this with a link
at the paragraph end, the same target linked twice or a freshly added link; the
probe now records the paragraph's node shapes and mark runs to identify it.

### ProseMirror root cause

In prosemirror-view 1.42.4 (unchanged on upstream main as of 2026-10-05), a
composition in a cursor wrapper puts the browser's text in its own DOM text node
while the document merges it with the following text. On each update,
`updateChildren` falls through to `updateNextNode`, which skips the existing
`CompositionViewDesc` (not a `NodeViewDesc`) and destroys it, then
`TextViewDesc.update` writes the merged text into the following DOM node;
`protectLocalComposition` creates a new `CompositionViewDesc`, and
`replaceNodes`/`TextViewDesc.slice` create a new node for the remainder, which
`renderDescs` inserts while removing the old one. Chromium tolerates this;
WebKit loses its composition. The upstream repository moved to
code.haverbeke.berlin/prosemirror/prosemirror-view. A local patch reuses the
composition desc and the remainder's desc (claiming the browser's node on the
first update); in the focused Chromium run with Drifting's workaround off it
removed all six text-node replacements and passed the other checks. It and a
regression test in ProseMirror's composition suite are not yet submitted, and
that suite was not run.

## What closing Copilot means

With automatic Copilot off, capability debounce listeners and TODO parsing are
inactive. The manual command subscription and a cheap editor availability check
remain so explicit user commands still work. Closing an inline popover removes
its keyboard listener, span tracker, retained context and focus timer. Dismissal
does not force editor focus; accepting an edit intentionally returns focus.

The audit found and fixed remaining ownership gaps:

- A TODO loop that had awaited a comment write could continue creating or
  deleting comments after disabling or unmounting its owner. It now checks
  ownership, editability, composition and document identity between writes.
- Rolling summaries and finalization merges could persist a late provider
  response despite their abort signal. They now check cancellation before
  scanning and again after the response. Finalization cancellation occurs in
  layout-effect cleanup when its settings/owner changes.
- The popover's window capture listener could consume Enter/Escape after store
  closure but before effect cleanup, or during IME composition. Both the key
  handler and delayed focus callbacks now require the current invocation;
  composition keys remain with the input method.

A database operation already started may finish. Closing prevents subsequent
operations; it does not pretend that an already committed write was rolled back.

## Generated evidence

```bash
pnpm perf:renderer --editor-ime --output=docs/renderer-performance/acceptance/editor-ime.json
pnpm exec vitest run src/renderer/features/editor/entity-editor-session.test.ts src/renderer/features/editor/typewriter-scroll.test.ts src/renderer/services/markdown-projection.service.test.ts src/renderer/lib/copilot/summary-cancellation.test.ts
```

The [isolated browser report](acceptance/editor-ime.json) runs production React,
Tiptap/ProseMirror and Yjs with synthetic data. For 5k/50k/200k characters, a
1.3-second candidate pause must perform zero derived serializations, saves,
typewriter geometry reads or automatic link writes. After composition ends,
linking, saving and alignment resume, focus remains, and schema-normalized Yjs
replay matches the entire saved document (including marks and attributes).

The same command checks automatic-off editing, deferred IME context preparation,
disable during pending context, queued timer cancellation, 100 Copilot owner
cycles and 100 inline popover cycles. It verifies no retained keyboard/span
listeners, no stale close-time key interception, focus preservation, TODO
create/delete cancellation and existing inline edit/undo/conflict behavior.
Unit tests cover automatic Markdown deferral, explicit flushes, late provider
responses and current summary writes.

Validation results and source fingerprints are retained in the generated reports.
The earlier Markdown/MCP acceptance remains a separate gate from input selection.
The focused IME report includes 34 engine-selection checks, including the
after-link composition modes, and 15 review-decoration checks. The separate focus report and the Markdown/MCP reports retain their own
source fingerprints and acceptance scopes.

Typecheck, targeted lint and the focused browser runs pass; the native input and
full-renderer limitations below remain open.

This report has its own kind and source fingerprint and cannot substitute for
full `--ci` or input-budget acceptance. The earlier full-harness Agent panel
ownership failure remains recorded in
[editor-focus-full-harness.failed.json](acceptance/editor-focus-full-harness.failed.json).
Native macOS candidate UI, physical typing, WebKit and the author's running
project have not been tested by this Chromium harness. No daily-use app restart
or release installation is implied.
