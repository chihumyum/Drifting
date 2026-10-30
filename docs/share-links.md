# Share links

An author shares one entity's body (a chapter, drift, element, storyline or
category) as a link. Anyone holding the link reads it in a web page; a reader
signed in with a Drifting account comments on a passage, and the comment
arrives in the author's library as an ordinary anchored comment. The author
keeps writing, and the page follows a few seconds after each pause. This is the
first phase (2026-10-30): no replies, no co-editing, no whole-book link.

Share links are a Hosted feature. Service-disabled (local-only) builds show
only the Markdown part of the share dialog and load none of this code.
The service contract is the private service's `docs/share-link-v1.md`.

## What leaves the device

Only the entity the author shares, as a reader copy built from its live Yjs
prose: block ids, text, bold/italic/strike/underline, http(s) links, headings,
quotes, alignment, indent and rules. Each entity the text links to travels as
its name, summary and link colour, nothing else, under a short key (`e1`, `e2`…)
rather than its id; links to patches and to untitled, trashed or deleted entities
become plain text. A summary can give away what the text has not yet said: readers
see it on hover. The folio adds the chapter's place in reading order, the name
and colour of its storyline (a drift's group, an element's category) and the
word count. The author's own comments, TODOs, relations, fields and the rest of
the project never leave. The service can read the copy; the link token is the capability,
so anyone holding the link can read it and every reader sees every comment.
The account's display name is shown to readers as the sharer.

## Author side

- **Dialog.** Editor menu → Share opens one dialog: the link section
  (`features/share-links/ShareLinkSection.tsx`) above the existing Markdown
  export. Signed out, it offers sign-in. Signed in, **Create share link**
  publishes the copy and copies the URL; then the dialog shows the link, a
  copy button, **Allow comments**, the version number and **Stop sharing**
  (two-step). Stopping deletes the link and readers' comments still on the
  service; comments already imported stay in the library.
- **Link list.** The service owns the account's links;
  `share-link-store.ts` caches them per account and replaces the cache on
  account change. **Share links** in the user menu (project and bookshelf)
  and **Settings → Account → Share links → View** open one dialog
  (`ShareLinksDialog.tsx`, mounted once at the app root) listing every link
  grouped by project: the entity's mark and title (opening it, in whichever
  project), its version, the comments switch, copy and two-step stop. Links of
  projects not on this device are grouped apart and do not open.
- **Republishing.** `share-link-publisher.ts` runs per open project. After
  authored commits or remote changes it waits for the author to pause (the
  Markdown projection's worker: 5 s quiet, 30 s at most, deferred during IME
  composition) and re-sends every link of the project whose copy changed.
  The copy hashes the same on both sides (`shared/share-document.ts` keeps the
  service's key order), so an unchanged body is never sent and keeps its
  revision. Linked entities and the folio are part of the copy, so renaming an
  element, editing its summary or moving the chapter republishes it too. Link
  colours follow the author's link colour setting through the editor's own
  resolver while the project is open. Closing the project sends what was written since the last pause.
  A trashed or deleted entity is not republished.

## Readers' comments in the library

`share-inbox-runtime.ts` polls the account inbox every 15 s while Drifting is
in front and every 60 s otherwise, and on focus, network return and resume.
Accounts without links make no inbox request (the link list is reloaded at most
every 5 minutes). Each pass (`share-inbox.ts`):

1. **Import.** A reader's comment becomes a `note` on the shared entity with
   the service's comment id, `authorKind: 'external'`, the reader's display
   name, `source: 'api'` and `metadataJson.shareLink`. Its anchor has the
   editor's shape (block ids, offsets, snapshots, text anchor), so it is
   painted, re-located and flagged as changed like any comment. It is written
   through the authored journal and reaches the author's other devices by
   sync. Two devices importing at once write the same row.
2. **Acknowledge.** Imported ids are acknowledged so no device imports them
   again; a comment the author deletes is not resurrected. A project this
   device has not restored is left for a device that has it.
3. **Withdrawals.** A comment the reader withdrew after import is deleted
   locally (with its relations) and acknowledged.
4. **Status.** The status of every imported comment on this device is compared
   with what readers see; resolved and converted comments show as resolved,
   reopened ones as open.

Review cards and sticky notes label these comments `读者 · <name>`.

**On the page at once.** While a project is open (`reader-comment-rail.ts`),
every open reader comment goes on its entity's sticky-note rail, which opens:
the ones already there when the project opens and each that arrives, imported
here or synced from another device, newest on top. The rail's membership is
session UI, so each is pinned once per session; one the author takes off stays
off until the project opens again. Resolved ones are not pinned.

**Notification.** Each inbox pass that imports comments posts one notification
per shared entity in the notification center (`share-comment-notifications.ts`):
the entity's title and `reader: comment`, or the count, in the comment colour.
It opens the entity, in whichever project it is. Only the device that imports
a comment notifies; another device receives the comment through sync.

## Reader page

`src/share-web` is a separate Vite entry (`vite.share-web.config.ts`, base
`/s/`), served at `/s/<token>` on the Hosted origin. It reads like the editor's
page and reuses its code rather than imitating it:

- **Layout.** A scroller with the sheet in a spread, as in the editor, under
  the same tokens, light and dark. The folio reads 「第 N 章」, the storyline's
  mark and name, and the word count.
- **Outline rail.** At 1260 px and wider, the editor's rail at the left edge
  (`outline-rail-model.ts` and `OutlineViewportController`): heading labels at
  their measured places, the reading location in bold ink, dense stretches
  behind an omission handle, a click scrolls to the heading.
- **Entity links.** The editor's dry sand underline in the link's colour.
  Pointing at one (focus, or a tap on touch screens) opens a card with the
  entity's kind mark, name and summary, portalled to the body; scrolling,
  Escape or leaving the link closes it. Links do not navigate.
- **Comments.** Drawn in sand over the words by the editor's
  `CommentSandPainter`: open comments rest as a light swash, the one whose card
  is pointed at turns stronger, and the passage being commented on is drawn
  along its lines. Resolved comments keep their card without sand. A passage
  the author has since rewritten is marked "changed".

A reader selects text (the same anchor rules as the editor:
`share-web/anchor.ts`), signs in or signs up with email verification without
leaving the page (the service's HttpOnly cookie, never a stored token), posts
and withdraws comments, and the page polls every 10 s while visible. Wide
screens show a comment rail; narrow ones a bottom sheet. The page sends no
`Referer`, and is `noindex`.

```bash
pnpm share-web:build   # static files in dist-share-web/s/
pnpm share-web:dev     # http://localhost:5180, proxies /api to DRIFTING_HOSTED_ORIGIN or :3000
```

Deployment copies `dist-share-web/` into the service's `share-web/`
directory; see the service's production runbook.

## Development against a local service

Run the private service's Docker stack, then `pnpm share-web:dev`. Start the
desktop client with `VITE_SHARE_WEB_ORIGIN=http://localhost:5180` so links point
at the development reader (`pnpm dev:worktree --online` passes it through).
A worktree profile's renderer origin (`devUrl` in `--print-config`) must be in
the service's `CORS_ORIGINS` for sign-in and share requests.

## Limits of the first phase

- No reply threads and no reader notifications; readers see only resolved or
  open.
- Deleting an imported comment keeps it visible to readers.
- A withdrawal acknowledged by a device that had not yet received the import
  leaves the imported copy in place.
- Images, materials and the whole book cannot be shared as links.
- The author UI is desktop-first; mobile is not covered.

## Acceptance

- `src/shared/share-document.test.ts`: the copy matches the editor's block
  text, so comment offsets agree; entities are keyed in reading order with
  name, summary and a stored colour form only; the folio is normalized.
- `src/share-web/anchor.test.ts`: reader anchors, trimming, re-location.
- `src/renderer/features/share-links/share-inbox.integration.test.ts`: import
  on real SQLite, duplicate imports, withdrawals, status reports.
- `src/renderer/features/share-links/share-links.hosted.integration.test.ts`:
  against a local service — publish with a linked entity and the folio,
  identical hashes, reader comment, import, resolution and reopening,
  withdrawal, stop sharing.
- `src/renderer/features/share-links/reader-comment-rail.test.ts`: open reader
  comments pinned per entity, newest on top, once per session; others left alone.
- `src/renderer/features/share-links/share-comment-notifications.test.ts`: one
  notification per shared entity, reader and excerpt or count, entity target.
- `pnpm hosted:acceptance` includes these suites in
  [`hosted-sync/acceptance/client.json`](hosted-sync/acceptance/client.json).
- Manual end-to-end run (2026-10-30): local Docker service, an isolated
  `--online` desktop profile driven through the Frontend Debug bridge, and the
  reader in a browser at desktop and phone widths. The author created a
  chapter link; a second synthetic account signed in on the page and
  commented; the comment appeared in Review as `读者 · 合成读者` within the
  background poll; resolving it showed "Resolved" to the reader; a new
  paragraph reached the page as version 2. Production deployment is not
  claimed.
- Reader run (2026-10-30, editor features): a synthetic chapter with three
  heading levels, four linked entities, the folio and two comments, at 1300 px
  (outline, comment rail, hover card, sand on links and comments, the outline
  click scrolling to its heading and taking the bold reading location), at
  phone width (no outline, tap card, bottom sheet) and in dark mode.
