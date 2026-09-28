# Version history

Chapter, drift, element and storyline bodies keep a device-local version
history (历史版本): snapshots of the full body state with a preview and the
entity's metadata at that moment. A past version can be previewed and restored.
Native only; no Tauri interoperability is kept.

## Domain contract

- A snapshot (`entity_snapshot_history`) stores the full Yjs state, the
  ProseMirror projection for previews and the metadata (title, summary and
  status for chapters and drifts; name, summary, group and facts for elements;
  name, summary and facts for storylines), with `reason` (`periodic`, `close`
  or `restore`) and the body's `wordCount`. Versions from before these two
  fields lack them.
- Saving a body captures a `periodic` version at most every 15 minutes (the
  check runs before the state is encoded); closing a body captures `close` and
  restoring captures the replaced state as `restore`, both regardless of the
  interval. A state identical to the latest version is never stored again, and
  a trashed body records nothing.
- Every version of the last hour survives; within 24 hours the newest per hour,
  then the newest per day; versions older than 30 days are deleted.
- Restore is a forward edit, since a CRDT cannot rewind: after saving pending
  input and capturing the current state, the body's owner replaces its blocks
  with deep copies of the version's blocks, attributes and formatted runs in one
  local, undoable edit. An open editor is restored in place; a closed body
  through a temporary owner. Comment anchors into removed text lapse. Only the
  body is restored; titles and other metadata stay as they are.

No SQLite migration is added.

## Native interaction

历史版本… sits at the trailing end of each editor pane's header, for the pane's
active chapter, drift, element or storyline page, and in 编辑 › 历史版本… (⌥⌘Y).
Once input has settled it opens a sheet on the window. The list shows versions
newest first: the time (刚刚, N 分钟前, 今天 or 昨天 with the time, M月d日, with
the year before this year; the exact time as a tooltip), the title or name and
a chapter's or drift's status at that time, why the version was kept (自动保存,
关闭时 or 恢复前) and its word count (“1,234 字”), and the first words. Older
versions without a reason or count show neither. The preview's heading
repeats both. The preview
shows the selected version read-only in the editors' typography with its
formatting — headings, bold, italic, underline, strike, URL and entity links,
alignment, block indent, quotes, list markers and horizontal rules (a
centred line) — from `workspaceHistory {"action":"preview"}`
(the version's native projection, read when it is first selected; a version
of another body is refused with “不属于”, and a failed read shows plain text).
It is compared with the current body paragraph by paragraph (a replaced
paragraph refined to its changed middle): text the current body lacks on a
green wash in its own formatting, text the version lacks inserted struck
through in the style around it, an identical version said as such. 标出与当前正文的差异 turns the marks
off. 恢复此版本… confirms that the current text is first kept as a version, that
only the body changes and that 撤销 undoes it. An open editor adopts the
restored state in place, as an accepted Agent revision does; its queued input
is refused first. The list is then read again. Refusals (a version of another
body, a missing version, queued input) stay in the sheet in Chinese.

## Acceptance

Document tests restore blocks, block IDs and marks exactly (same projection and
basis hash) with one undo step; core tests cover capture, interval, identity and
thinning; bridge tests cover capture on save and close, listing, restoring
closed and open bodies, undo and refusals.

Six programmatic AppKit cases in the [binding report](acceptance/p2b-binding.json)
(`--history-only`) cover the time labels and row details (reason and words,
and neither for older versions); versions captured on save and close without
journal rows, listed newest first with the title of their time, 自动保存 or
关闭时 and the word count, and reached from each page kind's pane header; the
marked and plain preview; a restore into an open chapter (one `yjs.update
prose-document` original, the editor updated, one undo step and redo, and a
later restore over newer text keeping it as 恢复前) and into a closed chapter
and an open element page; and refusals of a foreign or missing version, queued input and a
cancelled confirmation, all without changes. `--small-items-only` previews a
closed version with a heading, bold, italic, underline, strike, a URL link,
a centred and an indented paragraph against a changed body, checks each
attribute and the diff marks, the plain version with marks off, and a
foreign version's refusal.
