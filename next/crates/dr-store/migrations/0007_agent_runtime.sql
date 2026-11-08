-- M27: the device-local runtime journal. Conversation content lives in a
-- separate Loro document and syncs; these rows never enter sync exports.
-- Session identity is immutable. Runtime state and messages are projections
-- of events, not a second mutable message/state table.
CREATE TABLE agent_session (
    session TEXT PRIMARY KEY NOT NULL,
    conversation TEXT NOT NULL,
    book_id TEXT NOT NULL,
    created_ms INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX agent_session_by_book ON agent_session (book_id, created_ms, session);
CREATE INDEX agent_session_by_conversation ON agent_session (conversation, created_ms, session);

CREATE TABLE agent_event (
    session TEXT NOT NULL REFERENCES agent_session (session),
    seq INTEGER NOT NULL CHECK (seq > 0),
    event_json TEXT NOT NULL CHECK (json_valid(event_json)),
    ts INTEGER NOT NULL,
    PRIMARY KEY (session, seq)
) STRICT, WITHOUT ROWID;
