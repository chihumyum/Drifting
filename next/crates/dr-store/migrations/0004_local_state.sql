-- Small device-local state of the modules (dr-store `local_state.rs`):
-- what the author opened recently, panel sizes, a module's last choice.
-- Never synced, never part of a document; one value per (scope, key),
-- usually JSON. `scope` names the owning module (`ws` for dr-workspace);
-- `book_id` ties a row to a book, so purging the book's last document
-- removes it. Written through Library::local_write.

CREATE TABLE local_state (
    scope TEXT NOT NULL CHECK (length(scope) > 0),
    key TEXT NOT NULL CHECK (length(key) > 0),
    value TEXT NOT NULL,
    book_id TEXT,
    changed_ms INTEGER NOT NULL,
    PRIMARY KEY (scope, key)
) STRICT, WITHOUT ROWID;
CREATE INDEX local_state_by_book ON local_state (book_id) WHERE book_id IS NOT NULL;

-- dr-workspace kept its recently opened pages under `library_meta`
-- ('ws.recent') until this table existed; the value moves unchanged.
INSERT INTO local_state (scope, key, value, book_id, changed_ms)
    SELECT 'ws', 'recent', value, NULL, CAST(unixepoch('subsec') * 1000 AS INTEGER)
    FROM library_meta WHERE key = 'ws.recent';
DELETE FROM library_meta WHERE key = 'ws.recent';
