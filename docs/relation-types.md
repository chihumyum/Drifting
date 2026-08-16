# Project relation types

Drifting relations use one project-scoped, first-class semantic owner.
`entity_relation.relation_type_id` is required; relation rows do not copy a
name or keep a free-text `kind` mirror.

## Semantic contract

- `directed`: source and target roles are required. Endpoint kinds must match
  their declared side. A reversed compatible pair is rejected with an explicit
  swap instruction; Drifting does not silently reverse authored data.
- `symmetric`: both sides share one role and the same structural entity kinds.
  New edges use a deterministic endpoint order so retries and cross-device
  hydration agree.
- Every authored type has `systemKey = null` and `locked = false`. Renaming
  it changes only the definition; every relation continues to reference the
  same id without row rewrites or extra sync operations.
- Changing endpoint rules validates every relation already using the type. A
  type with live relations cannot be deleted.

There is no nullable, unconfigured, or legacy-label state. Old payloads that
contain relation `kind`, omit `relationTypeId`, reference an unknown or
cross-project type, or contain invalid type system fields fail before
hydration writes to SQLite.

## Built-in generic association

Each new project owns one deterministic `generic-association` type. TODO and
library-item one-click links use this type through an explicit
`addGenericAssociation` use case; the same type is created transactionally on
first use if a current project was created without opening that surface.

Its persisted id, name, description, roles, endpoint kinds, and
`systemKey = "generic-association"` are locale-independent. UI and Markdown
presentation may derive localized copy from `systemKey`; locale never changes
the stored or synced payload. `locked = true` is an integrity boundary, not
only a hidden button:

- repository and Agent writes reject update/delete;
- SQLite triggers reject field changes and endpoint mutation;
- project deletion is still allowed to cascade through the type and endpoints.

## Persistence and sync

- `entity_relation_type` owns the definition;
  `entity_relation_type_endpoint_kind` owns allowed endpoint-kind sets.
- `entity_relation` has a composite foreign key from
  `(relation_type_id, project_id)` to `(entity_relation_type.id,
  entity_relation_type.project_id)`.
- A unique index on project, endpoints, and relation type provides durable
  idempotency for one semantic edge. Different relation types may still connect
  the same endpoint pair.
- Hydration inserts type parents and endpoint rows before relation children.
  Offline pending relations retain their referenced local type.
- Hosted Postgres and future SyncEngine providers exchange the same explicit
  type definition and type-id relation payload. Object storage may store the
  immutable operations, but it does not invent labels or repair old payloads.

## Product surfaces

Desktop Story Graph, Element overview, References, TODO, and Library resolve
labels, roles, descriptions, filters, and colors from the type id. Presentation
metadata is keyed by type id, so authored rename never changes edge identity or
color. The shared type editor offers compatible authored definitions and
prevents editing/deleting the locked built-in type.

General Agent lists, creates, updates, and deletes authored relation types and
assigns relations by a resolved type id. Its durable receipts snapshot
`relationTypeId`, never a copied label.

The shared domain and sync implementation compiles for Tauri targets, but this
does not certify an iOS or Android relation-management UI. Desktop visual review
and physical-device touch, keyboard, safe-area, background, and visual
acceptance remain manual.
