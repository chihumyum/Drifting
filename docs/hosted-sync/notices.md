# Account notices

The operator of the Hosted service can tell signed-in authors something: a
maintenance window, what went wrong during an incident, an answer to one
author's feedback. The client shows such a notice in the notification center,
beside sync problems, readers' comments and updates. A notice is short plain
text, addresses every account or one account, and always expires.

Local-only builds, and Hosted builds while nobody is signed in, make no request
for notices and show none.

## What the author sees

- A notice arrives as an unread row in the notification center. Until the
  center is opened the bell carries the name seal instead of the wind bell
  (after a sync problem, running work and a crash follow-up, before a found
  update).
- The row's source reads 公告 / Announcement for a notice to every account and
  消息 / Message for one addressed to this account alone. Title and body are the
  operator's words, shown as text with the body's line breaks; they are never
  rendered as markup.
- A notice is written in Chinese, English or both. A Chinese interface shows
  the Chinese text; every other interface language shows the English text. A
  notice written in one language only is shown in that language.
- A notice that carries a link opens it in the system browser when its row is
  clicked. Only `https:` links without credentials are ever opened; a notice
  without a link is a row that does nothing when clicked.
- Opening the center reads its notices for the whole account: the other Macs
  of the account show them as read at their next read, without moving them in
  the list. A notice that arrives while the center is open is read when the
  center closes (this holds for every row of the center, whatever its source).
- The center's list is not kept across launches. After a restart the notices
  that are still active are listed again, already read if the account has seen
  them. A notice the author removed (the row's remove button, or 清空) stays
  away on this Mac until the service stops offering it.
- When the operator withdraws a notice, or it expires, its row leaves the list
  at the next read.
- Signing out takes the account's notices out of the list; another account
  gets its own.

## When it runs

The runtime (`features/notices/notice-runtime.ts`) is loaded only in
Hosted-configured builds and reads only while a Hosted session is bound. It
reads at start, on sign-in, when the sync authority changes, coming online, and
on focus or resume (at most every 15 seconds). After that it reads again every
`refreshAfterSeconds` the service names (60 by default, kept between 15 seconds
and an hour) while the app is in front, and five times less often, at most
hourly, in the background. So a notice normally arrives within about a minute;
nothing reaches an app that is not running. There is no push channel.

Failures retry with the shared single-flight supervisor's backoff and never
notify the author. A service without the route (HTTP 404) is asked again after
an hour; a refused session (HTTP 401) after five minutes or at the next
sign-in, since an expired session is the sync status' to report.

## Contract

`GET /api/account/v1/notices` with the account's bearer session returns the
active notices addressed to the account, oldest first, the account's read mark
and the refresh interval:

```json
{
  "notices": [
    {
      "id": "<uuid>",
      "seq": 12,
      "personal": false,
      "content": { "zh": { "title": "…", "body": "…" }, "en": { "title": "…", "body": "…" } },
      "link": "https://…",
      "publishedAt": "<ISO>",
      "expiresAt": "<ISO>"
    }
  ],
  "readThrough": 11,
  "refreshAfterSeconds": 60
}
```

`seq` grows with every notice the service publishes; notices at or below
`readThrough` have been seen on one of the account's devices.
`POST /api/account/v1/notices/read` with `{ "through": <seq> }` raises the mark
and returns `{ "readThrough": <seq> }`; the service never moves it back and
never past the newest notice it has published.

The client trusts none of the response's shape (`parseAccountNotices`): an
entry without an id, a `seq` or any text is dropped, a link that is not
`https:` is ignored, and the refresh interval is clamped. It sends the service
nothing about the author beyond the read mark; which notices were removed is
kept on the device (`localStorage`, per account).

## Evidence

`notice-api.test.ts` covers the response parser and the link rule.
`notice-feed.test.ts` drives the feed through an in-memory service with the
real read-mark rule and the app's notification store: first sight, the
interface language, the read mark across devices and its retry, withdrawal,
removal by the author across a restart, account switching and sign-out.
`notice-runtime.test.ts` covers the wiring: the session header, the refresh
interval, the request sent when the center opens, the stored removals,
sign-out, an older service and a refused session.
`components/notifications/notice-row.render.test.ts` covers the row.
`notices.hosted.integration.test.ts` runs against the local disposable service:
the operator publishes a notice to every account and one to a single account, a
client shows both, opening the center raises the account's mark as seen from a
second session, and a withdrawn notice leaves. It needs the local service's
operator account in `HOSTED_TEST_OPERATOR_EMAIL` and
`HOSTED_TEST_OPERATOR_PASSWORD`; all five are part of `pnpm hosted:acceptance`.
`store/notification-store.test.ts` covers reading on open and on close.

On 2026-11-13 one native Mac instance (`pnpm dev:worktree --online
--frontend-debug` against the local service, English interface) was checked
through the debug bridge with a synthetic account, while a synthetic operator
published through the console's routes:

- A notice to every account (both languages, a link) and one to the account
  alone (Chinese only) turned the bell into the name seal at the next read. The
  center listed them as Announcement, in English, and Message, in Chinese, with
  the body's line break kept; only the row with a link was clickable.
- Opening the center put the bell back and the console counted the account as
  a reader of both.
- The withdrawn notice left the list at the next read, and the removed one did
  not come back; its id was in the device's stored removals.
- A notice that arrived while the center was open stayed unread with the seal
  on the bell until the center closed, then counted as read at the service.
- After the page was loaded again, the notice already read was listed as read
  and left the bell alone.
- Clicking the row with a link closed the center and asked the system for the
  page; the browser itself was not watched.

The window was hidden behind others throughout, so reads followed the
background interval and were brought forward with a focus event; the one-minute
interval in front is covered by `notice-runtime.test.ts` only. Signing in had
to be done twice: the development instance keeps its WebView storage in memory,
so the relaunch onto the account's library starts signed out. A packaged
build, two native windows side by side and physical devices remain unchecked,
and so does the production service, which does not have the routes until it is
deployed.
