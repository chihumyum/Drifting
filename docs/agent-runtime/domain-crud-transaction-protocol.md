# Agent domain CRUD and transaction protocol

Status: normative for Milestone D

This document defines how the General Agent experiences a Drifting project as
a natural writing workspace while the product preserves SQLite, Yjs, sync,
review, and crash-consistency invariants underneath the domain-tool boundary.

## 1. Product surface

The model receives the complete generated set of explicit domain tools.
Chapters, inspirations, elements, element categories, storylines, storyline
memberships, relations, comments/TODOs, project facts, author rules, and element
patches each have their own named operations. Examples include `read_chapter`,
`revise_chapter`, `create_element`, `update_element`, `create_relation`, and
`delete_relation`. There is no generic authored-object or virtual-file tool and
no compatibility alias for one. The generated capability inventory is the
authoritative complete list and count.

Inputs use one direct domain noun such as `chapter`, `element`, `category`, or
`relationId`, plus only the fields needed by that operation. They do not expose
paths, extensions, SQLite row ids, Yjs updates, block handles, revision tokens,
receipt ids, or sync mutations. Only comments, relations, element patches, and
author rules keep opaque handles after creation, because those handles
distinguish otherwise unnamed domain objects.

Acceptance tests keep every provider schema deliberately narrow: no more than
eight top-level fields, object nesting no deeper than two levels, no union of
object-shaped argument branches, and no runtime plumbing fields. A small valid
domain example must pass while a generic authored-object shape must fail.

| Domain               | Natural authored target            |
| -------------------- | ---------------------------------- |
| Chapters             | `章节「<名称>」`                   |
| Drifts               | `灵感「<名称>」`                   |
| Elements             | `要素「<名称>」（分类「<分类>」）` |
| Element categories   | `要素分类「<名称>」`               |
| Storylines           | `故事线「<名称>」`                 |
| Storyline membership | `故事线「<名称>」章节关系`         |
| Comments and TODOs   | `批注或待办「<handle>」`           |
| Entity relations     | `实体关系「<handle>」`             |
| Agent memory         | `作者规则「<handle>」`             |
| Project facts        | `项目事实`                         |

Creation returns a canonical semantic result containing the created handle when
the domain needs one. Subsequent domain operations pass that handle directly.

The runtime resolves those targets to hidden domain commands only after checking
the current project and authoritative state. Hidden commands are an
implementation boundary, not extra concepts the model must plan around. The
executable list and lifecycle matrix live in
`drifting-workspace-tool-contract.ts` and are included in the generated
capability inventory.

## 2. Authority and projection

| State                                                  | Authority                                  | Renderer projection                      |
| ------------------------------------------------------ | ------------------------------------------ | ---------------------------------------- |
| Chapter, drift, element, category, and storyline prose | live Yjs document plus persisted Yjs state | editor and authored-object projection    |
| Structural metadata                                    | SQLite                                     | Zustand data/project stores              |
| Comments and TODOs                                     | SQLite                                     | comment store/editor decorations         |
| Entity relations                                       | SQLite                                     | relation store and semantic links        |
| Storyline membership and primary assignment            | SQLite link graph                          | storyline/node mapping stores            |
| Agent memory                                           | SQLite                                     | prompt memory and author-rule projection |
| Review decisions                                       | SQLite ordered review blocks               | editor review badges and animations      |
| Cross-device delivery                                  | transactional local sync outbox            | server projection after flush            |

LocalStorage and Zustand are projections. They cannot independently approve,
reject, create, delete, or revert an Agent mutation. Prose writes never mutate
stale `contentJson` as their source of truth.

### Authored prose schema boundary

Agent-facing prose bodies are a reversible projection of the current editor
schema, not a second prose authority. Reads serialize heading levels 1-3,
paragraphs, blockquotes, horizontal rules, hard breaks, bold, italic, strike,
underline, and safe links. Writes parse those forms directly into structured
Yjs nodes before durable preparation.

The same parser materializes the initial `contentJson` seed when an Agent
creates a chapter, drift, element, storyline, or element category. Those
never-opened objects therefore begin with the same formatted nodes and stable
block ids that later Yjs-backed replacements produce; creation does not pass
through the plain comment-body serializer.

Markdown presentation that the editor does not configure is unwrapped rather
than persisted as a hidden or invalid node. Heading levels 4-6, lists and task
lists, inline/fenced code, tables, images, and arbitrary HTML retain their
readable text as ordinary paragraphs but lose the unsupported style. Unsafe
link schemes retain their labels without a link mark. Existing editor-only
marks such as entity links remain attached to unchanged text even though they
are intentionally absent from the model-facing body.

This boundary is schema sanitation only. It does not impose author style,
voice, canon, target scope, or any other writing policy.

## 3. Read-before-write freshness

Every certified mutation cites an authoritative read observation:

1. an authored-object read records the entity kind, entity id, and exact revision;
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

Nodes, elements, storylines, and categories are complete authored objects. Each
domain has separate create, metadata-update, passage-revision, whole-body
replacement, and deletion tools where applicable. Deletion tools accept only a
complete domain object; a summary update can never be interpreted as deleting
its owner. Comments, relations, patches, and author rules use their stable
handles as the deletion boundary.

Structural create/update/delete executes through renderer use cases and the
same Yjs/SQLite rules as manual editing. The receipt preserves enough typed
state to restore all owned fields and relationships without hiding domain
concepts in `metadataJson`.

## 7. Storyline membership transaction

`故事线「<名称>」章节关系` represents the complete membership set. Each entry
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
operation. A complete membership replacement may remove existing links, so it
uses confirm-before authorization by default. The explicit author setting for
dangerous operations can waive that prompt without waiving freshness,
transaction, receipt, or guarded-inverse checks. The narrower direct add-link
and set-primary operations are non-destructive and automatic; unlink remains a
deletion and uses the destructive policy.

## 8. Comments, TODOs, and relations

Comments and TODOs are one anchored comment domain. Each object can be
created, read, replaced, deleted, and exactly reverted. Ordinary comment/TODO
creation and update are automatic because they do not rewrite manuscript prose.
Deletion is confirm-before by default and follows the explicit dangerous-operation
override when the author enables it.

Relations resolve author-facing endpoint names to typed project-owned entities.
Create and relation-kind update are non-destructive and execute automatically.
Delete is confirm-before by default, or automatic only when the author has
explicitly enabled dangerous operations. Endpoint ownership and target validity
are still rechecked inside the mutation transaction.

## 9. Agent memory trust model

Agent memory is cross-session writing guidance, not canon and not project
facts.

- An Agent-created memory always starts as `source=agent,status=pending`.
- Pending memory is never injected into model context.
- Only a pending Agent proposal is writable in place.
- Active author-approved guidance is read-only to the Agent.
- Evolving active guidance creates a new pending row with `supersedesId`; it
  does not mutate or retire the active row before author approval.
- Approval atomically activates the proposal and retires its predecessor.
- `forget` is a confirm-before soft delete so provenance and sync convergence
  survive; its inverse can restore the exact live row while lineage is current.

`作者规则` is the readable aggregate. Individual proposals use
`作者规则「<handle>」`.

## 10. Approval policy

| Mutation                                                 | Policy         | User surface                                                         |
| -------------------------------------------------------- | -------------- | -------------------------------------------------------------------- |
| Prose edit                                               | review after   | write immediately; inline editor badge accepts/rejects blocks or all |
| Safe metadata, comment/TODO, pending memory proposal     | automatic      | semantic activity only                                               |
| Delete structural resource, comment/TODO, or memory      | confirm before | chat permission request                                              |
| Relation create or relation-kind update                  | automatic      | semantic activity only                                               |
| Relation delete                                          | confirm before | chat permission request                                              |
| Add storyline membership or set primary                  | automatic      | semantic activity only                                               |
| Remove membership or replace the complete membership set | confirm before | chat permission request                                              |

When the author enables **Allow dangerous Agent operations**, confirm-before
deletes and destructive set replacements execute without an additional prompt.
The setting does not disable schema validation, project isolation, freshness,
durable receipts, or guarded inverses.

The model cannot forge approval. Authorization binds the exact normalized
arguments hash to a permission request. A changed target or payload requires a
new decision.

## 11. Headless acceptance matrix

Milestone D acceptance runs the real product composition against a temporary
file-backed SQLite database created from the current local-first baseline, plus real Yjs for
prose-owning paths. It verifies:

- lifecycle closure for every declared domain and executable strategy;
- natural path creation plus canonical returned paths;
- structural create/update/delete and exact inverse;
- comment/TODO and relation CRUD plus exact inverse;
- full-graph storyline membership replacement and inverse;
- memory trust, supersession, soft delete, sync outbox, and inverse;
- transaction rollback after an injected inner failure;
- reconciliation after a lost outer acknowledgement;
- close/reopen persistence and baseline-journal idempotency;
- read-before-write stale-state refusal;
- automatic relation create/type assignment, destructive-delete confirmation and its
  explicit author override;
- typecheck, targeted lint, and generated capability drift checks.

Run:

```bash
pnpm eval:agent:crud
```

The command writes
`docs/agent-runtime/acceptance/milestone-d-domain-crud.json`. Native visual
behavior, device lifecycle, networked provider behavior, and user checkpoint
UX are explicitly outside this historical Milestone D acceptance. Agent user
checkpoints were later implemented and then removed; native and networked
behavior remain assigned to their own roadmap gates.
