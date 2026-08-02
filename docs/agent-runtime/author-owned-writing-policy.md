# General Agent author-owned writing policy

Status: normative for Milestone H replacement and later.

Drifting provides a durable project workspace and safe data mechanics. It does
not prescribe how the author or model should write. Writing policy belongs to
the author.

## 1. Provider context

Every General Agent turn receives only the writing guidance the author owns:

- the current author request and conversation history;
- editable project facts/rules from the project's `kvJson`;
- active long-term Agent rules created by the author or explicitly approved by
  the author;
- durable task/checkpoint state required to continue the requested work.

The product does not derive or inject an editor entity, selection, block,
nearby prose, target whitelist, style profile, POV, tense, voice, plot rule,
canon rule, citation duty or manuscript language.

## 2. No content mutation guard

Any project item exposed by the installed workspace tools may be read or
changed when the model decides it is useful for the author's request. The
currently open editor, a previously active chapter and phrases such as
“这里”/“这段” are not product-level authority and never become a write scope.

The runtime does not:

- resolve deictic phrases against UI focus;
- freeze UI focus into a turn;
- reject a write because another entity was open or named earlier;
- require the author to add an entity to an internal scope;
- require canon/element patches before changing prose;
- infer conflicting writing rules and block all writes pending confirmation;
- impose default plot, chronology, POV, tense or voice preservation.

The model resolves ordinary language from the conversation and workspace. It
may call `ask_user` when the intended result is genuinely ambiguous, but the
product does not manufacture an ambiguity or force a question.

## 3. Retained execution integrity

Removing content policy does not remove data integrity:

- project isolation prevents cross-project access;
- current Yjs prose remains the manuscript source of truth;
- read-before-write revisions and CAS reject stale concurrent writes;
- stable idempotency keys prevent duplicated effects;
- ordinary prose edits retain inline Review/reveal and exact undo;
- destructive structural operations retain explicit permission;
- durable receipts, checkpoints and task state prevent false recovery claims.

These mechanisms protect data and authorship. They do not decide literary
content or restrict which in-project entity the model may choose.

## 4. Author rule lifecycle

Project-level facts and rules are ordinary editable KV rows on the Project
Dashboard. They are loaded verbatim on each new turn.

Long-term Agent rules support `preference`, `directive` and `veto`:

- an author-created rule is active immediately;
- an Agent-proposed rule remains pending until the author approves it;
- the author can delete any rule so it no longer enters later prompts;
- approval, supersession and deletion persist through SQLite and the sync
  outbox;
- only active, non-deleted rules are injected.

New projects currently start with no hidden writing rules. A future starter
template may create ordinary visible rows, but every row must remain editable
and deletable by the author.

## 5. Multi-session consequence

No Session depends on global editor focus. Multiple Sessions may eventually
load the same current project rules while keeping independent conversation,
Provider history and task state. Concurrent data mutations are coordinated by
the shared writer scheduler and revision/CAS checks, not by literary scope.

## 6. Headless acceptance

Run:

```bash
pnpm --dir client eval:agent:writing
```

The gate proves:

- no product-derived focus or default literary rules enter the system prompt;
- author-owned project rules and approved long-term rules are injected;
- the capability manifest declares no content scope or canon-patch gate;
- one turn can edit arbitrary project prose entities;
- the reported regression can append to a Drift without inheriting a stale
  chapter focus;
- TypeScript, scoped ESLint and generated capability docs remain synchronized.

