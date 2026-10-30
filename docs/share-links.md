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
quotes, alignment, indent and rules. Entity links become plain text. The
author's own comments, TODOs, summaries, relations and the rest of the project
never leave. The service can read the copy; the link token is the capability,
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
  account change.
- **Republishing.** `share-link-publisher.ts` runs per open project. After
  authored commits or remote changes it waits for the author to pause (the
  Markdown projection's worker: 5 s quiet, 30 s at most, deferred during IME
  composition) and re-sends every link of the project whose copy changed.
  The copy hashes the same on both sides (`shared/share-document.ts` keeps the
  service's key order), so an unchanged body is never sent and keeps its
  revision. Closing the project sends what was written since the last pause.
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

Review cards and sticky notes label these comments `读者 · <name>`. Like the
author's own comments, they appear in Review and on the page, not
automatically in the sticky-note rail.

## Reader page

`src/share-web` is a separate Vite entry (`vite.share-web.config.ts`, base
`/s/`), served at `/s/<token>` on the Hosted origin. It renders the copy,
lets a reader select text (the same anchor rules as the editor:
`share-web/anchor.ts`), signs in or signs up with email verification without
leaving the page (the service's HttpOnly cookie, never a stored token), posts
and withdraws comments, and polls every 10 s while visible. Wide screens show a
comment rail; narrow ones a bottom sheet. Comments are washed with CSS custom
highlights; resolved ones stay listed without a wash. A passage the author has
since rewritten is marked "changed". The page sends no `Referer`, and is
`noindex`.

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
  text, so comment offsets agree.
- `src/share-web/anchor.test.ts`: reader anchors, trimming, re-location.
- `src/renderer/features/share-links/share-inbox.integration.test.ts`: import
  on real SQLite, duplicate imports, withdrawals, status reports.
- `src/renderer/features/share-links/share-links.hosted.integration.test.ts`:
  against a local service — publish, identical hashes, reader comment, import,
  resolution and reopening, withdrawal, stop sharing.
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
