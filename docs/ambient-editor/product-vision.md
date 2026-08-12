# Shadow Ambient Editor product vision

Status: **normative target experience; not implemented**

Updated: 2026-08-11

## Vision

Writing a novel produces two very different attention problems.

While writing, the author needs immediate, local awareness: the current
sentence, paragraph, scene, nearby continuity, and the intent held in working
memory. Copilot belongs here.

Between writing sessions, the author needs a second kind of awareness: what the
whole manuscript has become, which promises are accumulating, where character
knowledge or relationships have shifted, and whether a change elsewhere has
altered the meaning of an earlier scene. Shadow belongs here.

Shadow is therefore not a reviewer waiting at a gate. It is an ambient editor:
a quiet reader that maintains continuity of attention across the entire project
when the author cannot.

The ideal result is not “the manuscript passed.” The ideal result is:

> When the author returns, Drifting already understands what materially changed,
> has reread only the parts whose meaning may have changed, and can offer a few
> precise observations that feel like they came from an editor who remembers the
> whole book and respects the author's taste.

## Experience principles

### 1. Attention, not judgment

Shadow says “this may deserve another look,” not “this is wrong.” It may point
out tension, ambiguity, an unresolved promise, an unusual repetition, or a
possible continuity shift. The author retains final interpretation.

The product contains no green/red pass state, compliance score, failure count,
or chapter gate. Silence means only that no eligible Concern survived the
current evidence and Lenses; it never certifies literary correctness.

### 2. Evidence before explanation

Every Concern begins with the manuscript evidence that motivated it. The author
can inspect the exact passages, the relevant Canon, the Lens used, and the
change that made the question timely before reading a model-generated
explanation.

An observation without valid evidence is discarded, not shown with weaker
language.

### 3. Whole-book memory without an omniscient fiction

Shadow may behave like a reader who remembers the whole project, but the UI
must not imply that its World Model is authoritative or complete. It is a
rebuildable interpretation tied to exact source versions.

When confidence is limited, the Concern expresses uncertainty. When sources
change during analysis, Shadow retries from a fresh snapshot instead of
presenting stale certainty.

### 4. Author-defined taste

Editorial Lenses are authored reading intentions, not hidden system rubrics.
Examples include:

- “Track what each viewpoint character can know at each moment.”
- “Notice when acts of care become explicit explanation instead of behavior.”
- “Follow every promise associated with the red notebook through the book.”
- “Read the middle third for repeated emotional beats, but do not optimize for
  conventional pace.”

The author can inspect what a Lens reads, how far it may look, and when it may
run. A compiled Lens may operationalize scope and retrieval but cannot rewrite
the author's principle.

### 5. Quiet by default

Shadow accumulates and reconciles observations without interrupting the active
writing loop. Notifications are digests, not a stream of task alerts. Concerns
are grouped and deduplicated. A new model phrasing does not create a new card.

Urgency is expressed by relevance and timing, never by invented severity.

### 6. Explicit handoff before action

Shadow observes. Copilot assists locally. General Agent acts only after the
author asks.

Turning a Concern into a TODO or asking General Agent to investigate is a
visible user decision. Shadow never edits prose or Canon to make its own
observation disappear.

## Ideal end-to-end experience

### First setup

The author opens Shadow for the first time and sees a short explanation:

1. Shadow reads the project during eligible idle windows.
2. It follows only enabled Editorial Lenses.
3. It creates observations with exact evidence, never grades.
4. It cannot edit the manuscript.

Drifting offers a small starter set of transparent Lens templates, but no Lens
is silently enabled. The author can write a Lens in natural language and sees a
plain-language coverage summary such as:

> This Lens reads character knowledge claims, relevant Canon and element
> patches, then looks backward to the last scene containing the same character.
> It may run after five minutes of inactivity. It cannot edit anything.

Raw compiled JSON remains a debug/developer disclosure, not the primary
permission experience.

### During writing

Copilot continues to respond to the mounted editor and local context. Shadow
does not compete for the author's attention or initiate expensive whole-book
calls after every keystroke.

Local source changes update inexpensive fingerprints and projection debt. If
the author keeps writing, provider work waits. The UI may show a quiet status
such as “Shadow will revisit 3 affected areas when the project is idle,” but it
does not show three alleged problems.

### When the author steps away

After the configured idle threshold, Shadow:

1. confirms that relevant source versions are stable;
2. updates the affected World Model projection;
3. determines which Lens/scope pairs genuinely became eligible;
4. performs bounded read-only reconciliation within the daily budget;
5. merges results into existing Concerns or creates new ones;
6. prepares one digest for the next return.

If the app sleeps, loses connectivity, changes project, or reaches its budget,
the work remains pending with an honest reason. There is no hidden fallback to
another provider and no fake completion.

### When the author returns

The author sees a calm summary, for example:

> Shadow reread 4 affected chapters using 2 Lenses. One existing observation was
> resolved by your changes, one was updated, and one new question may deserve
> attention.

The Inbox is organized by change, not by model run:

- **New** — an editorial question with a new stable identity;
- **Updated** — the same question now has materially different evidence;
- **Reconsidered** — a prior author dismissal became eligible only because its
  basis changed;
- **Resolved** — the evidence disappeared or a fresh reconciliation supports
  closure, with history preserved.

Each card reveals information progressively:

1. Lens and concise observation;
2. exact manuscript evidence and related Canon;
3. “Why now” source changes;
4. reasoning, dependency scope, and run details;
5. actions: seen, dismiss, explain preference, create TODO, ask General Agent.

There is no left accent bar, pass color, or alarming error icon. Visual weight
comes from typography, spacing, background wash, and recency.

### Teaching Shadow

If the author dismisses a Concern, that exact evaluation basis remains
suppressed. It will not return merely because another model phrases it
differently.

The author may optionally explain: “This repetition is intentional because each
instance shifts point of view.” Shadow can propose a generalized Precedent, but
it becomes active only after the author confirms the scope in plain language.

Future eligible Concerns show which Precedent affected them. The author can
disable or revise it. Preference learning is inspectable authoring, not hidden
fine-tuning.

### Acting on an observation

- **Seen** clears notification state without changing the Concern's editorial
  basis.
- **Dismiss** records the author's decision for the current basis.
- **Create TODO** creates a normal anchored TODO linked by `originConcernId`.
- **Ask General Agent** opens an explicit task with the Concern, evidence, Lens,
  and source manifest attached.
- **Edit manually** changes Yjs; the normal projection and reconciliation cycle
  later decides whether the Concern resolves.

Neither accepting a Copilot suggestion nor completing a General Agent task
directly toggles the Concern to resolved. The manuscript change is the cause;
reconciliation is the proof.

## Final idealized effect

At maturity, Shadow should create three kinds of leverage without feeling like
another inbox the author must manage:

1. **Continuity of memory** — the project remembers character knowledge,
   relationships, promises, objects, timelines, and authored Canon across long
   gaps between writing sessions.
2. **Continuity of attention** — a local revision automatically causes the
   relevant upstream, downstream, and whole-book questions to be reconsidered,
   without rereading everything or asking the author to launch a review.
3. **Continuity of taste** — author-confirmed Lenses and Precedents shape future
   reading while remaining inspectable, reversible, and subordinate to the
   manuscript.

The best session may contain no new Concern. The value is confidence that
relevant changes were considered, not a machine's need to produce feedback.

## Non-goals

Shadow is not:

- a grammar checker or line-level autocomplete replacement;
- a literary quality score;
- a publishing compliance gate;
- an autonomous rewrite system;
- an authoritative source of Canon;
- a substitute for explicit General Agent long tasks;
- a promise of work after the app process exits;
- a hidden cloud service or server-side copy of a BYOK manuscript;
- an engine that turns every author dismissal into a global rule;
- a resurrected form of `shadow_job`, `project_rule`, `submit_verdicts`, or the
  retired Shadow Panel.

## Product success criteria

Success is measured primarily by author outcomes:

- authors can understand why every Concern exists;
- repeated runs do not create repeated editorial noise;
- dismissed equivalent observations stay dismissed;
- relevant manuscript changes cause existing observations to evolve rather
  than multiply;
- useful observations arrive after natural idle periods without interrupting
  writing;
- authors trust that Shadow cannot edit their work;
- Lenses and Precedents feel like authored editorial taste, not prompt settings;
- turning an observation into action is explicit and reversible.

Citation validity, stale-result rejection, duplicate rate, budget enforcement,
and lifecycle consistency are release gates. Subjective literary usefulness is
validated separately on real projects with authors and paid providers; it is
not inferred from deterministic tests.
