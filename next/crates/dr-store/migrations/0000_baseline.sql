-- Drifting 0.2 library database: the baseline (decision D9).
--
-- Once 0.2.0 is published this file is frozen: every later schema change is
-- a new, ordered file (0001_*.sql, ...) appended to `MIGRATIONS` in
-- src/migrate.rs. A test pins the SHA-256 of every published migration.
--
-- Times are Unix milliseconds. Loro documents are the truth for everything
-- an author writes; the derived tables below can be rebuilt from them.

-- Library-wide settings: `epoch` (see loro_peer), `app_version` (the build
-- that last opened the library), `created_ms`.
CREATE TABLE library_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Every Loro document stored here. `kind` is the doc id prefix (book, node,
-- element, storyline, category, material); `book_id` is the book it belongs
-- to, NULL for documents that belong to no book.
CREATE TABLE loro_doc (
    doc_id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    book_id TEXT,
    created_ms INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX loro_doc_by_book ON loro_doc (book_id, kind);

-- Append-only update log: one row per local commit or imported batch,
-- appended before the commit is announced. `origin` is local-only:
-- user, agent:<session>/<turn>, mirror, sync, import, genesis.
CREATE TABLE loro_update (
    doc_id TEXT NOT NULL REFERENCES loro_doc (doc_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL CHECK (seq > 0),
    bytes BLOB NOT NULL,
    origin TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (doc_id, seq)
) STRICT, WITHOUT ROWID;

-- One full snapshot per document (never a shallow one). Writing it and
-- deleting the updates with seq <= upto_seq happen in one transaction.
CREATE TABLE loro_snapshot (
    doc_id TEXT PRIMARY KEY NOT NULL REFERENCES loro_doc (doc_id) ON DELETE CASCADE,
    upto_seq INTEGER NOT NULL CHECK (upto_seq >= 0),
    vv BLOB NOT NULL,
    frontiers BLOB NOT NULL,
    bytes BLOB NOT NULL,
    ts INTEGER NOT NULL
) STRICT;

-- The peer id this device edits each document with. A row whose epoch is
-- not library_meta.epoch is stale: the next local edit allocates a new peer.
CREATE TABLE loro_peer (
    doc_id TEXT PRIMARY KEY NOT NULL REFERENCES loro_doc (doc_id) ON DELETE CASCADE,
    peer_id INTEGER NOT NULL CHECK (peer_id > 0),
    epoch TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Points in a document's history the author can go back to. `label` is the
-- reason: periodic (at most one per 15 minutes), close, restore, or
-- agent:<session>/<turn> (the version just before that Agent write). Kept 30
-- days, thinned to one per hour after an hour and one per day after a day.
CREATE TABLE history_label (
    id INTEGER PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES loro_doc (doc_id) ON DELETE CASCADE,
    frontiers BLOB NOT NULL,
    label TEXT NOT NULL,
    ts INTEGER NOT NULL
) STRICT;
CREATE INDEX history_label_by_doc ON history_label (doc_id, ts);

-- Derived: per-document counts and the version they were computed at.
CREATE TABLE doc_stats (
    doc_id TEXT PRIMARY KEY NOT NULL REFERENCES loro_doc (doc_id) ON DELETE CASCADE,
    book_id TEXT,
    frontiers BLOB NOT NULL,
    words INTEGER NOT NULL CHECK (words >= 0),
    chars INTEGER NOT NULL CHECK (chars >= 0),
    paragraphs INTEGER NOT NULL CHECK (paragraphs >= 0),
    updated_ms INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX doc_stats_by_book ON doc_stats (book_id);

-- Derived: one row per paragraph, in document order. Serves search (through
-- block_fts), the outline (heading rows) and paragraph lengths for height
-- estimates of documents that are not decoded yet. `block_id` can be NULL
-- or repeated until block ids are repaired.
CREATE TABLE block_index (
    id INTEGER PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES loro_doc (doc_id) ON DELETE CASCADE,
    book_id TEXT,
    ord INTEGER NOT NULL CHECK (ord >= 0),
    block_id TEXT,
    heading INTEGER NOT NULL DEFAULT 0 CHECK (heading BETWEEN 0 AND 3),
    chars INTEGER NOT NULL CHECK (chars >= 0),
    text TEXT NOT NULL,
    UNIQUE (doc_id, ord)
) STRICT;
CREATE INDEX block_index_by_block ON block_index (doc_id, block_id);
CREATE INDEX block_index_by_book ON block_index (book_id);

-- Full-text search over block_index.text. Trigram tokens need at least three
-- characters; one- and two-character queries fall back to LIKE.
CREATE VIRTUAL TABLE block_fts USING fts5 (
    text,
    content = 'block_index',
    content_rowid = 'id',
    tokenize = 'trigram'
);
CREATE TRIGGER block_index_insert AFTER INSERT ON block_index BEGIN
    INSERT INTO block_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER block_index_delete AFTER DELETE ON block_index BEGIN
    INSERT INTO block_fts (block_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER block_index_update AFTER UPDATE OF text ON block_index BEGIN
    INSERT INTO block_fts (block_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO block_fts (rowid, text) VALUES (new.id, new.text);
END;

-- Derived: references from a document to another object. `kind` is link (an
-- entity link mark), mention (a name found in the text) or embed.
CREATE TABLE reference (
    id INTEGER PRIMARY KEY,
    source_doc TEXT NOT NULL REFERENCES loro_doc (doc_id) ON DELETE CASCADE,
    source_block TEXT,
    book_id TEXT,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('link', 'mention', 'embed')),
    count INTEGER NOT NULL DEFAULT 1 CHECK (count > 0)
) STRICT;
CREATE INDEX reference_by_target ON reference (target_id, kind);
CREATE INDEX reference_by_source ON reference (source_doc);

-- Asset bytes this device holds: files at
-- assets/<book_id>/<asset_id>/<variant>.<ext>. The book document carries the
-- asset's metadata; a source row is immutable once written.
CREATE TABLE asset (
    asset_id TEXT NOT NULL,
    variant TEXT NOT NULL CHECK (variant IN ('source', 'display', 'thumbnail')),
    book_id TEXT NOT NULL,
    mime TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size > 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    width INTEGER CHECK (width IS NULL OR width > 0),
    height INTEGER CHECK (height IS NULL OR height > 0),
    created_ms INTEGER NOT NULL,
    PRIMARY KEY (asset_id, variant)
) STRICT, WITHOUT ROWID;
CREATE INDEX asset_by_book ON asset (book_id, sha256);
