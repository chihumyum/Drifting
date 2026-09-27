# Entity links

Chapter prose and element bodies link element names, aliases and chapter
titles automatically, as the renderer's editor does. Links open their target,
show a hover summary, and the element page lists the chapters that mention it.

## Linking contract

`DocumentSession::link_entities` ports the renderer's auto-detect:

- The name map follows `buildEntityAutoDetectTargets`: every live element's name
  and aliases (store order), then chapter titles; a later entry for the same name
  wins while keeping the first position; empty names are ignored; a body never
  links its own element or chapter.
- Matching is verbatim and case-sensitive with no word boundaries, longest name
  first at each position, leftmost and non-overlapping, over UTF-16 units — the
  semantics of the renderer's single alternation regex. It runs per uniform mark
  run, merging adjacent runs with equal attributes as ProseMirror text nodes do.
- A run already linked to the same target is skipped; links to other targets stay
  alongside, because the mark does not exclude itself.
- Links are written under y-tiptap's overlapping-mark key
  `entityLink--<hash>` (lib0 `encodeAny` of `mark.toJSON()`, SHA-256 folded to six
  bytes, base64) with `{targetKind, targetId, targetBlockId: null}`, so the
  renderer editor reads them without rewriting. Readers accept the plain
  `entityLink` key too.
- The transaction has its own origin: it is captured as an authored, journaled
  Yjs update but is never an undo step, like the renderer's `addToHistory:false`.
  Undo reverts only typed text. Linking is skipped while a draft or composition is
  active; the host retries. Link marks are derived, so a structural draft (Enter)
  that crosses a link pass ignores them when reconciling its context.

The bridge builds the map from the workspace for each body and persists a
non-empty result. Hosts run it 500 ms after local input settles, when a body
opens, and for every open body after element or chapter names change
(retroactive linking). Closed chapters are linked when next opened, as in the
renderer.

The node names include drift titles after chapter titles, as the renderer's
map holds every live book node. Known difference, outside the verified fixture:
the renderer's retroactive pass on element creation matches each new name
independently, so overlapping names can both link (native reuses the
auto-detect pass, which is leftmost-longest).

## Backlinks

`workspaceElements` `backlinks` reads every live chapter's links from its open
owner or a cold durable read and reports, in book order, the chapters that link
the element with span and block counts and the first occurrence. `sources`
lists the drift, element, category and storyline pages whose bodies link it
(`{kind, id, title, spans, blocks, first}`, the element's own body excluded),
and `unavailableSources` the bodies that could not be read. Cold page bodies
are cached per Yjs revision. It reads live Yjs state; the renderer's
local-only `inline_mention` index is not written natively (the renderer
rebuilds it from Yjs on start).

## Mac interaction

`DocumentStore` schedules the pass for workspace bodies only. It runs once the
owner is idle — no queued input, composition, failed draft, failed save, remote
block or owner change — at once after a body opens or when names change, and
500 ms after committed typing, undo or redo settles. A pass is never counted as
pending input, so it holds neither typing nor navigation; later commands queue
behind it on the serial core queue. When it links anything, its state is adopted
like a format reply: views restyle with selection, scroll and history unchanged.
`MacChapterWorkspace` asks every open body of the project to link again when a
library reply changes live names or aliases (create, rename, alias edit,
restore) or the chapter titles change (create, rename, restore).

Links resolve against the project's live and trashed elements and chapters.
Element links take their category colour (the default blue without a live
category), chapter links the default blue, both underlined; links to trashed
targets are drawn in the secondary label colour without underline and cannot be
opened; links whose target no longer exists read as plain prose. ⌘-click on a
live link, or 打开「名称」 at the top of the prose context menu, opens the element
page tab or the chapter in the pane that showed the link. Resting on a link for
220 ms opens a popover with the name and category (章节 for chapters), up to three
aliases and the summary. An element page lists 被引用 under its fields: each
chapter as “N 处 · M 次” (blocks · links), opening the chapter and selecting the
first link while that range still links the element (otherwise it only opens),
and unreadable chapters as a muted line; then each linking page as
“漂流 · 标题 N 处 · M 次”, opening that page and selecting its first link the
same way, and unreadable pages muted. The list is read when the page is
shown and, while visible, shortly after chapter edits, link passes or chapter
list changes.

## Acceptance

`pnpm apple:workspace-link:acceptance` generates
[the entity link report](acceptance/p3f-entity-links.json): document and bridge
suites, then the exported native Yjs states are decoded by the renderer, their
keys compared with y-tiptap's, the renderer's own auto-detect is rerun on the
unlinked text and must produce identical links, and the renderer's reference
projection must agree with native backlinks. AppKit cases in the
[binding report](acceptance/p2b-binding.json) cover typing, retroactive linking,
navigation, target states and the backlinks section (page sources in
`--agent-tools-only`); `--editing-regressions-only`
covers Enter typed right after a linkable name while its pass is scheduled.
