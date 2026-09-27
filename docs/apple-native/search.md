# Native project search

Mac opens 项目搜索 from its toolbar or Command–Shift–F: one query field over
the project. Chapter titles and prose come first; grouped sections follow for
章节摘要, 漂流, 设定, 分类, 故事线 and 素材. UIKit keeps its chapter-only search
from the chapter list and editor. Replacement and search in the 全书长卷 are
not ported. Native only; no Tauri interoperability is kept.

## Chapter titles and prose

The Rust workspace lists the project's current chapters and reads an existing
document owner when present. Other chapters use a temporary scoped reader over
the persisted snapshot and update tail. Search does not replace a live owner,
create history, checkpoint a document, or write a second text index. It reads
authoritative prose rather than the `contentJson` cache. Unresolved or unreadable
chapters are listed as unavailable; they are not silently treated as no matches.

Literal matching trims the query and lowercases Unicode scalars. Lowercase
expansions map back to whole original scalars and original UTF-16 ranges. There
is no normalization, locale-specific comparison or full case folding. Prose
matches stay inside one editable block and exclude structural placeholders.
Results retain chapter order and document order, with at most 100 title/prose
hits and an explicit truncation flag.

Each prose hit carries its full project/document lifecycle scope, two CRDT
relative anchors and the original matched text. Navigation opens or reuses the
chapter owner, resolves those anchors against current accepted prose and compares
the exact original text. A changed scope, replaced occurrence or unresolved
document refuses navigation. A temporary reader's revision or cached offset is
never used to select text in another owner.

## Global search

`workspaceSearchEntities` matches the same way over chapter summaries, drift
titles and summaries, element names, aliases, summaries and facts (“键：值”),
category names, storyline names and summaries, and material titles, text and
notes (up to three matches per field), and over the bodies of drifts,
elements, categories and storylines. A body is read from its live owner,
unsaved text included, or from a cold reader; a per-revision plain-text cache
skips cold bodies that cannot match. It writes nothing. At most 100 hits are
returned with a truncation flag; a body that cannot be read is listed as
unavailable. Body hits carry the scope and anchors of prose hits.

The panel lists each non-empty section under its heading (章节, 章节摘要, 漂流,
设定, 分类, 故事线, 素材). A row names the entity and the field (名称, 别名,
摘要, 设定项, 正文, 文字, 备注) above a one-line preview, with every occurrence of
the query emphasised on the system find highlight. Unreadable bodies are rows
of their own in their section (暂不可读取), truncation is a final row and part
of the status line, and neither can be chosen.

Choosing a row opens the entity as a tab in the active pane (a chapter for its
摘要) through the tab host; an entity missing from the libraries read so far
is read first. A material opens the 素材库 and selects its card once the list
has loaded. For a body hit the tab host waits until the page's owner is idle
(no queued, marked or failed input, the view showing current prose), then
`workspaceResolveEntityHit` resolves the anchors in that owner. Rust refuses in
Chinese when the page is not open, the body's scope changed (for example after
trash and restore), a draft is pending, or the matched text changed; the
refusal is shown in the panel and the selection is untouched.

## Stale results and input

The native view checks the returned live revision, current displayed text and
idle input state before selecting and scrolling to the match; a result made
stale by input in between is refused. Queued or marked input blocks choosing a
row and is never overwritten by navigation. Other pane selections and local
history remain independent, and navigation authors nothing. Superseded query
responses are discarded; clearing the query immediately clears the list.

## Acceptance

- Titles and live/cold prose are found without database writes, owner changes
  or new undo units. No-match, unreadable and capped results remain distinct.
- Anchors resolve after opening and after prefix edits; Unicode ranges select
  the original match. Replaced matches and changed lifecycle scopes refuse.
- Three global-search cases in `native/apple/Tests/GlobalSearchAcceptance.swift`
  (`--global-search-only`; [binding report](acceptance/p2b-binding.json)) drive
  the real panel controller, tab host, pages, 素材库 list, Rust workspace and
  SQLite with synthetic data: every section and field with emphasised
  previews, live and cold bodies without new owners or journal rows; element,
  storyline, drift and category body hits selected after text typed before
  the match; field hits, a chapter summary and a material opened; a replaced
  match, a changed scope, a draft in Rust and marked input refused; an
  unreadable body, truncation, and superseded and cleared queries.
- Rust bridge tests (`workspace_search_entities_tests.rs`) cover fields,
  bodies, resolution in an open owner only, live unsaved text and the cache.

The [workspace](acceptance/p3a-workspace.json), [binding](acceptance/p2b-binding.json)
and [native](acceptance/p2b-native.json) reports own exact source fingerprints,
test counts and outcomes. An earlier targeted Mac interaction checked
Command–Shift–F, repeated matches, opening a closed chapter from a prose hit and
split-pane search before global search existed; global search has no desktop
XCTest or physical-input run. Historical UIKit simulator results remain tied to
the sources they tested. No schema migration is added.
