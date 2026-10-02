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
There is no ongoing recorder in the editor. The intermittent symptom remains
unresolved; a suspected input-method interaction is not a confirmed root cause.
The retained synthetic browser tests cover the composition guards and ordinary
caret/content preservation, without instrumentation or a forced selected-range
control.

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
The focused IME report includes 13 engine-selection checks and 15 review-decoration
checks. The separate focus report and the Markdown/MCP reports retain their own
source fingerprints and acceptance scopes.

After diagnostic removal, 50 targeted editor/projection/Copilot unit tests and
both focused browser runs passed; the current IME run has 13 engine-selection
checks without a live recorder. Targeted lint and diff checks passed. The earlier unrelated settings-navigation `Array.at` typecheck failure has been
resolved. Typecheck and the full Vitest suite now pass; the native input and
full-renderer limitations below remain open.

This report has its own kind and source fingerprint and cannot substitute for
full `--ci` or input-budget acceptance. The earlier full-harness Agent panel
ownership failure remains recorded in
[editor-focus-full-harness.failed.json](acceptance/editor-focus-full-harness.failed.json).
Native macOS candidate UI, physical typing, WebKit and the author's running
project have not been tested by this Chromium harness. No daily-use app restart
or release installation is implied.
