import {
  createDriftingToolSelectionStrategy,
  DRIFTING_DOMAIN_RUNTIME_TOOL_SEARCH_POLICY,
  type CreateDriftingToolSelectionOptions,
} from './drifting-tool-selection';
import { createDriftingWorkspaceToolSelectionStrategy } from './drifting-workspace-tool-selection';
import { DRIFTING_DOMAIN_TOOL_SEARCH_METADATA } from './tool-search-metadata';
import {
  AGENT_WORKING_MEMORY_CHECKPOINT_TOOL,
  AGENT_WORKING_MEMORY_READ_TOOL,
} from './working-memory-tool-contract';
import {
  AGENT_RUNTIME_TOOL_SEARCH_AUTO_THRESHOLD,
  type AgentRuntimeToolSearchMode,
  type AgentToolSelectionRequest,
  type AgentToolSelectionStrategy,
} from './types';

/**
 * Corpus-tested operating point of the bounded relevance selector. The runtime
 * hard cap stays much higher (`AGENT_RUNTIME_TOOL_SEARCH_LIMIT`) so repair
 * leases and always-on pins never fight the relevance budget, but relevance
 * ranking itself must run at the limit its unit tests and the P4 acceptance
 * corpus verify. At the full runtime cap the lexical ranker admits every
 * weakly-overlapping schema and the provider surface regresses toward the
 * unfiltered catalog.
 */
export const DRIFTING_PRODUCT_DYNAMIC_TOOL_SELECTION_LIMIT = 8 as const;

/**
 * Working Memory is an always-on turn lifecycle boundary, not a retrievable
 * capability: the model is instructed to checkpoint before finishing and to
 * refresh after a conflict regardless of what the author asked for. Bounded
 * selection must therefore pin both tools whenever they are executable.
 */
const ALWAYS_ON_LIFECYCLE_TOOLS = Object.freeze([
  AGENT_WORKING_MEMORY_CHECKPOINT_TOOL,
  AGENT_WORKING_MEMORY_READ_TOOL,
] as const);

export interface CreateDriftingProductToolSelectionOptions {
  /**
   * Live author preference. `off` restores the complete conservative surface
   * (every installed definition, stable across iterations); `auto`/`on` run
   * the bounded relevance selector over the author-domain workspace catalog.
   * Invalid values fail safe to `auto`.
   */
  mode?: () => AgentRuntimeToolSearchMode;
  /** Test seams forwarded to the bounded selector. */
  dynamic?: CreateDriftingToolSelectionOptions;
}

function normalizeMode(value: unknown): AgentRuntimeToolSearchMode {
  return value === 'off' || value === 'auto' || value === 'on' ? value : 'auto';
}

function withAlwaysOnLifecycleTools(
  selected: readonly string[],
  request: AgentToolSelectionRequest,
): readonly string[] {
  const executable = new Set(request.definitions.map((definition) => definition.name));
  const pinned: string[] = [];
  for (const name of ALWAYS_ON_LIFECYCLE_TOOLS) {
    if (executable.has(name) && !selected.includes(name)) pinned.push(name);
  }
  return [...pinned, ...selected].slice(0, request.limit);
}

/**
 * Production selection seam for the shipped General Agent composition.
 *
 * Guarantees preserved in every mode:
 * - `read_tool_result` is the sole surface while a paged result is pending;
 * - repair leases and the forced completion round are runtime-owned and bypass
 *   this strategy entirely, so an installed completion tool and repair targets
 *   stay callable regardless of what relevance ranking returns;
 * - Working Memory checkpoint/refresh stay pinned in bounded mode;
 * - freshness/id-dependent writes surface only together with the read that can
 *   supply their arguments (`WRITE_PREREQUISITE_READS` in the bounded
 *   selector).
 *
 * Prompt-caching note: bounded selection recomputes per model iteration, so
 * the provider tool block can change between iterations of one turn. The
 * Anthropic driver places a `cache_control` breakpoint on the last tool
 * schema and other providers cache the prefix implicitly, so bounded mode
 * trades tool-block cache reuse for the ~10k-token schema saving; `off`
 * remains the cache-stable configuration. Coarse-grained (read/write-phase)
 * selection stability that could recover both is tracked as roadmap
 * follow-up work.
 */
export function createDriftingProductToolSelectionStrategy(
  options: CreateDriftingProductToolSelectionOptions = {},
): AgentToolSelectionStrategy {
  const resolveMode = options.mode ?? ((): AgentRuntimeToolSearchMode => 'auto');
  const completeSurface = createDriftingWorkspaceToolSelectionStrategy();
  const boundedSurface = createDriftingToolSelectionStrategy({
    policy: DRIFTING_DOMAIN_RUNTIME_TOOL_SEARCH_POLICY,
    searchMetadata: DRIFTING_DOMAIN_TOOL_SEARCH_METADATA,
    ...options.dynamic,
  });

  const strategy: AgentToolSelectionStrategy = {
    select(request): readonly string[] {
      const mode = normalizeMode(resolveMode());
      if (
        mode === 'off' ||
        (mode === 'auto' &&
          request.definitions.length <= AGENT_RUNTIME_TOOL_SEARCH_AUTO_THRESHOLD)
      ) {
        return completeSurface.select(request);
      }
      const bounded = boundedSurface.select({
        ...request,
        limit: Math.min(request.limit, DRIFTING_PRODUCT_DYNAMIC_TOOL_SELECTION_LIMIT),
      });
      // Keep the deliberately narrow surfaces narrow: the pending-result-page
      // lease and the foreign-project refusal must not regain capabilities
      // through lifecycle pins.
      if (request.pendingResultPage || bounded.length === 0) {
        return bounded.slice(0, request.limit);
      }
      return withAlwaysOnLifecycleTools(bounded, request);
    },
    forceTool(): null {
      return null;
    },
  };
  return Object.freeze(strategy);
}
