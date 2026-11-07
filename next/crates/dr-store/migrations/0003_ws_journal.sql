-- The workspace's command journal (F3, dr-workspace `journal.rs`): one row
-- per write command (who, which command, which book, what it did, how to
-- undo it), from which the object-level undo and redo stacks are read.
-- Device-local; written through Library::local_write.

CREATE TABLE ws_journal (
  seq INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  command TEXT NOT NULL,
  book TEXT,
  effects TEXT NOT NULL,
  undo TEXT,
  redo TEXT,
  state TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'undone', 'dead')),
  changed_ts INTEGER NOT NULL
) STRICT;
CREATE INDEX ws_journal_actor ON ws_journal (actor, state, seq);
