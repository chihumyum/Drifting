import type { TSchema } from '@sinclair/typebox';

/**
 * The audience that owns a tool contract.
 *
 * `scope` is deliberately separate from `access`: an internal Shadow write must
 * never become a General Agent write merely because both have `access: write`.
 */
export type AgentToolScope =
  | 'general'
  | 'shadow-internal'
  | 'runtime-virtual';

export type AgentToolAccess = 'read' | 'write';

export type AgentToolRisk =
  | 'none'
  | 'low'
  | 'medium'
  | 'high'
  | 'critical';

export type AgentToolEffect =
  | 'none'
  | 'prose'
  | 'canon'
  | 'graph'
  | 'annotation'
  | 'memory'
  | 'review'
  | 'destructive'
  | 'external';

export type AgentToolConcurrency =
  | 'parallel'
  | 'exclusive_entity'
  | 'exclusive_project';

export type AgentToolApproval =
  | 'automatic'
  | 'review_after'
  | 'confirm_before';

export type AgentToolRetry = 'safe' | 'never' | 'inspect_before_retry';

/**
 * How a completed write can be undone after the runtime has proved that it
 * committed. `unavailable` means the product has not implemented a trustworthy
 * revert path yet; it is not permission to synthesize an inverse.
 */
export type AgentToolRevertStrategy =
  | 'not_applicable'
  | 'exact_inverse'
  | 'compensating'
  | 'irreversible'
  | 'unavailable';

export type AgentToolCertification =
  | 'unavailable'
  | 'protocol-conformant'
  | 'read-certified'
  | 'write-certified'
  | 'internal-certified';

export interface RegisteredTool {
  /** Canonical provider-facing name. Deprecated dispatcher names are aliases. */
  readonly name: string;
  readonly version: number;
  readonly description: string;
  readonly parametersSchema: TSchema;
  readonly scope: AgentToolScope;
  readonly access: AgentToolAccess;
  readonly risk: AgentToolRisk;
  readonly effect: AgentToolEffect;
  readonly concurrency: AgentToolConcurrency;
  readonly approval: AgentToolApproval;
  readonly retry: AgentToolRetry;
  readonly revertStrategy: AgentToolRevertStrategy;
  /**
   * Kept for the P1 API. It is derived from `revertStrategy` when the catalog is
   * built and must not be treated as a second policy source.
   */
  readonly reversible: boolean;
  readonly resultBudgetChars: number;
  readonly certification: AgentToolCertification;
  readonly certificationNote: string;
  /** Search/display synonyms. They are never emitted as duplicate schemas. */
  readonly aliases: readonly string[];
  /**
   * Legacy names that `runAgentTool` still dispatches. They inherit this entry's
   * policy and are never sent to a provider as separate tool definitions.
   */
  readonly handlerAliases: readonly string[];
}

/**
 * Provider exposure is an explicit capability intersection. A policy can only
 * narrow the canonical catalog; it cannot turn an unavailable tool into a
 * certified one.
 */
export interface AgentProviderToolPolicy {
  scopes: readonly AgentToolScope[];
  accesses: readonly AgentToolAccess[];
  certifications: readonly AgentToolCertification[];
  allowNames?: readonly string[];
  denyNames?: readonly string[];
}
