-- Books that stay on this device (dr-store `local_book.rs`): the working
-- copy a project template is edited in (dr-workspace). Sync never sees
-- them: none of their documents, asset bytes or purge records is listed
-- for upload. `note` is the owning module's (dr-workspace: the template
-- the copy edits). A row is kept for good, like a purge record, so the
-- purge records of a copy that was thrown away never upload either.

CREATE TABLE local_book (
    book_id TEXT PRIMARY KEY CHECK (length(book_id) > 0),
    note TEXT NOT NULL,
    created_ms INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
