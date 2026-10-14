# Location links

A location link addresses a passage of authored prose the way the read-only
[Markdown projection](local-data-export.md) addresses files: an entity body is a
`prose.md` whose editor block N occupies line `2N-1`, the numbering shared by
`read_chapter`, exact search and the projection.

## Addresses

```
drifting:chapters/<title | id-<id>>/prose.md#L12-L18      document and Agent form
drifting://open/<projectId>/chapters/id-<id>/prose.md#L12  operating-system form
../../chapters/id-<id>/prose.md#L12                        projection-relative path
```

Groups are `chapters`, `drifts`, `elements`, `categories` and `storylines`;
elements also accept the Agent workspace path `elements/<category>/<name>/body.md`.
`#L12`, `#L12-L18` and `#L12-18` are accepted; without a fragment the link opens
the entity. A blank separator line cites the block above it. Names escape `%`,
`/`, `\`, `#` and `?`; a Markdown destination also encodes spaces (`%20`). A
duplicated, empty or `id-`-prefixed name renders as the stable `id-<id>`
directory instead. The parser and resolver live in `src/renderer/lib/location-link.ts`.

## Storage and rendering

Line numbers are only an input and display coordinate. A written link is stored
as an `entityLink` mark with `targetKind`, `targetId`, `targetBlockId` and, for a
range, `targetEndBlockId`. Readers that pass a resolver render it again with the
target's current name and lines, so an inserted paragraph turns `#L1` into `#L3`.
A deleted cited paragraph renders as the entity-only link; a deleted entity
renders the plain label. Mentions without a paragraph anchor stay invisible in
Agent Markdown as before.

Agent prose reads (`read_node`/`read_chapter` numbered view) and projected
`prose.md` render through one formatter, so they stay byte-identical. Because a
link shows its target's current lines, a body's read `version` and projection
hash also change when a cited paragraph moves or its target is renamed.
`read_element` returns a plain body plus `locationLinks: [{ text, href }]`;
model-facing projected text lists them as `正文中的实体连接：label（href）`.

## Writing

Agent workspace writes (`revise_*`, `replace_*_body`, `create_*` bodies and MCP
equivalents) resolve new links against current prose:

- An unresolvable `drifting:` link fails the write with its reason (unknown or
  ambiguous name, line outside the body). An unresolvable projection-relative
  path stays an ordinary link.
- When the session read the cited body through tools and that body changed since
  (including by the session's own write), the write is refused with a request to
  read it again. Bodies never read through tools, for example cited from the disk
  projection, resolve against their current lines.
- Legacy block tools (`edit_block`, `append_paragraph`, …) write plain text.

Free text such as “第三章第 12 行” is not auto-detected: the system prompt and
`read_chapter` description ask the Agent to write location links instead.

## Navigation

- Editor: clicking a location link opens its entity, scrolls to the cited
  paragraph and flashes the cited range (`openEntityLinkTarget`).
- Agent chat: `drifting:` links in assistant messages resolve on click; when the
  lines no longer exist, the entity still opens.
- Operating system: the desktop shell drains only `drifting://open/` URLs from the
  native deep-link queue (OAuth drains `drifting://auth/`), opens the named
  project and then the passage. Registration needs a bundled app: isolated
  `pnpm dev:worktree` profiles register `drifting-test-<profile>` and do not
  receive these links. Mobile shells are not wired.

## Evidence

- `src/renderer/lib/location-link.test.ts`: parsing, escaping, line mapping and
  resolution.
- `src/renderer/lib/agent/runtime/workspace-prose-file.test.ts`: planner round
  trip, re-rendered lines, schema materialization and write failures.
- `src/renderer/lib/agent/runtime/drifting-product-composition.integration.test.ts`
  (`stores a cited passage …`): production runtime write, `read_element` links,
  line shift after an insertion and the stale-citation refusal.
- `src/renderer/services/export/relational-markdown.acceptance.test.ts`:
  projected `prose.md` and README; covered by `pnpm mcp:acceptance`.
- `node scripts/run-location-link-ui.mjs` (`--check` verifies freshness) writes
  [`acceptance/location-links-ui.json`](acceptance/location-links-ui.json): real
  Chrome mouse input on the real link extension and Agent message view lands on
  and flashes the cited paragraphs. Tauri window input is not exercised.
- `cargo test --manifest-path src-tauri/Cargo.toml deep_link_queue_tests` and the
  MCP instruction assertions in `mcp_server.rs`.
