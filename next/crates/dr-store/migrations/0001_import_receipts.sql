-- The 0.1 library import's receipt (M10, dr-import-v1): what each import run
-- read, normalised and doubted. Device-local; written by dr-import-v1 through
-- Library::local_transaction. The shapes are M10's (`receipt.rs`); the other
-- 0.1 device-local data waits for its owners (see f2-store.md): the read-only
-- Agent archive (M31), MCP servers (M32), working memory (M30), the Markdown
-- folder ledger (M40) and local settings (F6).

CREATE TABLE import_run (
    id INTEGER PRIMARY KEY,
    importer TEXT NOT NULL,
    started_ms INTEGER NOT NULL,
    finished_ms INTEGER NOT NULL,
    source_sha256 TEXT NOT NULL,
    source_bytes INTEGER NOT NULL,
    schema_level_before INTEGER NOT NULL,
    gate_json TEXT NOT NULL,
    accepted_json TEXT NOT NULL,
    summary_json TEXT NOT NULL
) STRICT;

CREATE TABLE import_book (
    run_id INTEGER NOT NULL,
    book_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (run_id, book_id)
) STRICT;

CREATE TABLE import_doc (
    run_id INTEGER NOT NULL,
    doc_id TEXT NOT NULL,
    old_doc_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    freshness TEXT NOT NULL,
    revision INTEGER,
    cache_sha256 TEXT,
    history_versions INTEGER NOT NULL,
    stored_exactly INTEGER NOT NULL,
    round_trips INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (run_id, doc_id)
) STRICT;

CREATE TABLE import_anchor (
    run_id INTEGER NOT NULL,
    entity TEXT NOT NULL,
    id TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    resolution TEXT NOT NULL,
    cursor INTEGER NOT NULL,
    PRIMARY KEY (run_id, entity, id)
) STRICT;

CREATE TABLE import_original (
    run_id INTEGER NOT NULL,
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    field TEXT NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (run_id, collection, id, field)
) STRICT;
