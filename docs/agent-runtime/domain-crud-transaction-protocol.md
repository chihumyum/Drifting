# Agent domain CRUD and transaction protocol

Status: normative for Milestone D

This document defines how the General Agent experiences a Drifting project as
a natural writing workspace while the product preserves SQLite, Yjs, sync,
review, and crash-consistency invariants underneath that facade.

## 1. Product surface

The model receives six ordinary workspace verbs:

- `list_files`
- `read_file`
- `grep`
- `edit_file`
- `write_file`
- `delete_file`

Paths use author-facing names. They do not expose SQLite row ids, Yjs updates,
block handles, receipt ids, or sync mutations unless a complete JSON resource
is intentionally addressed by its opaque id.

| Domain | Natural workspace path |
| --- | --- |
| Chapters | `/chapters/<chapter>/...` |
| Drifts | `/drifts/<drift>/...` |
| Elements | `/elements/<category>/<element>/...` |
| Element categories | `/categories/<category>/...` |
| Storylines | `/storylines/<storyline>/...` |
| Storyline membership | `/storylines/<storyline>/chapters.json` |
| Comments and TODOs | `/comments/<comment-id>.json` |
| Entity relations | `/relations/<relation-id>.json` |
| Agent memory | `/memory/<memory-id>.json` |
| Project facts | `/project/facts.json` |

Creation may use a descriptive placeholder such as `/comments/new.json` or
`/memory/new.json`. The result returns the canonical path containing the
deterministic created id. Subsequent operations use that canonical path.

The runtime resolves those paths to hidden domain commands only after checking
the current project and current workspace snapshot. Hidden commands are an
implementation boundary, not extra concepts the model must plan around. The
executable list and lifecycle matrix live in
`drifting-workspace-tool-contract.ts` and are included in the generated
capability inventory.

## 2. Authority and projection

| State | Authority | Renderer projection |
| --- | --- | --- |
| Chapter, drift, element, category, and storyline prose | live Yjs document plus persisted Yjs state | editor and virtual Markdown files |
| Structural metadata | SQLite | Zustand data/project stores |
| Comments and TODOs | SQLite | comment store/editor decorations |
| Entity relations | SQLite | relation store and semantic links |
| Storyline membership and primary assignment | SQLite link graph | storyline/node mapping stores |
| Agent memory | SQLite | prompt memory reads and virtual JSON files |
| Review decisions | SQLite ordered review blocks | editor review badges and animations |
| Cross-device delivery | transactional local sync outbox | server projection after flush |

LocalStorage and Zustand are projections. They cannot independently approve,
reject, create, delete, or revert an Agent mutation. Prose writes never mutate
stale `contentJson` as their source of truth.

### Virtual Markdown schema boundary

Agent-facing prose files are a reversible projection of the current editor
schema, not a second prose authority. Reads serialize heading levels 1-3,
paragraphs, blockquotes, horizontal rules, hard breaks, bold, italic, strike,
underline, and safe links. Writes parse those forms directly into structured
Yjs nodes before durable preparation.

Markdown presentation that the editor does not configure is unwrapped rather
than persisted as a hidden or invalid node. Heading levels 4-6, lists and task
lists, inline/fenced code, tables, images, and arbitrary HTML retain their
readable text as ordinary paragraphs but lose the unsupported style. Unsafe
link schemes retain their labels without a link mark. Existing editor-only
marks such as entity links remain attached to unchanged text even though they
are intentionally absent from the virtual file.

This boundary is schema sanitation only. It does not impose author style,
voice, canon, target scope, or any other writing policy.

## 3. Read-before-write freshness

Every certified mutation cites an authoritative read observation:

1. a workspace read records the entity kind, entity id, and exact revision;
2. the write prepares a complete preimage and expected revision;
3. the mutation transaction reads the current revision again;
4. a mismatch fails closed and instructs the Agent to reread;
5. a match permits the mutation, receipt, and sync outbox write to commit
   together.

The membership revision hashes the complete active project membership graph,
not just the one visible storyline. This is necessary because assigning a new
primary storyline can demote a primary link owned by another storyline.

The memory-set revision hashes every memory row, including dismissed and
soft-deleted provenance. A create therefore cannot silently race with another
memory proposal. Updates and deletes additionally cite the exact memory row.

## 4. Atomic write record

A successful SQLite-backed write transaction contains:

- the domain mutation;
- the immutable forward receipt with exact preimage and postimage hashes;
- the local sync outbox mutation when the entity is synced.

The outer durable write effect is then moved to `result_committed`. If that
acknowledgement is lost after the inner transaction committed, retry uses the
same idempotency key, discovers the immutable receipt, reconstructs the exact
result, and advances the outer effect once. It does not execute the domain
mutation a second time.

An injected failure before the transaction commit leaves no partial domain
rows, no receipt, and no outbox mutation.

## 5. Exact inverse and lineage guard

Every lifecycle marked `revert: closed` has a guarded exact inverse:

- a create inverse removes exactly the row/resource created by that command;
- an update inverse restores the exact captured preimage;
- a delete inverse restores the exact captured resource and relationships;
- a membership inverse restores the complete captured graph;
- an inverse itself receives an immutable inverse receipt and is idempotent.

Before applying an inverse, the runtime hashes current authoritative state and
compares it with the forward postimage. If any author or later Agent command
has changed that state, the inverse fails closed instead of overwriting newer
work. Reverting a later edit does not erase the fact that the lineage advanced;
the older command is not treated as a general checkpoint. There is no
Agent-session rewind or conversation branch surface. Author-facing manuscript
history is the independent entity snapshot system documented in
[`entity-snapshot-history.md`](entity-snapshot-history.md).

## 6. Structural resources

Nodes, elements, storylines, and categories are complete resources represented
by directories. Creating the first meaningful file may create the resource and
its canonical prose/metadata seed. Updating a file updates only the represented
field.

`delete_file` may delete a structural resource only at the complete resource
directory path. Deleting `/drifts/Idea/summary.md` must not be interpreted as
deleting the whole drift; it fails with guidance to delete `/drifts/Idea`.
Comments, relations, and memories are complete JSON-file resources, so their
file path is their deletion boundary.

Structural create/update/delete executes through renderer use cases and the
same Yjs/SQLite rules as manual editing. The receipt preserves enough typed
state to restore all owned fields and relationships without hiding domain
concepts in `metadataJson`.

## 7. Storyline membership transaction

`/storylines/<storyline>/chapters.json` is a replacement document. Each entry
names a chapter and whether this storyline is primary for that chapter.

The transaction:

1. resolves every chapter name inside the current project;
2. loads the complete active membership graph;
3. replaces links owned by the authored storyline;
4. guarantees at most one primary storyline for every chapter by demoting any
   conflicting primary link in the same transaction;
5. persists changed link outbox rows and one typed graph receipt;
6. updates renderer mappings only from the committed postimage.

Creation, replacement, clearing, and exact inverse are all the same graph
operation. Because membership changes story structure, it always requires
confirm-before authorization in chat.

## 8. Comments, TODOs, and relations

Comments and TODOs are one anchored comment domain. Their JSON resource can be
created, read, replaced, deleted, and exactly reverted. Ordinary comment/TODO
creation and update are automatic because they do not rewrite manuscript prose.
Deletion is confirm-before.

Relations resolve author-facing endpoint names to typed project-owned entities.
Create, relation-kind update, and delete are all confirm-before because an
incorrect edge changes the project knowledge graph. Their endpoint ownership
and target validity are rechecked inside the mutation transaction.

## 9. Agent memory trust model

Agent memory is cross-session writing guidance, not canon and not project
facts.

- An Agent-created memory always starts as `source=agent,status=pending`.
- Pending memory is never injected into model or Shadow context.
- Only a pending Agent proposal is writable in place.
- Active author-approved guidance is read-only to the Agent.
- Evolving active guidance creates a new pending row with `supersedesId`; it
  does not mutate or retire the active row before author approval.
- Approval atomically activates the proposal and retires its predecessor.
- `forget` is a confirm-before soft delete so provenance and sync convergence
  survive; its inverse can restore the exact live row while lineage is current.

`/memory.json` is a readable aggregate. Individual mutable resources live at
`/memory/<memory-id>.json`.

## 10. Approval policy

| Mutation | Policy | User surface |
| --- | --- | --- |
| Prose edit | review after | write immediately; inline editor badge accepts/rejects blocks or all |
| Safe metadata, comment/TODO, pending memory proposal | automatic | semantic activity only |
| Delete structural resource, comment/TODO, or memory | confirm before | chat permission request |
| Relation create/update/delete | confirm before | chat permission request |
| Storyline membership replacement | confirm before | chat permission request |

The model cannot forge approval. Authorization binds the exact normalized
arguments hash to a permission request. A changed path or payload requires a
new decision.

## 11. Headless acceptance matrix

Milestone D acceptance runs the real product composition against a temporary
file-backed SQLite database with all product migrations, plus real Yjs for
prose-owning paths. It verifies:

- lifecycle closure for every declared domain and executable strategy;
- natural path creation plus canonical returned paths;
- structural create/update/delete and exact inverse;
- comment/TODO and relation CRUD plus exact inverse;
- full-graph storyline membership replacement and inverse;
- memory trust, supersession, soft delete, sync outbox, and inverse;
- transaction rollback after an injected inner failure;
- reconciliation after a lost outer acknowledgement;
- close/reopen persistence and latest migration application;
- read-before-write stale-state refusal;
- confirm-before policy for relations and membership;
- typecheck, targeted lint, and generated capability drift checks.

Run:

```bash
pnpm --dir client eval:agent:crud
```

The command writes
`docs/agent-runtime/acceptance/milestone-d-domain-crud.json`. Native visual
behavior, device lifecycle, networked provider behavior, and user checkpoint
UX are explicitly outside this historical Milestone D acceptance. Agent user
checkpoints were later implemented and then removed; native and networked
behavior remain assigned to their own roadmap gates.
