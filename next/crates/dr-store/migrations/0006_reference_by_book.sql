-- Derived references of a whole book (`Library::references_in_book`, F3's
-- `mention.list` without `from`/`to`): filtered and ordered by the index
-- (`ORDER BY source_doc, id`; the rowid ends every index) instead of a scan
-- of every book's rows and a sort.

CREATE INDEX reference_by_book ON reference (book_id, source_doc);
