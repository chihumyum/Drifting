# Element portrait generation

Status: **current, experimental**. First version (2026-10-26): one element at a
time, from the element page. Batch generation, edits based on an existing image
and material boards (设定集 / 分镜板) are not implemented.

## Route and limits

Images come from the experimental ChatGPT subscription route (see
[ai-provider-settings.md](ai-provider-settings.md)). The native host
(`src-tauri/src/codex_images.rs`) posts to the Codex backend's
`images/generations` endpoint with the same OAuth credential and client identity
as the Agent's Responses route: `gpt-image-2`, `background: opaque`,
`quality`/`size: auto`. OpenAI publishes no third-party contract for this path;
Sign in with ChatGPT's preview explicitly excludes image generation.

Measured on 2026-10-26 with a Pro account:

- One request returns one image, about 25 s and 3–4 MB PNG; `count` therefore
  sends independent requests, and a partial failure keeps the images that did
  arrive.
- The endpoint ignores `quality` and `size` (a `low` / `1536x1024` request came
  back `medium` / `1024x1536`); orientation can only be steered in the prompt.
- Images are metered on their own limit (`x-codex-active-limit:
  imagegen_premium`, 1440-minute window, about 1% per image). The native host
  projects the `x-codex-*` headers into `ImageQuotaSnapshot`; the dialog shows
  the last snapshot. A 429 surfaces as `CODEX_IMAGES_USAGE_LIMIT` with the reset
  time.

## Generation inbox

Results never become domain rows directly. Each image is a candidate under
`$APPLOCALDATA/generation-inbox/<projectId>/<candidateId>/` (`image.<ext>` and
`candidate.json`): written into a hidden staging directory and renamed into
place, listed newest first, removed when discarded and pruned after 30 days.
Candidates are local to one device and never synced. The inbox directory is in
the asset protocol scope so the webview can show candidates.

`useImageInboxStore` projects the mounted project's inbox; it loads from the
native list and merges candidates as the Agent tool returns them.

## Keeping a candidate

Keeping copies the candidate into `imports/` (`image_inbox_stage_import`) and
runs the ordinary local asset import, so the kept bytes obey the
[local asset](local-assets.md) transaction and sync boundaries:

- **收入素材** creates an image material with `provenance_json`, associates it
  with the element through the built-in generic association, and removes the
  candidate.
- **设为设定图** does the same and also imports a copy as the element portrait.
  Both assets share one SHA-256, so the blob lane stores the bytes once.
- Replacing a portrait — from a candidate or from the file picker — no longer
  discards it: unless a material with the same SHA-256 already exists, the
  outgoing image is copied into a material with `origin: 'element-portrait'`,
  associated with the element, before the ordinary replacement deletes the old
  portrait asset. A copy, not an owner transfer, keeps every sync change-set on
  the already-exercised create/replace paths. Removing a portrait explicitly
  still deletes it.

## Material provenance

`library_item.provenance_json` (migration `0009`) is nullable, versioned JSON;
`null` means the author imported or linked the material. Version 1 has two
origins:

| origin | fields |
| --- | --- |
| `generated` | provider, model, exact prompt, Agent subject prompt, style, extra prompt, target element, generation id, Agent conversation, `sourceItemIds` (empty until edits exist), `generatedAt` |
| `element-portrait` | `elementId`, `replacedAt` |

Readers ignore unknown versions or malformed JSON (`parseMaterialProvenance`).
SQLite checks only that the value is JSON with an integer `v`; the reducer's
field policy accepts version 1 exactly.

Compatibility:

- The migration adds the column with `ALTER TABLE` and re-creates the
  workspace-projection update trigger; the generated table rebuild was
  replaced because it would drop every `library_item` trigger.
- The field syncs with the material row, but the create payload omits it when
  `null`. Builds before `0009` reject any `provenanceJson` field, so only
  materials that carry provenance need every device on a current build.
- Checkpoints captured before `0009` lack the column; restore fills it with
  `null` (`withNullableFieldsAddedAfterV1`).
- Agent `list_materials` reports `source` (`author` / `generated` /
  `former-portrait`); `read_material` adds the generation description, style
  and author direction. The relational Markdown export adds `source` and
  `generation_*` frontmatter, and the readable projection a 生成信息 section.

## Project art style

The style lives in the project facts as `美术风格`, so it syncs, appears in the
project's facts editor and is readable by the Agent's project-facts tools. The
generation dialog shows and saves it; the image tool appends it to every prompt
(`composeImagePrompt`), so the Agent leaves style out of its description. When
the fact is empty, the task asks the Agent to choose a style that suits the work
and write it into the description itself.

## Element image entry

The element page shows no image in its hero, so the title takes the full page
width and wraps (`EntityTitleField`, shared with category and storyline
pages). Every element image action lives behind one entry in the editor top
bar, left of the outline toggle (`ElementImageEntry`, `EditorTopBar`'s
`imageEntry` slot):

- The button shows the image as a thumbnail, or an image icon when there is
  none; a spinner while a generation session runs; otherwise the candidate
  count as a badge.
- Its popover (portaled to `body`) shows the large image (click for full
  screen), the candidates with 设为设定图 / 收入素材 / 丢弃, and the actions 生成设定图…,
  从文件添加/替换…, 查看大图 and 移除设定图.
- 生成设定图… swaps the popover to the generation form instead of opening another
  layer; submitting closes it and the status moves to the button.

The mobile shell hides the desktop editor top bar, so this entry is desktop
only for now.

## Agent task and tool

The generation form (style, extra direction, 1–4 images) starts a background
read-write Agent session, like the chapter-end review. The task names the element and its category: the Agent reads both
(`read_element`, `read_element_category`; an uncategorized element skips the
second), consults `find_element_appearances` when the setting is scattered in
the prose, and writes a concrete image description — subject, appearance,
setting, composition, mood — without assuming the element is a person (it may
be a place, object, group, phenomenon or idea). It then calls
`generate_element_images` (`elementId`, `prompt`, optional `count`). The form warns when there is no ChatGPT sign-in; the
provider error otherwise reaches the model as the tool result.

- The tool is write-class, so read-only turns never see it, but it changes no
  project data: it declares `scheduling: 'independent'` and runs outside the
  reader/writer barrier every conversation shares, which a 25–60 s request
  would otherwise hold. Stopping a turn still waits for a started call and
  cancels the native requests.
- It runs without a prompt only in a conversation the element page started;
  in any other chat it asks once, because it spends the author's image quota.
- It records the dialog's extra prompt from the page's request rather than
  from the model, appends the `美术风格` fact, pushes candidates into
  `useImageInboxStore` and gives the model only a count, failure codes and the
  quota line. While the session runs, the entry button spins and the popover
  shows 生成中 · 查看.

## Machine acceptance

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked codex_images
pnpm exec vitest run src/renderer/domain/material-provenance.test.ts \
  src/renderer/store/image-inbox-store.test.ts \
  src/renderer/features/element-images \
  src/renderer/usecase/useGeneratedImages.test.ts \
  src/renderer/lib/agent/runtime/element-image-tool-runtime.test.ts \
  src/renderer/schema/material-provenance-migration.integration.test.ts \
  src/renderer/sync/checkpoint/validate-added-fields.test.ts \
  src/renderer/sync/journal/domain-mutation.test.ts
pnpm exec vitest run src/renderer/lib/agent/runtime/runtime.test.ts -t "independent write"
pnpm agent:capabilities:check
```

A real-account run on 2026-10-26 in an isolated `pnpm dev:worktree` profile
(synthetic project, driven through the renderer debug bridge with synthetic DOM
input, so no native input fidelity) covered: dialog → background Agent session
→ `generate_element_images` (2 images, no permission prompt) → candidate strip
and inbox files → 设为设定图 (generated material with provenance, generic
association, portrait copy, candidate removed) → replacing that portrait with a
second candidate (no former-portrait copy, since a material holds the bytes) →
two picker replacements with the native file dialog stubbed (the second created
the `element-portrait` material). It found and fixed the dialog rendering
behind the page (missing `z-index`). Not covered: 收入素材 / 丢弃 on their own,
native pointer and keyboard input, and deleting a generated material, which
fails for every image material today: deleting the owner and unbinding its
asset in one change-set leaves the unbind unmaterialized
(`canMaterializeAssetBinding` requires a live owner), so the local post-write
validation rejects the deletion.
