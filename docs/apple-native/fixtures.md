# Synthetic document corpus

No manuscript, live database, account data or private-service content may be
used. The generated [document-v1.json](fixtures/document-v1.json) contains current-Yjs
update bytes, canonical semantics and a comment anchor. Run
`node scripts/generate-apple-fixtures.mjs --check` to verify it. The matrix below
is the P2 workload specification; native document compatibility is not yet claimed.

| Fixture | Contents | Required check |
| --- | --- | --- |
| semantic-tree | headings, paragraphs, nested lists, blockquote, code block, separator; fixed block IDs | Unchanged identities and tree semantics after targeted edits |
| inline-format | bold/italic/underline/link/entityLink, overlapping format runs | Unmodified marks survive both implementations |
| unicode-ime | Chinese, supplementary CJK, emoji/ZWJ/skin tone, combining accents, RTL and mixed line breaks | Explicit UTF-16/CRDT/grapheme mapping; device IME separate |
| anchors | same-block and cross-block comments, element patches, deleted target | Correct anchor resolution/invalidation after split/merge/delete/undo |
| opaque-data | unknown attributes and unsupported embedded node with synthetic metadata | Preserve on surrounding edits; unsupported edit fails explicitly |
| concurrency | two independent peers edit overlapping and separate spans | Incremental/reordered/duplicate update convergence and no remote undo |
| durable-tail | persisted remote N+1, authored N+2, lost callback, snapshot and crash | Exact SQLite-tail replay before compaction; no echo |
| scale | generated 5k/50k/200k UTF-16-unit chapters and 1k synthetic chapter metadata rows | Measure load/edit/scroll/split/reopen without private documents |

Compare canonical document semantics and required stable identities. Do not
require identical encoded update bytes or random runtime peer IDs. Retain seeds,
operations, library versions/configuration and failure reproductions.

P1 currently exercises a Unicode project name only; it does not stand in for
this document corpus. Its database is the real published schema initialized in
an isolated temporary or lab directory.
