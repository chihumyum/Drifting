-- Drifting 0.2 library database: the baseline (decision D9).
--
-- Once 0.2.0 is published this file is frozen: every later schema change is
-- a new, ordered file (0001_*.sql, ...) appended to `MIGRATIONS` in
-- src/migrate.rs. A test pins the SHA-256 of every published migration.
--
-- Times are Unix milliseconds. Loro documents are the truth for everything
-- an author writes; the derived tables can be rebuilt from them.
--
-- No triggers and no cascades: every multi-table change is one explicit
-- transaction in dr-store (purging a document deletes its rows everywhere),
-- and invariants live in the command layer and in tolerant reads.

-- Library-wide settings: `library_id` (stable across copies), `epoch` (see
-- loro_peer), `installation_id` (the device that last opened the library),
-- `write_seq` (count of appended updates, compared with the device's record
-- to notice an older copy put back), `app_version`, `created_ms`.
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
-- appended before the commit is announced. `origin` is a local note
-- (user, agent:<session>/<turn>, mirror, sync, import, genesis, outside);
-- compaction deletes rows, so the durable record of who wrote what is the
-- Loro change itself (peer, timestamp, commit message).
CREATE TABLE loro_update (
    doc_id TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK (seq > 0),
    bytes BLOB NOT NULL,
    origin TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (doc_id, seq)
) STRICT, WITHOUT ROWID;

-- One full snapshot per document (never a shallow one). Writing it and
-- deleting the updates with seq <= upto_seq happen in one transaction.
CREATE TABLE loro_snapshot (
    doc_id TEXT PRIMARY KEY NOT NULL,
    upto_seq INTEGER NOT NULL CHECK (upto_seq >= 0),
    vv BLOB NOT NULL,
    frontiers BLOB NOT NULL,
    bytes BLOB NOT NULL,
    ts INTEGER NOT NULL
) STRICT;

-- The latest stored state of each document, written in the same
-- transaction as each append: its last seq, version vector, frontiers and
-- time. Lets the library answer "what changed since", "what is newer than
-- the index" and "what has not reached the server" without loading docs.
CREATE TABLE loro_head (
    doc_id TEXT PRIMARY KEY NOT NULL,
    seq INTEGER NOT NULL,
    vv BLOB NOT NULL,
    frontiers BLOB NOT NULL,
    ts INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX loro_head_by_ts ON loro_head (ts);

-- The peer id this device edits each document with. A row whose epoch is
-- not library_meta.epoch is stale: the next local edit allocates a new peer.
CREATE TABLE loro_peer (
    doc_id TEXT PRIMARY KEY NOT NULL,
    peer_id INTEGER NOT NULL CHECK (peer_id > 0),
    epoch TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- What the sync service already has of each document. Uploads export the
-- document's updates after remote_vv (from the document, not from rows), so
-- compaction and upload are independent; a head vv beyond remote_vv means
-- changes that exist only on this device.
CREATE TABLE sync_doc (
    doc_id TEXT PRIMARY KEY NOT NULL,
    remote_vv BLOB NOT NULL,
    updated_ms INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- Points in a document's history the author can go back to, with the book
-- document's version at that moment (restoring one entity needs both).
-- `label`: periodic (at most one per 15 minutes), close, restore, or
-- agent:<session>/<turn> (the version just before that Agent turn). Kept 30
-- days, thinned to one per hour after an hour and one per day after a day.
CREATE TABLE history_label (
    id INTEGER PRIMARY KEY,
    doc_id TEXT NOT NULL,
    frontiers BLOB NOT NULL,
    book_frontiers BLOB,
    label TEXT NOT NULL,
    ts INTEGER NOT NULL
) STRICT;
CREATE INDEX history_label_by_doc ON history_label (doc_id, ts);

-- What each Agent write changed: written in the same transaction as the
-- update. No review states: Agent writes commit directly and are undone
-- through history.
CREATE TABLE agent_settlement (
    id INTEGER PRIMARY KEY,
    session TEXT NOT NULL,
    turn TEXT NOT NULL,
    call TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    before_frontiers BLOB NOT NULL,
    after_frontiers BLOB NOT NULL,
    summary TEXT NOT NULL,
    ts INTEGER NOT NULL
) STRICT;
CREATE INDEX agent_settlement_by_session ON agent_settlement (session, turn);
CREATE INDEX agent_settlement_by_doc ON agent_settlement (doc_id, ts);

-- Derived: the seq and version each document's derived rows were computed
-- at, written in the same transaction as the rows. A document whose head
-- seq is beyond indexed_seq is rebuilt.
CREATE TABLE index_state (
    doc_id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT,
    indexed_seq INTEGER NOT NULL,
    frontiers BLOB NOT NULL,
    words INTEGER NOT NULL CHECK (words >= 0),
    chars INTEGER NOT NULL CHECK (chars >= 0),
    paragraphs INTEGER NOT NULL CHECK (paragraphs >= 0),
    updated_ms INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX index_state_by_book ON index_state (book_id);

-- Derived: one row per paragraph, in document order. Serves search (through
-- block_fts), the outline (heading rows) and paragraph lengths for height
-- estimates of documents that are not decoded yet. `block_id` can be NULL
-- or repeated until block ids are repaired.
CREATE TABLE block_index (
    id INTEGER PRIMARY KEY,
    doc_id TEXT NOT NULL,
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

-- Full-text search over block_index.text, kept in step by dr-store in the
-- same transaction (no triggers). Trigram tokens need at least three
-- characters; one- and two-character queries fall back to LIKE.
CREATE VIRTUAL TABLE block_fts USING fts5 (
    text,
    content = 'block_index',
    content_rowid = 'id',
    tokenize = 'trigram'
);

-- Derived: references from a document to another object. `kind` is link (an
-- entity link mark), mention (a name found in the text) or embed.
CREATE TABLE reference (
    id INTEGER PRIMARY KEY,
    source_doc TEXT NOT NULL,
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
-- assets/<book>/<asset>/<variant>.<ext> (segments sanitized as in 0.1). The
-- book document carries the asset's metadata; a source row is immutable
-- once written. `uploaded_ms` is when the sync service confirmed the bytes.
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
    uploaded_ms INTEGER,
    PRIMARY KEY (asset_id, variant)
) STRICT, WITHOUT ROWID;
CREATE INDEX asset_by_book ON asset (book_id, sha256);
