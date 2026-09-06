# Persistent paper toolbar and General Agent acceptance

Date: 2026-09-05. Native build from the working checkout, iPhone 17 Pro,
iOS 26.5 Simulator, 402 × 874 CSS pixels. Geometry observations are recorded
in `mobile-paper-agent-2026-09-05.json`; fixture conversations were synthetic
and removed after acceptance.

- Reading: Agent, Search, Plot and Timeline remain in the bottom toolbar.
  Navigation sits above it. 本纸 opens a fixed body-portaled popover with only
  Outline and sticky-note switches. Search found its synthetic fixture match.
- Agent: three recent sessions, searchable full history, first-send expansion,
  header session switching, close/reopen and restore after renderer reload passed.
  The expanded frame measured x=8, y=70, width=386, height=762; it reserves no
  manuscript reading gutter. Reading restoration did not summon the keyboard in
  this run; since 2026-09-06 entering Agent from reading focuses the composer.
- Native touch: entering prose editing, transferring focus to Agent and back,
  and opening/closing the Agent keyboard passed. At visual viewport height 539,
  the composer ended at y=530, above the keyboard. The compatibility mousedown
  is cancelled so pointer activation cannot blur prose before the handoff.
- Send used the real composer and shared store with a temporary local transport
  stub. The captured provider prompt equalled the synthetic input exactly and
  the durable user message had no context refs. Closing did not call abort and
  the in-flight session remained available. This verifies UI/runtime dispatch;
  it is not live-provider response or physical-device acceptance.
- Plot uses the toolbar's keyboard geometry; its pane ends above the toolbar,
  which ends above the keyboard. The 45px header applies no second safe-area
  band. Back dismisses its keyboard before leaving the tool. Timeline lanes
  stay 72px high instead of stretching a single chapter to screen height.
- Stats mounts shared desktop content in the full-height right sidebar, which
  remains flush right with an 8px left reveal. Review, Agent and Library remain.

Behavioral regression tests cover paper/session affinity, draft isolation,
first-send association, deleted pointers, delayed selection, typing during
hydration, non-aborting close, and controller keyboard/Back transitions.

Validation in an isolated candidate with unrelated worktree changes excluded:
`ci:contract:check`, `public:check`, `lint`, `typecheck`, `test` and
`agent:capabilities:check` passed. Full Vitest: 2049 passed, 1 skipped;
Lint: 0 errors, 35 existing warnings.
