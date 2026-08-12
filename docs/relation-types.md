# Project relation types

Drifting relations use project-scoped type definitions. A definition owns its
name, description, orientation, endpoint roles, and allowed entity kinds. The
relation row keeps `kind` as a readable compatibility projection and stores the
definition identity in `relation_type_id`.

## Semantic contract

- `directed`: source and target roles are required. Endpoint kinds must match
  their declared side. A reversed compatible pair is rejected with an explicit
  swap instruction; Drifting does not silently reverse authored data.
- `symmetric`: both sides share one role and the same structural entity kinds.
  New edges use a deterministic endpoint order so retries and cross-device
  hydration agree.
- `unconfigured`: migration-only compatibility state for an existing
  free-text label. Existing relations remain readable and syncable, but new
  desktop or Agent writes cannot choose it until the author configures it.

Changing a definition validates every relation that already uses it. Converting
to symmetric fails if an existing edge first needs its endpoints swapped. A
type with live relations cannot be deleted.

## Persistence and sync

- SQLite: `entity_relation_type` owns the definition and
  `entity_relation_type_endpoint_kind` owns its ordered endpoint-kind sets.
- Server: Postgres mirrors those tables and returns both definitions and child
  rows in the project graph. Relation writes take a shared definition lock;
  definition edits take an exclusive lock so a concurrent edge cannot pass
  validation against stale endpoint rules.
- Sync: the type parent is created before relation children during hydration;
  rename updates keep the relation `kind` projection aligned. Offline pending
  relations retain their referenced local type. A direction change sends the
  complete endpoint tuple; the server revalidates project ownership and type
  semantics before applying the swap atomically.
- Legacy migration: one deterministic UTF-8 id is derived per
  `(project, normalized label)`. Migration never flips or deletes an existing
  relation.

## Product surfaces

Desktop Story Graph, Element overview, and References select compatible
configured definitions with a body-portaled fixed popover. The shared relation
menu creates and edits definitions, shows project-wide usage counts, and guards
deletion. Story Graph and Element overview also reuse the same definition editor
inside their manual-link modal; a newly created compatible type is selected
immediately, so the author can finish the relation without leaving the flow.
In both graph surfaces, selecting an edge opens one shared body-portaled detail
popover at the pointer. It shows the type, orientation, endpoint roles, entity
kinds, authored endpoint names, optional description, and the delete action.
Every directed edge renderer stops at the target-card boundary and draws an
arrowhead; symmetric and migration-only `unconfigured` edges remain
arrowless. This contract covers ordinary world edges, sticky/viewport edges,
and edges connected to the floating inspiration drawer.
General Agent exposes `list_relation_types`,
`create_relation_type`, `update_relation_type`, and `delete_relation_type`;
mutations use the normal project freshness, atomic outbox, immutable receipt,
restart reconciliation, and exact inverse path.

The shared domain and sync implementation compiles for Tauri targets, but this
does not certify an iOS or Android relation-management UI. Desktop visual review
and physical-device touch, keyboard, safe-area, background, and visual
acceptance remain manual.
