# Retired: Agent checkpoint, rewind, and fork protocol

Retired: 2026-08-02

The Milestone G author-visible Agent checkpoint and conversation-fork system
has been removed from the product.

It duplicated Drifting's existing entity snapshot history, blocked every Agent
turn on a complete pre-execution capture, stored branch ancestry inside chat
rows, and introduced shared recovery state that would complicate independent
parallel sessions.

The current boundaries are:

- manuscript history and restore:
  [`entity-snapshot-history.md`](entity-snapshot-history.md);
- Agent write acceptance/rejection:
  [`durable-commit-review-protocol.md`](durable-commit-review-protocol.md);
- runtime crash/context recovery:
  [`context-engineering-protocol.md`](context-engineering-protocol.md);
- session model: independent flat conversations with no checkpoint parent or
  branch identity.

Migration `0074_agent_user_checkpoint.sql` remains immutable historical
migration evidence. Migration `0077_remove_agent_user_checkpoint.sql` removes
its tables and conversation columns from existing and fresh databases.
