-- Documents purged on this device (dr-store `purge.rs`): deleted with
-- everything stored for them, and refused when sync or an import would
-- create them again. A book counts as purged once its last document is:
-- some row here names it and no `loro_doc` row does. Kept until something
-- brings the document back on purpose (forget_purged).

CREATE TABLE purged_doc (
    doc_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    book_id TEXT,
    purged_ms INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX purged_doc_by_book ON purged_doc (book_id) WHERE book_id IS NOT NULL;
