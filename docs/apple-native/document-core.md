# Shared document core: P2a contract

`crates/drifting-document` owns one Yrs document and one undo manager per
session. The existing renderer continues to use Yjs. The native lab's Swift
views now use this crate through the fixture ABI; production libraries remain
outside that ABI.

## Compatibility decisions

- Yrs is exactly `0.28.0` with its `sync` feature and the recorded local
  redone-offset, sparse-replay and undo deletion-filter fixes in [the vendored patches](../../vendor/yrs/DRIFTING_PATCHES.md).
  Original file/archive hashes and the MIT license are retained; the vendor
  checker permits the three recorded production correctness patches and one
  test-only awareness-clock change. Native document builds require
  Rust 1.96, tested locally and selected explicitly in the Apple CI lane.
  `cargo +1.88.0 test` fails inside Yrs on unsupported language syntax; no claim
  of Rust 1.88 compatibility is made for this new crate.
- Offsets are UTF-16 code units. Edits validate bounds and reject half-surrogate
  ranges before changing state. Grapheme navigation and marked-text composition
  remain native-view responsibilities in P2b.
- The `default` XML fragment remains authoritative. Semantic JSON is a read
  projection and is never loaded back into a live document after an edit.
  Unknown XML attributes, marks, atom nodes and unrelated shared roots survive
  import/export. Unsupported text embeddings and unknown block edits fail
  explicitly instead of flattening content.
- Local transactions use `native-local`; imports and remote updates use
  `native-remote`. Only the local origin enters undo history. Each command in
  this slice is its own undo unit; composition/typing grouping is a P2b task.
  Undo history is session-local, like the existing Yjs editor.
- Both v1 and v2 updates are accepted; native output and state-vector exchange
  are pinned to the published v1 format. Yrs 0.28 v2 emission of a shared array
  containing a binary value produces an update that Yjs cannot decode. Requests
  for native v2 output therefore fail explicitly. The compatibility harness
  verifies binary map/array/XML-attribute preservation for both input encodings
  through v1 output; v2 output must remain disabled until an upstream version
  passes this case. Format/embed values use JSON in v1: binary buffers, Undefined
  and non-finite numbers there are not losslessly representable. Checked encoding
  rejects them before remote integration and before v1 output, including
  pending structs and unknown shared roots. Ordinary JSON mark values retain
  their installed Yjs v1 behavior. This explicit limitation must not be reported
  as arbitrary v2-to-v1 format-value preservation.
  Full state serialization includes pending inserts and pending
  deletions; a snapshot/reload test covers dependencies arriving later.
  This does not establish the separate SQLite commit/replay/compaction contract.
- Anchors use Yjs-compatible relative-position bytes. A right-associated end
  position uses the containing type explicitly because indexed Yrs lookup
  returns no item there. An empty XML paragraph uses its element identity;
  start/end affinity maps to the first text child's start/end after typing.
  Resolution checks the live tree, so a removed parent invalidates the anchor.
  Split/undo testing exposed Yrs dropping the requested offset inside a restored
  item. The local patch carries that offset through each redone item and the
  regression checks the original anchor after undo, including an emoji span.

## Executed acceptance

The [native formatting contract](formatting.md) covers whole-selection inline
marks and real paragraph/heading conversion in one transaction and history unit.
Its cross-implementation scenario preserves links and typed metadata through
Yjs exchange and reopening; container unwrapping remains outside this batch.

`pnpm apple:document:acceptance` builds a real Rust process and drives it next to
the installed JavaScript Yjs implementation. The machine report is
[`acceptance/p2a-document.json`](acceptance/p2a-document.json).
`pnpm apple:document:check` checks that the passed report matches its source
fingerprint; `pnpm apple:check` includes this check.

The matrix covers both input encodings and v1 output; XML and mark semantics; unknown
objects, shared roots and binary values; targeted insert/delete/format/attribute
and top-level structure operations; bidirectional incremental exchanges;
concurrent local/remote undo and redo; empty paragraphs and endpoint affinity;
out-of-order duplicated updates across snapshot/reload; live/deleted anchors;
atomic rejection of unsupported edits; and 24 deterministic seeds with 12
rounds of two concurrent edits each. Each seeded round checks semantic equality
and both peers' state vectors. Failures retain the seed and synthetic trace.

The structural oracle imports the actual chapter schema, ProseMirror commands
and existing BlockId plugin. The corpus compares Enter, deletion, multiline
paste, headings, sibling paragraphs, paragraph/blockquote and nested-quote
boundaries, and entity-link affinity. Accepted cases check one-command undo,
stable IDs after redo and Yjs exchange. A scoped adjacent-quote join retains the
right physical wrapper and suffix instead of copying that subtree. Other cases requiring relocation of an
unselected suffix subtree assert atomic rejection instead; report counts
distinguish accepted edits from retained operations.
The comparison decodes y-prosemirror's hashed overlapping mark names, while a
separate raw-mark comparison verifies their exact keys and values survive.
Native copy/inheritance reads actual XmlText.diff attributes rather than the
JSON display projection. Dedicated Yjs checks preserve v1-canonical mark values
and typed binary XML attributes through split/join/inline input, history and
reopen. Rust separately checks in-memory Buffer/Undefined mark preservation and
entity-link affinity; those non-JSON marks are explicitly refused at the v1
wire boundary, not claimed to survive a format that cannot represent them.

The upstream suite has 378 self-contained tests, one upstream ignored test,
and seven explicitly excluded trace/dataset cases whose assets are absent from
the published crate. Its intermittent nested-array pending-update discrepancy
was reduced to three updates: append `A`, append dependent `B`, then insert `C`
into an independent root. Receiving 3, 2, 1 advanced the largest clock over a
hole; filling that hole did not retry `B`. The second local patch detects skip
set changes as well as clock advancement. It preserves unresolved pending data
and does not turn duplicate/empty updates into an endless replay loop.

Three native regressions cover every arrival order, checkpoints before all
dependencies arrive, multiple holes, pending deletes and later history. Another
36 Yjs/XML scenarios combine six orders, v1/v2 input and three restart stages,
then check concurrent local/remote edits, undo/redo and another restart. Partial
visibility while a same-client group is still pending is not assumed to match
Yjs; convergence, clocks and empty pending state must agree once all updates arrive.

[The diagnostic](acceptance/yrs-random-array-diagnostic.json), generated by
`node scripts/apple-yrs-diagnostic.mjs`, restores and verifies all original
upstream files, reproduces the failure with seed `15892911872676499736`, and
requires all 100 patched runs of that scenario to pass. Hash iteration still
varies; no failed patched attempt is retried into a pass. Its source fingerprint
and result hash are checked by the document evidence. This resolves the scoped
replay regression, not full P2 or the separate v2 output problem.

Integration issues found by the harness are covered: rejecting broken v2 binary
emission, the Yrs end-position case above, and an empty XML text child projecting
to `content: []` instead of omitting the content member. Mark order is normalized for comparison; content,
node attributes and unknown fields are not discarded by normalization.

## P2b binding and structure slice

AppKit `NSTextView` and UIKit `UITextView` render a UTF-16 projection of the
same synthetic Yjs fixture. Each text block carries its stable ID, global range,
nesting depth, marks and editability. Unknown atoms occupy one read-only object
replacement character; their actual XML and metadata stay in Yrs. Attributed
strings never replace the document core. A missing or duplicate ID disables
editing for that block.

Mac styling now retains the last displayed projection. An exact TextKit edit
within one nonempty block can restyle only that block and its separator when
other blocks, marks and comment ranges have only the expected offset changes.
An equivalent authoritative reply skips styling. Structural changes, format-only
updates, changed comment ranges and an invalidated composition cache take the
full path; marked-text commit and cancellation cannot retain temporary styles.
Eight style cases in the headless binding suite compare
every UTF-16 position against full `DocumentStyle.apply`, including heading/plain
fonts, bold/link/italic/strike and comment boundaries, Chinese/emoji, local edits,
authoritative refresh, structural fallback and real remote formatting. Comment-only
refresh is tested at the projection seam, not claimed as production comment sync.
The tests assert incremental, unchanged and full decisions; this is correctness
evidence, not a new performance measurement or physical-IME result.

Text identity throughout the Swift binding, queue validation and view/style
refresh is exact UTF-16. Swift's canonical Unicode equality considers NFC and NFD
equal even when their storage ranges differ; using it here dropped replacements
and left passive views with obsolete ranges. `NativeText.identical` uses
Foundation's literal equality for native and Cocoa-backed strings. The first
regression failed before this fix. Four identity cases cover
NFC/NFD, equal-length combining-order and Hangul diffs; passive-view refresh;
one-unit composition undo/redo; real peer update and SQLite reopen. Assertions
compare UTF-16 arrays, rather than canonically equivalent Swift strings. Selection
callbacks also check capture eligibility before any full-text comparison. This
preserves selection epochs while avoiding scans for pending or already captured
selection work. Hosted UIKit coverage exercises its own `UITextInput` replacement,
marked commit/unmark, passive-view refresh, native history and reopen paths.
That test first exposed a separate UIKit initialization bug: a second binding
already knew the shared prose while its new UITextView was still empty. Setting
up the control could send a responder-resignation callback, which was mistaken
for deleting the document. Input callbacks now stay suppressed until the first
projection render. The regression asserts that constructing a passive view
creates no draft before exercising the Unicode operations.

The current operation supports inline replacement, consecutive sibling
paragraph/heading replacements, and blockquote boundaries whose replacement
does not require moving an unselected subtree. The Rust owner validates the session revision,
UTF-16 boundaries and block identity before any mutation; delete plus insert or
split/join is one local undo transaction. Enter follows the old editor's heading
start/middle/end rules; fresh blocks receive UUIDv7 IDs. The surviving block
keeps its identity and live prefix. Moved tail text retains its exact marks.
Unknown block and XML-text metadata are copied/unioned with raw CRDT value
types, including binary buffers; conflicting values and shared attribute types
that cannot be relocated reject the whole operation before mutation. Covered quote wrappers are pruned when empty and
compatible unknown wrapper metadata is retained. For adjacent root quotes, the left
quote's sole nonempty paragraph can join the right quote while retaining its physical
wrapper, first paragraph and unselected suffix. This includes deleting just the
separator, and deleting a suffix of the left paragraph plus a prefix of the right
paragraph when both retain nonempty text. Replacement must be empty. For example,
`[b:潮汐] [c:夜航,d:终章]` with UTF-16 range `(1,3)` becomes `[b:潮航,d:终章]`.
The old separator-only case still permits an empty right boundary paragraph.
The merged paragraph receives the left public ID and style. The owner preflights
raw attributes, marks and UTF-16 slices, deletes only the selected right prefix,
then prepends only the retained raw left prefix within one local transaction.
The right tail, wrapper and unselected suffix keep their original CRDT items.
Two production-y-tiptap cases pass seven history stages each for remote suffix
edits, undo/redo and late updates to those original items, with independent reopens.
AppKit acceptance exercises the same operations through NSTextView and checks
the optimistic right-parent hint during immediately continued input.
The partial-deletion case also verifies two views, the passive selection on the
original right tail, three persisted comments and their original metadata,
continued-input redo across remote history stages, and SQLite reopen.
Remote edits to the copied left prefix follow the surviving right physical text
during undo; they are not transferred back to the restored left paragraph.
For the partial-deletion example, an aware peer inserting `远` before `潮航`
leaves `b:潮汐,c:夜远航,d:终章` after undo, matching the production binding.
A peer still editing the original physical left paragraph now has a separate,
scoped route. The structural transaction registers immutable source/copy item
spans and a persisted namespace for an unformatted retained prefix. A late plain
insertion is translated through its actual Yjs origins, with source clock
coverage and original text evidence retained. Two receivers produce identical
canonical text item IDs; packet segmentation, duplicate events and full-state
redelivery do not create extra text. Unresolved dependencies, fresh formatting,
deletes and other unsupported source graphs remain outside this route.

A packet may also contain safe text in the surviving right suffix. Raw-only
preflight identifies the exact string clocks that would be lost; only those
strings enter alias evidence and translation. Safe suffix strings keep their
original items, inherited marks, XML metadata and relative anchors. Independent
writers and same-writer prefix/suffix sequences preserve this distinction.
For suffix-then-prefix and prefix/suffix/prefix, an immutable receipt proves the
exact safe source clocks, text and parent outside the alias graph. Only these
proved gaps may become GC in the canonical writer; sparse source-evidence replay
uses Skip and never deletes or renumbers the original suffix. Existing marks on
safe suffix text remain valid. Proof survives a later legitimate suffix deletion
and history's new namespace, without resurrecting the deleted suffix. This gap
extension currently requires one unambiguous alias.
Any additional unmappable lost string refuses the entire packet before mutation.

Pending source bytes can join an incoming dependency update only when the
isolated raw candidate becomes complete. A pending last `b` in `b→d→b` can be
checkpointed and later completed by the first `b` plus `d`. A `d→b` update whose
`b` arrives first may have no missing item dependency: Yrs integrates a sparse
Skip and would discard that `b` under its deleted parent. The guard still refuses
this packet before mutation; DocumentSession can retry the complete combined
update once `d` is available. The durable owner now tries a complete remaining
stored tail after this specific atomic refusal. Every row is validated before
merge; the staged result must contain an explicit alias repair and no remaining
dependencies. Original rows, the System repair, comments and covering snapshot
obey the [same transaction contract](durability.md). Explicit cancellation that
needs no repair and partial recovery past an unrelated invalid tail row remain
outside this first lookahead path; retained data is never silently skipped.

Local structural history removes only receipt-owned render items before using
the existing UndoManager, then materializes the same original source graph at
the restored or joined paragraph. Its exact events are grouped into one authored
update. Relative positions on an earlier render follow source identity to the
active render, including new selections and comments on late Unicode text.
Aware-peer edits to the original surviving right tail retain their prior policy
above. If a peer changed the owned render or added unrelated text to restored
left `b`, history refuses before mutation instead of deleting those edits. The typed preflight refusal displays recovery guidance while keeping both views editable; it does not enter the persistent save-failure state.
Gap history also preflights the actual pure rematerialization planner with the
fresh namespace it will use. Conflicting proof receipts or an unsupported second
alias therefore refuse before dematerialization and UndoManager, preserving
prose, comments, selections, stacks and captured authored events.

Remote repair planning is pure. It reuses one raw-only loss preview on the
same immutable document basis and independently validates the combined repair.
The durability owner commits the System repair
journal, alias coverage, snapshot and comment CAS before applying those same
prepared bytes to the existing live owner. Pending local events join the same
transaction. Comparison of prepared version vectors uses logical clocks, not
unstable HashMap wire order. Cold replay supplies the same persistence context;
it cannot invent an unjournaled repair. The generated document report records
these separator-only and partial-deletion cases in `relocationAliasAcceptance`.
Ordinary Yjs peers see the repaired XML after receiving the native repair closure;
this is not independent legacy-client relocation support or a full P2 pass.

The conservative guard remains for unsupported loss. It protects unseen string
clock intervals, including previously pending strings whose dependencies arrive
later. Explicit incoming/prior pending deletes and already integrated intervals
are excluded. Isolated preflight precedes changes to revision, history, comments
or selections. The durable owner stores original validated v1 bytes first and
reports `remoteBlock` with their row ID and reason; `saved=false` means semantic
application is incomplete. Retry retains the same uncovered row. Checkpoint,
prune, further commits, history, close and bare export cannot omit that row.
Cold open retains it and stops. AppKit/UIKit preserve pending and marked input
and show the same blocked state across views. New styled original-left inserts
exercise this recovery path now that plain inserts can be reconciled. Ordinary
whole-block deletion/late insertion still has conservative arrival-order limits,
and the full-document preview cost requires a new performance measurement.
More general merges that must copy an unselected suffix could restore duplicate
public block IDs after remote input and undo. Those operations remain
explicit pre-mutation rejections pending a relocation/history policy. Unsupported
blocks and non-normalized carriage returns also reject explicitly. Code-block newlines
remain text. Native buttons and macOS Undo/Redo menus use the CRDT history;
the text controls' independent undo stacks are disabled.

Each replacement returns an exact before/after operation map for block ID and
UTF-16 endpoints. Comment mapping preserves original quote text and unknown
anchor fields, reports collapsed/deleted targets, and can create fresh CRDT
anchors that survive serialization/reload. The native owner now registers
SQLite comment anchors and attaches before/after anchor maps to each local
prose undo item. Undo restores only comments whose anchor revision still matches;
new comments and externally refreshed anchors are not overwritten. Remote prose
inserts survive local undo and continue to move the restored relative positions.

Comment `anchor_json` has an additive `nativeAnchorV1` object containing `start`
and `end` Yjs relative-position byte arrays. The existing v4 `textAnchor` fields
and target block IDs are refreshed, while original `text`, `selectedText`,
`blockSnapshots` and unknown fields remain intact. No published migration changes.
Malformed/unknown extensions remain untouched. Legacy anchors are seeded only
after quote validation, with nearest exact-quote and cross-block snapshot
fallbacks; stale offsets never select unrelated prose. Removed targets retain
their context and report unresolved/collapsed status. Resolved positions are
canonicalized onto live CRDT items before saving: undo-manager redone links do
not survive serialization, so persisting their old IDs would break after restart.

Native text views display a comment wash and original-quote status. The fixture
bridge commits exact authored updates, revision/provenance, immutable sync journal
and changed anchor fields in one SQLite transaction, then checkpoints the replayed tail.
It compares the prior anchor fields before updating and refuses external anchor
overwrites. Comment body, review status and other domain fields are not rewritten.
Injected comment-write failure proves the entire authored transaction rolls back;
retry and restart recover both together without a duplicate journal entry. This
does not implement production comment creation/deletion, domain sync or conflict
recovery. Inserting a paragraph break inside a quoted span retains its original
quote and mapped range while correctly reporting its text as changed.

One Swift `DocumentStore` owns the committed-input queue for a Rust handle.
Every `DocumentBinding` is a weakly registered view subscription with its own
composition draft. Views sharing a visible input branch receive ordinary edits
synchronously. Composition forks that branch after all preceding queued edits;
the composing view keeps its native marked range while other branches advance.
The branch authors each committed operation against the CRDT items still visible
to that view. Its incremental update merges into the live owner, so a remote
reply cannot shift a queued numeric deletion onto an unseen character. The
branch reply is checked against the exact queued target, separately from the
merged owner projection. Per-branch sequence numbers reject duplicate input.

After the queue drains, Rust captures a new merged branch and projection in one
call. If typing resumes before that reply, Swift discards the new branch and
drains those inputs against their previous basis first. It never freezes typing
for a merge or refresh. Only a quiescent reply replaces the displayed projection;
still-marked and rejected drafts remain untouched. Undo/redo and save failures
belong to the shared owner. A failed checkpoint pauses every writer while
retaining queued events; retry saves the accepted edit without reauthoring it,
then resumes the queue. Obsolete branch snapshots are explicitly released.

Detaching the last view does not drop pending input. If a detached event is
rejected, its optimistic projection and error keep the owner reachable; the
next view displays that recovery draft. Reopen refuses unresolved queue/draft
work. Explicit discard recovers the current committed projection. A view cannot
detach while it already has unsubmitted or rejected input.

The Mac lab can open a second editor window over that owner. Selections and
scroll positions stay per view. Other-view replacements map UTF-16 endpoints;
an entirely deleted selection collapses instead of selecting the replacement.
Each settled editable selection is registered in Rust as two Yjs relative
positions with a view identity and a user-selection epoch. Captures validate
the exact projection revision, reject half-surrogate ranges and stale epochs,
and never change prose revision, undo history, checkpoints or SQLite. Callbacks
from older captures cannot replace a newer user selection. Closing a view drops
its registry entry; reopen recaptures positions for the new document session.

Forward structural maps move registered endpoints when text changes containers
within supported sibling operations. Local history stores comment and selection
metadata together; it restores only matching epochs, so later manual caret
movement wins over old history. Remote inserts/deletes resolve through CRDT
identity. Rust ranges override optimistic UI shifts once their reply arrives.
An unresolved/deleted target or unsupported endpoint falls back to a clamped
view position. Supported sibling replacements now retain in-memory before/after
identity tapes, compressed by CRDT string item. Before undo/redo, a newer manual
selection is mapped through those item IDs and the original structural operation;
matching epochs keep their exact saved positions. Binary search resolves item
clocks through redone chains and remote prefix shifts without searching text or
allocating one anchor per UTF-16 unit. Empty/inserted blocks have explicit boundary
positions. Tapes are limited to affected blocks, stay with the undo item, and never
enter public updates or SQLite. Tests cover new selections after split/join,
repeated redo, multiple reconstructed ancestors, emoji, fragmented formatting,
remote offsets and actual AppKit selection callbacks. Arbitrary cross-container
structure is still outside this accepted slice.

Structural undo now preserves remote-owned text inside a copied subtree.
The installed old editor's `@tiptap/y-tiptap` collaboration plugin supplies
`defaultDeleteFilter` to Yjs: local children are removed before parents, and a
nonempty text/paragraph parent stays alive. Yrs 0.28 only had a commented
placeholder for this callback. The third recorded vendor patch restores an
optional deletion policy in both synchronous and asynchronous history; its
default remains unchanged for other consumers. A dedicated upstream regression
exercises both entry points.

The document owner protects all nonempty XML/text containers (including headings),
and retains attributes of a protected parent scheduled for deletion. This keeps
its ID, heading level and unknown metadata usable without disabling ordinary
attribute undo on pre-existing nodes. Matching the old plugin's content behavior
is separate from that metadata extension: the old plugin can undo a retained
paragraph's local attributes and relies on its later BlockId pass. Native
retained blocks are immediately identifiable and editable. New selections and
comments inside remote-owned text remain attached through undo/redo and restart;
a branch-end selection beyond a remote append is not mapped to the old copy's
endpoint.

The former failing diagnostic is now a positive matrix: twelve paragraph/heading
scenarios, each with two undo/redo cycles and Yjs checkpoint/reload checks. It
uses the old plugin's exported filter; headings opt into that plugin's supported
protected-node setting. Remote insertion, then deletion/formatting of that remote
text, remain visible. Deleting/formatting **locally copied** items follows the old
CRDT history semantics: undo removes those copied items and restores the original
items; redo restores the copy with its remaining remote changes. Such operations
are not transferred to the pre-split original items. The tests record this
boundary explicitly; they do not claim arbitrary cross-container move semantics
or production remote-replay acceptance. No prose string snapshot replaces CRDT
history, and no public encoding or database schema changes.

Native controls supply their actual replacement range through TextKit delegates.
Inferring that range solely from before/after strings is incorrect for repeated
characters: deleting the first `A` from `AAAA` otherwise appears to delete the
last. The binding keeps exact input ranges and the original composition range;
the repeated-text regressions verify CRDT selection and undo identity, including
a marked replacement whose initial visible string does not change.

Marked text remains in its native control while other views continue editing.
Inline replacements, including overlapping ones, merge by captured CRDT identity.
Cancel applies the merged committed projection without creating a prose
transaction. A rejected concurrent structural replacement leaves the visible
draft intact, allows other branches to keep editing, and requires the explicit
“放弃窗口草稿” action to discard it. Structural reconciliation remains required
before full P2 acceptance; a recoverable rejection does not pass that gate.

The Rust owner now also exposes ephemeral draft start/commit/cancel operations,
with matching fixture ABI and serial Swift transport. Start captures a binary
Yjs snapshot and exact original replacement range without mutating live prose,
history or SQLite. Commit authors the edit on that original CRDT state under a
fresh client identity, then merges its incremental update into the live owner
with the local undo origin. A concurrent insertion therefore is not part of the
authored delete set. One committed draft is one undo unit; duplicate commits
cannot reapply it. Authored selection positions resolve in the merged document;
a caret at the replacement end follows its own inserted text rather than the
next old character. Concurrent insertion order is CRDT-defined, not assumed by
string-offset tests.

Inline draft tests cover overlapping remote insert/delete/format, two overlapping
local drafts, source-relative selection, cancellation, rejected commits, duplicate
replay and Yjs exchange. An unchanged structural draft uses the standard operation
and comment maps; duplicate no-op replay does not invalidate that basis.
Concurrent inline changes outside the affected sibling blocks now also merge.
The gate compares element identity/order/parents, container metadata, affected
raw marks/attributes (including XML-text metadata) and normalized CRDT item tapes, so equal visible text with new
item identities cannot slip through. Current-to-merged maps account for changed
global offsets in comments, selections and history; the author branch retains
its old visible basis for already queued input. Rust and Yjs tests cover split,
join, remote insert/delete/format, both delivery orders, duplicate replay, undo
and reopen. A narrow same-paragraph extension permits an interior Enter with
either pure insertion or pure deletion strictly before the cut. The paragraph
must retain one XML text child, its physical identity, topology and raw block/text
metadata. The insertion path requires every original item and raw mark to survive.
The deletion path requires each live item span to be an ordered original span
with unchanged marks: gaps may only remove prefix items, and the complete copied
tail must remain intact. This permits deletion of the entire prefix, placing the
live split at zero. A right-associated CRDT anchor independently verifies the
computed cut against the first retained tail item.

Insertions at the cut or in the tail, tail deletions, mixed deletion/insertion,
replacement identities, changed surviving marks/metadata, headings and other
structural commands remain outside this extension. The operation map and
selection/comment history use live offsets while queued typing keeps its original
authored offsets. Six Rust deletion scenarios verify original comments and raw
metadata through two history cycles and reopen. Eight independent Yjs deletion
scenarios additionally cover fragmented prefix gaps, nonmonotonic item clocks,
NFD and emoji, both update orders and duplicate delivery, old-client edits to the
new tail and independent reopen. The six earlier insertion scenarios still pass.
The generated document report records the current Yjs groups and Rust test counts, including the new relocation and prepared-replay regressions.
Two actual AppKit cases deliver partial or complete remote prefix deletion
immediately before `NSTextView.insertText` for Enter and continued typing, with
no run-loop yield. They verify exact UTF-16 text in both views, native carets,
original comments, local undo/redo without resurrecting the remote deletion,
duplicate delivery and SQLite reopen. The binding suite also covers late original-left prefix routing in two native views, passive selection on the routed Unicode text, repeated history, duplicate delivery, Yjs export and SQLite reopen. Its generated report records all cases,
including two real AppKit cases for stored-but-unapplied remote updates with
queued or marked input, shared status, retry deduplication and blocked reopen.
Two recovery cases then deliver a missing safe-clock dependency through the
actual shared queue. While blocked, only remote jobs may bypass held local
fork/replace/drop jobs. The callback removes that exact remote job; successful
recovery resumes the original local order. An active marked branch keeps its
text, selection, input key and composition parent until native commit. The
recovery message clears the old blocked status without claiming the draft is
saved. Both cases verify local history, duplicate updates and SQLite reopen.
This scoped acceptance does not close the general same-block reconciliation gate.

Other same-block changes, changed topology, cross-container concurrency or
removed/ambiguous targets retain the draft. Those reconciliation gates remain open. Snapshots
are held in memory only. The standalone draft API allocates a fresh CRDT client per
commit. Native input branches reuse one author identity for sequential events
on the same branch; a 100-event test verifies a single new state-vector entry.
New fork/refresh generations still allocate distinct identities, so long-session
client-count/state-vector growth and full-snapshot-copy cost must be measured
and bounded before production use. Reusing identities across overlapping
snapshots must never reuse item clocks. This is not
an accepted final performance design or a durable marked-text recovery format.

The fixture bridge exposes full-state export and incoming updates for this
acceptance. Remote application during a draft saves only committed prose and
comment anchors. Unsaved state refuses further mutations; a successful commit
followed by a checkpoint failure is retried as persistence only, without
reauthoring text. Close/reopen and local history refuse active drafts until they
are committed or explicitly canceled. These are fixture-level boundaries, not
production reducer/journal/replay acknowledgements.

The native binding now uses the shared authored-edit mechanism through ephemeral
input branches (`documentInputFork`, `documentInputReplace`, `documentInputDrop`).
`DraftTransportAcceptance.swift` retains direct Swift/ABI/SQLite transport checks.
`InputQueueAcceptance.swift` exercises the actual AppKit callbacks and shared
queue with an independent fixture peer: overlapping remote composition,
immediate continued input, remote-before-local deletion, duplicate replay,
input injected during merged-projection refresh, local undo/redo and reopen.
Other-view overlap is also tested in `MultiViewAcceptance.swift`. Ordinary
marked text is never exported or persisted; only accepted commits are prose.
Native callers route incoming updates through `DocumentStore.applyRemote`,
not directly through `LabCore.applyRemote`.

Headless tests exercise real AppKit `setMarkedText`/`insertText` delegates,
interleaved view input, shared history, selection shifts, composition, cancel,
detach, orphaned-draft recovery, checkpoint fault/retry and restart. A UTF-16
boundary matrix retains the disjoint-transform regression. These are
programmatic same-process tests, not physical IME or desktop event synthesis.

Hosted UIKit tests now call the actual `UITextInput` methods on iPhone/iPad
simulators: marked commit/cancel, remote overlap with immediate continued input,
repeated-character insertion/deletion/replacement, unchanged initial marked text,
Unicode backspace, and first-responder resignation. They do not call binding
callbacks to imitate UIKit. These tests exposed that `insertText`, `replace` and
`deleteBackward` do not consistently call `shouldChangeTextIn`. The UIKit adapter
now captures exact replacement ranges at those native entry points and defers
intermediate delegate notifications until the whole operation finishes. Backspace
uses the original caret and UIKit's actual removal length, validates that this
exact deletion reproduces the resulting text, and retains unexpected changes as
recovery drafts rather than guessing among repeated characters. Permission checks
still run before mutation. `unmarkText` and successful responder resignation
explicitly publish the final composition once. AppKit standard responder actions
and dynamically validated menus route to Rust. UIKit exposes Cmd+Z/Shift+Cmd+Z,
undo/redo selectors and an UndoManager that only forwards to Rust and disables
registration. Neither control owns a second prose history. Pending operations
and active composition disable history across views; duplicate queued commands
cannot consume another undo unit.

The relocation cases use actual UITextInput replacement, two shared views,
selections on late original-left Unicode text and on the original suffix,
two UndoManager cycles, duplicate updates and SQLite reopen. The mixed case
receives late prefix and safe suffix text from one writer in one packet. The
interleaved case adds a later prefix insertion after the safe suffix clock gap.
Two further UIKit cases exercise stored dependency recovery with queued or marked
input, the passive view's original suffix selection, accurate recovery status,
continued native input, local-only history and SQLite reopen.
The native runner records hosted binding cases separately from simulator UI
flows for project/prose save, history and restart; the generated report owns
current counts. Run a focused iteration with
`pnpm apple:acceptance --binding-only --output=<report>` for programmatic AppKit
only. Current implementation and routine acceptance are Mac-only; iPhone and
iPad are deferred until the Mac migration is complete and the author discusses
other platforms. For future explicitly requested mobile runs, `--with-ios`
adds UIKit/iPhone, `--ios-only` selects mobile without Mac, and `--include-ipad`
also opts into mobile and includes iPad. Historical mobile outcomes remain tied
to their original sources. These checks do not prove
physical Chinese/Japanese input-method, keyboard-candidate or
background-interruption behavior.
Production remote-commit/replay ordering remains governed by the sync contract.

The fixture ABI now uses `crates/drifting-prose` for exact authored event capture,
atomic updates/revisions/journal/anchor writes, actual-ID tail replay and covered
snapshot/pruning in the published tables. A lost remote notification is repaired
before the final checkpoint. Checkpoint failures retain the document in memory,
stop further mutations and refuse close until save retry succeeds; already
committed updates are never authored again. Lab remote delivery persists before
live replay, but does not implement the full P4 remote receipt/deduplication path.
Synthetic project bootstrap remains outside the P3 domain authoring API. Real
projects must not be opened by this ABI. See [the durability contract](durability.md)
for process recovery evidence and remaining ownership/performance gates.

`pnpm apple:binding:acceptance` produces
[`p2b-binding.json`](acceptance/p2b-binding.json), including queue ordering,
Unicode, composition grouping, SQLite reopen and programmatic AppKit input.
It also covers Enter, separator deletion, structural undo, comment highlighting,
comment split/history/reopen and typing while a split operation is still queued;
hashed entity links are decoded for display. The cross-implementation harness
verifies native comment history with remote Yjs edits, post-redo checkpoint
resolution in both implementations, and the unchanged renderer's comment parsers.
The native runner separately exercises prose edit/undo/redo/reopen/process
restart and retained original-comment status through the iPhone/iPad simulator UI. Source fingerprints distinguish
these from older P1 runs. Full P2b is not complete.

## Remaining gates

P2b still owns general same-block/cross-container concurrent structural reconciliation,
unselected-subtree relocation across containers, and real IME/device interruption
behavior. The strict-prefix same-paragraph Enter extension, disjoint-block
structural drafts and the supported blockquote boundary
commands have the scoped automated coverage above. The structural corpus has
37 accepted old-editor comparisons and three explicit relocation rejections. The
old client's copied-suffix loss after redo is recorded separately as a diagnostic,
not an expected native result. Protected sibling-subtree undo has the scoped native/Yjs
coverage above; it is not arbitrary structural move acceptance. Shared ownership and local
multi-view behavior now have the scoped tests above. Comment anchors have accepted coverage
for supported sibling edits and fixture checkpoints; production lifecycle and
bidirectional domain sync remain P3/P4 work, including old-client structural
changes that cannot be followed through CRDT item identity alone.
P2c's storage slice now covers durable SQLite replay, acknowledgement, compaction
and process termination through the real owner; measured editor performance and
the current-editor comparison remain open. The initial project-name tests alone
do not cover these gates. Do not build the full product UI until P2 passes.

Implementation references: [Yrs 0.28](https://docs.rs/yrs/0.28.0/yrs/),
[relative positions](https://docs.rs/yrs/0.28.0/yrs/struct.StickyIndex.html).
Local cross-implementation tests determine acceptance, not API documentation.
