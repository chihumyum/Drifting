// Agent memory: a small, evolving store of author-level guidance that BOTH the
// General agent and the Shadow review engine read as auxiliary context. It is
// NOT canon (the story world — that's elements/facts/patches) and NOT project
// facts (the structured governing KV — POV / 文风 / 字数). It holds the standing,
// cross-cutting meta: personal writing preferences, vetoed proposals, and
// standing directives ("don't evaluate the plausibility of dream chapters").
//
// Anchored, block-local guidance ("THIS passage is intentional") lives in a
// `comment` (source='manual', kind='exception') instead — the anchor is the
// relevance. Memory is for the un-anchored / standing kind.
import type { StructuralEntityKind } from './entity-kinds';

// preference — author-personal style / working preference
// veto       — a rejected proposal ("don't propose killing X again")
// directive  — a standing instruction about how to treat content
// Reserved: 'episode' (session/episodic recall) is deferred — do NOT emit it yet.
export type AgentMemoryKind = 'preference' | 'veto' | 'directive';

// pending   — proposed by an agent, awaiting the author's soft-approval. NEVER
//             injected into a prompt while pending (the trust invariant).
// active    — confirmed; the ONLY status that enters agent/judge context.
// dismissed — rejected, or retired because a newer memory superseded it.
export type AgentMemoryStatus = 'pending' | 'active' | 'dismissed';

// Who authored the memory. 'author' = the user stated it directly; 'agent' =
// the General agent proposed it from a conversation (still gated by approval).
export type AgentMemorySource = 'author' | 'agent';

export interface AgentMemory {
  id: string;
  projectId: string;
  kind: AgentMemoryKind;
  /** The memory text — one atomic fact/instruction, plain text. */
  body: string;
  /** Optional anchor to a structural entity (veto/directive often point at one);
   *  null for a standing, un-anchored memory. Block granularity via targetBlockId. */
  targetKind: StructuralEntityKind | null;
  targetId: string | null;
  targetBlockId: string | null;
  source: AgentMemorySource;
  /** The conversation / finding id this memory was captured from (provenance). */
  originRef: string | null;
  status: AgentMemoryStatus;
  /** The id of the older memory this one replaces, when the author evolves a
   *  memory rather than adding a duplicate. The superseded row goes 'dismissed'. */
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Soft-delete marker — null while live. Kept for provenance after delete. */
  deletedAt: string | null;
}
