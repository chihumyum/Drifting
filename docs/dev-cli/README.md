# Drifting developer CLI

The developer CLI is a local engineering and acceptance surface for fast,
scriptable CRUD, Agent workflows, and server API checks. It is not an end-user
shell and it does not introduce a second business layer: authored workspace
commands reuse the production General Agent domain runtime, SQLite
transactions, freshness guards, Yjs prose coordinator, one provider-neutral
authored change-set, write receipts, and exact inverse/review machinery.

Run it from the repository root:

```bash
pnpm drifting help --human
pnpm drifting capabilities
```

JSON is the default output. Every invocation emits one stable envelope with
`ok`, `command`, `requestId`, `data` or `error`, and execution `meta`. Use
`--human` only for interactive inspection. Domain arguments may be written as
flags, JSON, or a file:

```bash
pnpm drifting workspace call create_chapter \
  --project <project-id> \
  --db '/absolute/path/to/database.db' \
  --input '{"title":"第三章","summary":"抵达","body":"潮水退去。"}' \
  --offline-userdata --yes

pnpm drifting workspace call update_element \
  --project <project-id> \
  --db '/absolute/path/to/database.db' \
  --input @/absolute/path/to/update-element.json \
  --offline-userdata --yes
```

Explicit flags override fields from `--input`. Kebab-case flags are normalized
to camelCase, so `--relation-type` becomes `relationType`.

Coding agents can query the production description and JSON input schema for
one tool, or list all public domain tool schemas, without making a runtime
journal entry:

```bash
pnpm drifting workspace describe replace_chapter_body \
  --project <project-id> --db <database.db>
```

## Workspace authority and safety

Read-only offline commands require `--db` or `--offline-userdata`. A real
offline mutation additionally requires all of the following:

1. Drifting is closed and the database has no process/WAL/SHM owner.
2. The resolved file is a regular non-symlink database inside the production
   Drifting user-data directory.
3. Both `--offline-userdata` and `--yes` are present.
4. SQLite backup completes into the adjacent `cli-backups/` directory before
   migrations or domain mutation begin.

The environment override `DRIFTING_CLI_ALLOW_NON_USERDATA_WRITE=1` exists only
for isolated temporary fixtures and tests. It must not be used to reinterpret
an arbitrary database as a production workspace.

`workspace call <tool>` accepts every generated public domain read/write tool.
Chapters, inspirations, elements, categories, storylines, memberships,
relation types, relations, comments/TODOs, project facts, author rules,
memories, and element patches therefore use the same names and validation as
General Agent. Complete-body replacements automatically perform the canonical
paginated read preflight in the same runtime instance; they do not bypass the
read-before-rewrite rule. Prose commits through live Yjs authority and updates
`contentJson` only as its ordinary projection/cache.

```bash
pnpm drifting workspace call list_chapters \
  --project <project-id> --db <database.db>

pnpm drifting workspace call replace_chapter_body \
  --project <project-id> --db <database.db> \
  --chapter '第三章' --body '完整的新正文。' \
  --offline-userdata --yes
```

`workspace resource list|get <model>` provides project-scoped inspection for
thin scalar tables. Generic `create`, `update`, and `delete` fail closed during
Phase 1: their former direct-SQL path could not create one authored change-set
with the domain transaction, and the retired hosted outbox is not retained as a
compatibility writer. Authored mutations use a supported `workspace call`
command; scalar workflows without such a command remain unavailable until a
journal-backed domain adapter exists.

```bash
pnpm drifting workspace resource list timeline_marker \
  --project <project-id> --db <database.db>
```

SyncEngine journals, Yjs updates/snapshots/revisions, Agent receipts,
asset import workflows, derived mentions/sections, secure credentials, and migration
journals intentionally have no generic create/update/delete surface. They are
workflow, inspect/reconcile, rebuild, or excluded models. The generated
[capability inventory](acceptance/cli-capabilities.md) accounts for every
checked-in Drizzle table and is the machine authority for the boundary.

`ops inspect` returns the project overview plus a row-count entry for every
checked-in product table. With `--project`, tables carrying a direct
`project_id` also report `projectRows`; indirect child/runtime tables report
`null` instead of pretending a database-wide count is project-scoped.

```bash
pnpm drifting ops inspect --db <database.db> --project <project-id>
```

## Agent and server modes

`agent turn` and `agent review` call the existing loopback renderer bridge, so
the open App remains the owner of credentials, live stores, Yjs, reviews, and
the provider transport:

```bash
pnpm agent:debug:server

pnpm drifting agent turn \
  --project <project-id> \
  --bridge http://127.0.0.1:4317 \
  --prompt '列出章节，不要修改。'
```

The bridge URL is restricted to loopback HTTP. `--yes` changes permission mode
to one-time approval; it does not create a durable blanket grant.

`server request` performs an ordinary real HTTP request against the selected
Drifting Server. Authentication is provided by a cookie file containing either
the raw `Cookie` header or `{"cookie":"..."}`. DELETE requires `--yes`.

```bash
pnpm drifting server request GET '/api/projects' \
  --base-url http://localhost:3000 \
  --cookie-file /absolute/path/to/cookie.txt
```

This mode does not claim transactionality across multiple HTTP requests and it
does not hide external effects. It is the same server workflow a client would
invoke.

## Frontend Debug mode

`frontend` commands connect to the simulator-only loopback daemon and share
this CLI's JSON envelope, `requestId`, `--human`, `--input`, and `--stream`
conventions. They observe and operate the mounted mobile WebView but never
read or mutate SQLite/Yjs business data. Android uses real CDP; iOS uses an
explicit Debug renderer bridge and labels synthetic DOM input accordingly.

See [`../frontend-debug.md`](../frontend-debug.md) for startup, commands,
capability differences, evidence/redaction rules, and the future CRUD
orchestration boundary.

## Scenarios and acceptance

A scenario is a versioned JSON sequence of `workspace.call` and read-only
`workspace.resource` steps. A scenario containing a mutating domain call
receives one pre-run database backup and then stops at the first failed
assertion.

```bash
pnpm drifting scenario run \
  docs/dev-cli/scenarios/chapter-lifecycle.json \
  --project <project-id> --db <database.db> \
  --offline-userdata --yes
```

Regenerate and verify the complete CLI contract with:

```bash
pnpm dev:cli:capabilities
pnpm drifting:check
```

`pnpm drifting:check` checks generated-file drift, exact schema-table
accountability, argument/protocol behavior, offline safety, resource invariants,
and a real product-migration SQLite/Yjs chapter lifecycle with durable Agent
receipts. It does not prove an authenticated remote server, a paid provider,
or physical-device behavior unless those modes are invoked separately.
