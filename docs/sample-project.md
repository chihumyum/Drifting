# Built-in sample project

Status: **current behavior** of every build (desktop and Tauri iOS), from
migration `0015_library_state`.

A brand-new local library opens with one sample project, 《潮汐灯塔（示例）》,
already on the Bookshelf. No seed command is needed: a fresh install, a fresh
`pnpm dev` / `pnpm dev:worktree` profile and a new `--instance` all get it on
first launch. It is an ordinary project — edit it, rename it, move it to
Recently Deleted or delete it permanently. A deleted sample never comes back.

## Content

The sample is the development **lite** recipe
([seeded profiles](worktree-development.md#seeded-profiles)) with its development
bookkeeping removed. All names, prose and images are original synthetic
fixtures in Chinese (海岛悬疑), whatever the interface language.

| Data | Built-in sample |
| --- | --- |
| Chapters | 20; 150,000 words, 2,000–20,000 each, on 2 storylines |
| Elements | 30 in 6 categories, with aliases, facts and 36 relations |
| Ideas (构想) | 10; 20,000 words, titled by place and clue (北岬的缺页日志 …) |
| TODOs / comments | 12 / 8, a quarter resolved, some anchored to chapter text |
| Materials | 12 rich-text notes with checklists in 6 folders (2 nested); 4 images and 2 PDFs |
| Project facts / memory | 类型、叙事视角; one Project Memory note |

Different from `pnpm dev:seed:lite`:

- the three synthetic Agent discussions (`示例讨论 · …`) and their recovery
  checkpoints, whose replies and tool results are labelled fake, are left out;
- the `开发样本` project fact and the "开发用合成材料" sentence in Project Memory
  are left out;
- chapters are numbered alike (第一章 潮声 … 第四章 盐仓回声 … 第二十章 黎明的海)
  instead of the seed's `第004章 归岛·盐仓回声`, which performance scripts look
  chapters up by; ideas are titled `北岬的缺页日志` instead of `构想001 · 北岬的缺页日志`;
- there is no `Developer CLI workspace` audit conversation. The sample's tool
  calls run under a temporary conversation that is deleted, with all of its
  Agent runtime rows, once the sample is complete.

Chapters, elements, ideas, storylines and categories have live Yjs
prose. Their bodies are byte-identical to the lite corpus recorded in
[`dev-cli/acceptance/seed-presets.json`](dev-cli/acceptance/seed-presets.json).

## How it is written

`services/sample-project/` holds the recipe shared with the development seed:

- `scenario.ts` builds the deterministic sequence of certified workspace tool
  calls (`create_chapter`, `create_element`, `create_relation`, …);
  `presets.ts` and `prose.ts` hold the budgets and the synthetic prose.
- `headless-workspace.ts` executes one call as an author-approved General
  Agent write without a mounted workspace. `src/dev-cli/offline-workspace.ts`
  uses the same function with the CLI's writer identity.
- `materials.ts` plans folders, notes and asset items and commits them in one
  authored transaction; `comments.ts` resolves every fourth TODO/comment.
- `built-in-sample.ts` is the first-run workflow; `first-run.ts` is the small
  startup hook and the state the Bookshelf observes.

Inside the app every write uses the app's own sync identity
(`withAtomicSyncTransaction` and the default Agent authored journal), so the
sample has the same SQLite rows, journal entries and Yjs state as a project the
author built. Prose goes through the Agent write path into Yjs; `contentJson`
is only its cache. The image/PDF fixtures (`assets/`, under 0.5 MiB) are
bundled with the renderer, verified against `assets/manifest.json`, written to
the native asset store with their prebuilt previews and registered with a
verified local blob receipt, as an imported attachment is.

## Once per library

`store/auth.ts` `checkSession()` opens the local library, emits `db:ready` and
starts the sample in the background. It never blocks startup; on desktop the
first-run welcome dialog usually covers the time it takes.

The device-local `library_state` table (never synced or journaled) holds the
`built-in-sample` marker:

| Status | Meaning | Next launch |
| --- | --- | --- |
| *(none)* | Never checked | Check the library |
| `skipped` | The library had a project (live or in the trash), a cloud account or a provider transition; or attempts ran out | Nothing |
| `creating` | Claimed together with the empty project row; not complete | Remove the partial project, then retry |
| `failed` | Rolled back after an error | Retry while fewer than 3 attempts |
| `created` | Published once | Nothing, even after the sample is deleted |

The first check of any existing library records `skipped`, so a library that
was ever in use (including the author's own) is never given a sample later,
even if all its projects are deleted. The claim re-checks that no project
exists inside the transaction that creates the sample's project row.

While the sample is being written, the Bookshelf hides its unfinished project,
shows a placeholder card and holds **New book**; the workspace tools share the
renderer stores, which are restored afterwards. A failure removes the partial
project and its asset files, logs a warning and leaves the shelf as it was.

Cost, measured on 2026-10-31 with an isolated macOS profile whose window was
behind other windows (WebKit treats the page as hidden): about 28 s with
`--release-perf` (152 workspace calls, ~180 ms each, then the materials), and
about 3 minutes in a Debug build on a busy machine. The Node development seed
writes the same content in about 8 s. Visible-window and installed-package
timings were not measured. Each call is one author-approved Agent write with
its own SQLite transaction over the native gateway.

## Hosted

The sample is created at local library initialization, before any Hosted
connect. `connectHostedFromProduct()` waits for an in-flight sample, so a
half-written sample is never published. A library that is connecting or
connected to an account, or has a provider account, does not get a sample.
Signing in afterwards uploads the finished sample like any local project; a
second fresh device that signs in to the same account brings its own sample,
so the account can hold two copies (an open question, see below).

## Acceptance

```bash
pnpm exec vitest run src/renderer/services/sample-project
```

The integration test writes into real migrated SQLite libraries: an empty
library gets exactly one sample with the lite corpus (exact word budgets,
canonical Yjs bodies and hashes matching the lite evidence, verified asset
receipts, no Agent runtime rows), a second launch and a deleted sample are left
alone, libraries with projects (including only trashed ones) or a cloud
connection are untouched, a failed attempt rolls back and is retried, an
interrupted attempt is cleaned up, repeated failures stop, and the startup hook
never rejects. Native asset store writes and the Bookshelf are covered by
desktop acceptance with a fresh `pnpm dev:worktree --instance <new>` profile.

Open question: whether a Hosted sign-in on a fresh device should drop an
untouched sample instead of uploading it.
