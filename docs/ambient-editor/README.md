# Shadow Ambient Editor

Status: **target design frozen; implementation not started**

Updated: 2026-08-11

Shadow Ambient Editor is the approved target design for project-wide,
asynchronous editorial awareness in Drifting. It replaces neither the author
nor Canon, does not restore the retired Shadow CI product, and is not a shipped
capability yet.

The product promise is:

> Copilot stays close to the cursor. Shadow keeps reading the whole book while
> the author is away, then returns a small number of evidence-backed editorial
> observations without grading, blocking, or changing the manuscript.

## Read this set in order

1. [`product-vision.md`](product-vision.md) defines the final product promise,
   ideal author experience, interaction model, and explicit non-goals.
2. [`technical-architecture.md`](technical-architecture.md) is the normative
   target architecture: authority boundaries, modules, schemas, protocols,
   runtime profile, synchronization, and failure behavior.
3. [`delivery-and-acceptance.md`](delivery-and-acceptance.md) defines the
   progressive delivery sequence, per-phase exit gates, and final acceptance
   matrix.

If these documents disagree, authority is ordered as follows:

1. `technical-architecture.md` for data, runtime, security, and consistency;
2. `product-vision.md` for product behavior and author experience;
3. `delivery-and-acceptance.md` for sequencing and evidence requirements;
4. this index for navigation and concise status only.

Current shipped behavior remains defined by
[`../agent-runtime/acceptance/CURRENT_STATUS.md`](../agent-runtime/acceptance/CURRENT_STATUS.md)
and the generated capability inventory. This design does not override either.

## Vocabulary

| Term | Meaning | Authority |
| --- | --- | --- |
| **Prose** | The manuscript as it currently exists in live Yjs documents. | Authored source of truth |
| **Canon** | Author-owned project facts, elements, relationships, and sanctioned `element_patch` evolution. | Authored truth |
| **Editorial Lens** | An author-defined way of reading: what deserves attention, over what scope, and in what tone. | Author-owned evaluation policy |
| **World Model** | A versioned, evidence-backed, rebuildable projection of what the manuscript currently says happened. | Derived, never authoritative |
| **Narrative Claim** | A typed proposition about an event, state, knowledge, relationship, location, possession, setup, payoff, or timeline. | Derived World Model unit |
| **Narrative Span Digest** | A hierarchical, source-hashed reading of block-section, chapter, act/storyline, and book spans. | Derived World Model unit |
| **Semantic Delta** | The semantic difference between two valid source projections. | Derived invalidation input |
| **Review Debt** | Durable eligibility to revisit a Lens/scope after relevant change. It is not evidence of a problem. | Local operational state |
| **Concern** | An evidence-backed editorial observation or question maintained across re-evaluation. It is not an error or verdict. | First-class product object |
| **Precedent** | An author-confirmed instruction about how future equivalent Concerns should be treated. | Author-owned evaluation memory |

## Product and implementation boundaries

- The UI may call the capability **Shadow**. Code, schema, and protocol use the
  `ambient-editor` / `ambient` namespace.
- Shadow is a subsystem composed on the shared renderer-owned Agent Runtime,
  provider drivers, secure BYOK storage, context planning, and cancellation. It
  is not a second provider loop, sidecar, remote runner, or restored Shadow
  runtime.
- Shadow uses a dedicated read-only runtime profile and a terminal structured
  reconciliation action. It never inherits the General Agent write surface.
- World Model, Review Debt, and run receipts are local and rebuildable. Lenses,
  Concerns, decisions, and confirmed Precedents are author-visible synced
  domain objects.
- Concern owns editorial identity and lifecycle. Comment/TODO may reuse the
  shared anchor and presentation system, but cannot own Concern truth.
- Shadow never changes prose, Canon, `element_patch`, chapter status, or author
  decisions. Any General Agent execution requires a separate explicit author
  action.
- “Works while I am away” initially means while the app process remains alive.
  Suspend, renderer restart, or app exit preserves Review Debt but does not
  preserve or replay an in-flight provider request.
- No pass/fail, severity gate, force-pass, chapter gate, score, or CI-style
  completion percentage may be derived from this design.

## Current versus target state

| Area | Current shipped state | Target state |
| --- | --- | --- |
| Shadow product | Retired Shadow CI has no runtime or UI | Ambient editorial awareness |
| Whole-book background review | General Agent can perform explicit long tasks | Relevant reading is scheduled from Review Debt during idle windows |
| World Model | No Ambient World Model | Typed Claims plus hierarchical Span Digests |
| Editorial output | General Agent chat/review and unified comments | Stable, evidence-backed Concern Inbox |
| Author feedback | General Agent memory and review decisions | Exact dismissal plus author-confirmed editorial Precedents |
| Copilot handoff | Mounted-editor local context | Shared projection inputs and concise open-Concern context |
| After app exit | No resumable provider stack | Debt resumes later; provider work restarts from a fresh checked snapshot |

## Machine-checked design markers

These markers are intentionally narrow. They prove that the checked-in design
set is complete and does not misreport shipping state; they do not prove an
implementation.

- `design_status: frozen`
- `shipping_status: not_implemented`
- `product_namespace: ambient-editor`
- `runtime_composition: shared_agent_runtime_read_only_profile`
- `prose_authority: live_yjs`
- `world_model_authority: rebuildable_projection`
- `concern_authority: first_class_domain_object`
- `application_exit_background_guarantee: none`
- `old_shadow_ci_restored: false`

The contract is checked by
`src/renderer/lib/agent/runtime/acceptance/ambient-editor-design.acceptance.test.ts`.
Implementation phases must replace design-only evidence with production and
behavioral evidence without deleting the retired-product guard.
