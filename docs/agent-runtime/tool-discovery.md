# Model-directed tool discovery

General Agent no longer guesses which eight tools an author will need.
`agentToolSearch=auto` and `on` use two fixed provider functions:

- `tool_search`: its description includes every currently authorized tool's
  name, access and description, without parameter schemas. Exact-name lookup,
  text search and catalog pagination return the original schemas as tool results.
- `call_tool`: accepts the original tool name and an arguments object. The
  runtime decodes the envelope before validation, permission checks and dispatch.

The tool directory is captured once per turn after project and read-only
filtering. Searches, repairs and pending result pages never replace the provider
`tools` array. Returned schemas enter ordinary conversation history, where they
are budgeted, persisted and compacted normally; the model can retrieve them again.
Final synthesis retains the same definitions with `tool_choice=none`.
`off` remains the full-schema option. Actual catalog or access changes may change
the next turn's directory; this is not a promise of cache hits across such changes.

Canonical history, approvals, scheduler access, execution generations and write
receipts retain the real operation name and arguments. Provider history projects
those calls back through `call_tool`, preserving call IDs and provider reasoning
replay. Additional dispatch framing is reserved before context planning. Search
only exposes the authorized catalog; it does not grant project or write access.
Malformed/unknown dispatches cannot reach a handler.

Already-returned schemas are reusable conversation context. Request related
missing schemas together rather than searching before every invocation.
After an explicit continuation or retry, certified successful search results
survive authored-object writes and process restart. Ordinary data reads still
expire at a later write; restored schemas never bypass current validation or
permissions. Failed, aborted and interrupted turns restore only certified reads
and author intent, never replaying a previous write.

`tool_search` is owned by the per-turn runtime, not the product's composite
tool registry. Serial execution and scheduled read batches share its dispatcher.
A registered search must return schemas even when the composite registry has no
search handler; named lookup and empty-query browsing cover this regression.

The development renderer retains long-lived transport instances. After changing
runtime wiring, validate a freshly loaded renderer as well as source tests;
HMR notifications alone do not prove that the installed instance uses new code.

Acceptance: `tool-discovery.test.ts`, product-composition tests and provider
serialization tests cover discovery, vague continuations, fixed prefixes,
schema repair, read-only filtering, permission enforcement and durable history.
All fixtures are synthetic. A live account/cache-hit campaign is a separate gate.
The generated `acceptance/agent-capabilities.{json,md}` records the current contract.
