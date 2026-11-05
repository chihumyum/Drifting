# Release screenshots

Status: **current tooling** (2026-11-05). One command captures the shelf, the
workspace and the element overview of the real macOS app, from synthetic data.
Each README's three are refreshed only when the author asks for screenshots
(2026-11-04); a release does not retake them:

```bash
pnpm release:screenshots --readme
```

Run it on a Mac when asked ([releasing.md](releasing.md), step 2) and commit
`docs/screenshots/` with that change; `pnpm release:check` (locally and in the
Release workflow) only checks that the README's screenshots are all there and
shown, whichever version took them. It takes about a minute once
the profile's Rust build exists (the first run compiles it, about five
minutes) and **takes the screen**: the app's window comes to the front for each
capture, and the app that was in front gets its place back at the end. Leave
the keyboard and pointer alone while it runs.

Without `--readme` it captures every scene in English and Chinese, light and
dark — twelve PNGs in `out/screenshots/<version>/`, not committed — in about
two minutes.

## The READMEs' screenshots

`--readme` captures the light scenes in both languages (`--locale en` or
`--locale zh-CN` retakes one). `docs/screenshots/` holds the English set, which
README.md shows, and `docs/screenshots/zh-CN/` the Chinese set (《慢钟》), which
README.zh-CN.md shows (2026-11-05). Each holds `shelf.webp`, `workspace.webp`
and `elements.webp`: the light scenes resized to 2000 pixels wide (twice the README's
column, for Retina screens) and encoded as WebP at quality 90 with `cwebp`
(`brew install webp`), about 480 KB together, so a release adds little to the
repository. `manifest.json` beside them records the language, the version, the commit
they were captured from and each file's size and SHA-256. Each README shows its
set in that order; `pnpm release:check` checks both.

## What it produces

`out/screenshots/<version>/` (gitignored):

| File | Scene |
| --- | --- |
| `<locale>-<theme>-shelf.png` | The Bookshelf: seven books with covers, the year's writing heatmap and each book's last 30 days |
| `<locale>-<theme>-workspace.png` | The open book on chapter 1, three more chapters in tabs, chapters on the left, Review on the right, the timeline below |
| `<locale>-<theme>-elements.png` | The element overview in its 关系 layout, settled |
| `manifest.json` | Version, commit (and whether the checkout was dirty), window size, and each file's size and SHA-256 |

`<locale>` is `en` or `zh-CN`, `<theme>` `light` or `dark`. The window is
1600 × 1000 points, the narrowest at which the English element overview's
header fits in one line; on a Retina display the PNGs are 3200 × 2000, without
the window shadow (transparent rounded corners).

Options: `--locale en|zh-CN` and `--theme light|dark` capture a subset;
`--output <dir>` writes elsewhere; `--position <x>,<y>` places the window (screen
points, top-left origin; default: centred on the main display); `--keep-open`
leaves the last language's app running to look around. `--background` never
takes focus: the window stays where it is (or at `--position`) with grey traffic
lights, and must stay visible, because WebKit draws nothing in a covered window.

## The data

Everything on screen is synthetic or public domain, so no author's work or
private data can reach a screenshot. Each language gets a fresh library, written
by `src/dev-cli/seeds/showcase/` through the same writer as the
[built-in sample](sample-project.md) (`writeBookSample` with a `SampleBook`
definition) and the app's journaled paths:

| | English | 中文 |
| --- | --- | --- |
| Open book | *Pride and Prejudice (Sample)*: the built-in sample, illustrations and portraits included | 《慢钟》: an original novel in progress written for the screenshots, 3 volumes, 24 chapters (12 with text, 4 finished), 4 storylines, 24 elements, 41 relations, comments, TODOs, patches, a plot grid, notes and ideas |
| Other books | Six (*The Lantern Keeper*, *Salt and Static*, …) with genres, storylines, a few elements and generated prose sized to 8,400–94,000 words | Six (《北岬灯塔》《盐与星》…), the same shapes in Chinese |
| Writing days | About 600 days over the year, on another device's key, dated from the run: likelier after a writing day, rarer on Sundays, a two-week break in the summer | The same; 《慢钟》 started six weeks ago |

Dates are relative to the run, so the shelf always shows books written today,
this week, this month and months ago. The run removes only its own profile's
library and app data (`release-screenshots` instance; never the daily app or
another checkout's) before seeding.

## How it works

`scripts/capture-release-screenshots.ts`, per language:

1. starts a frontend debug bridge in-process (the launch and window helpers are
   shared with the promo recording in `scripts/desktop-app-session.ts`),
   removes the instance's library,
   asset store and Markdown folder, and seeds a new library
   (`src/dev-cli/showcase-seed-main.ts`);
2. launches the instance's Debug build (`dev:worktree --instance
   release-screenshots --no-watch --frontend-debug`) and sizes and places its
   window with System Events;
3. evaluates `scripts/release-screenshots-scenes.js` in the renderer: set the
   language and theme and mark the first-run guides (and the workspace tour)
   seen, reload, then wait for
   each scene to settle (every cover drawn; the chapter text shown and
   scrolled to the top; the 关系 layout at rest), closing popovers, the caret
   and the selection;
4. brings the window to the front, moves the pointer off it if it rests there,
   and captures the window with `screencapture -x -o -l<window id>`;
5. quits through the app menu, so the app flushes as it would for an author.

The scenes drive the app through its own stores (settings, UI tabs and
sidebars, the active Super View). When a scene's DOM changes, adjust the
scene, not the seed.

## Acceptance

```bash
pnpm exec vitest run src/dev-cli/seeds/showcase src/renderer/services/built-in-sample
```

The integration test seeds both libraries into temporary SQLite files: seven
books each with the planned chapters and word counts, the open book last and
most recent, every date in the past, books written this week, this month and
earlier, genres on the covers, writing days on one device across more than 40
weeks of the heatmap, the illustrations as real files in the asset store, no
foreign-key violations, and a refusal to seed over an existing library. The
content test anchors every 《慢钟》 comment and patch to one plain passage and
ties every relation, storyline, link form and comment to something that exists.

Recorded 2026-11-04 on an Apple Silicon Mac (Retina displays), in
`--background` with the window on the built-in display while the author used
the Mac: all twelve shots in 94 s after the first Rust build, each 3200 × 2000.
The shelf showed seven books, 297–312 writing days and a summer gap in the
heatmap; the workspace showed chapter 1 from its title with linked names, its
comments in Review and four tab dots; the element overview showed the settled
关系 layout with its legend. A foreground run (lit traffic lights) was not
recorded that day.
