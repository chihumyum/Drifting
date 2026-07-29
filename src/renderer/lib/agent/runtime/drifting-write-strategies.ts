import type {
  PersistedAgentRuntimeWriteEffect,
  AgentRuntimeWriteReversibility,
} from '../../../domain/agent-runtime-write-effect';
import { useDataStore } from '../../../store/data-store';
import type {
  AgentToolContext,
} from '../tool-handlers';
import { throwIfAgentAborted } from './errors';
import type {
  AgentToolExecutionRequest,
} from './types';

export interface PreparedDriftingWriteEffect {
  observedRevision: unknown;
  preimage: unknown;
  forward: unknown;
  inverse: unknown | null;
  reversibility: AgentRuntimeWriteReversibility;
}

export interface DriftingWriteStrategy {
  prepare(
    request: AgentToolExecutionRequest,
    context: AgentToolContext,
  ): Promise<PreparedDriftingWriteEffect>;
  captureEffect(
    request: AgentToolExecutionRequest,
    context: AgentToolContext,
    result: unknown,
    prepared: PreparedDriftingWriteEffect,
  ): Promise<unknown>;
  applyInverse(
    effect: PersistedAgentRuntimeWriteEffect,
    context: AgentToolContext,
    signal: AbortSignal,
  ): Promise<unknown>;
}

const nodeFieldStrategies = new Map<string, 'title' | 'summary'>([
  ['rename_node', 'title'],
  ['set_node_summary', 'summary'],
]);

/**
 * P3 initially certifies the two node-field writes whose inverse is exact and
 * uses the same renderer usecases as a manual edit. Destructive, relationship,
 * creation, memory, and prose writes stay unavailable until their own strategy
 * can prove an exact or explicitly compensating inverse.
 */
export function getDriftingWriteStrategy(
  toolName: string,
): DriftingWriteStrategy | undefined {
  const field = nodeFieldStrategies.get(toolName);
  if (!field) return undefined;
  return nodeFieldStrategy(field);
}

function nodeFieldStrategy(field: 'title' | 'summary'): DriftingWriteStrategy {
  return {
    async prepare(request) {
      throwIfAgentAborted(request.signal);
      const node = resolveProjectNode(request);
      const next = requiredString(
        request.arguments[field === 'title' ? 'title' : 'summary'],
        `${request.name} requires ${field}`,
        field === 'summary',
      );
      const previous = node[field];
      return {
        observedRevision: nodeRevision(node),
        preimage: {
          kind: 'node_field',
          nodeId: node.id,
          field,
          value: previous,
        },
        forward: {
          kind: 'node_field',
          nodeId: node.id,
          field,
          value: next,
        },
        inverse: {
          kind: 'node_field',
          nodeId: node.id,
          field,
          value: previous,
        },
        reversibility: 'exact',
      };
    },

    async captureEffect(request, _context, result, prepared) {
      const target = parseNodeFieldPayload(prepared.forward, field);
      const node = useDataStore
        .getState()
        .bookNodes.find(
          (candidate) =>
            candidate.id === target.nodeId &&
            candidate.projectId === request.context.route.projectId,
        );
      if (!node) throw new Error('The written node disappeared before receipt');
      return {
        kind: 'node_field',
        nodeId: node.id,
        field,
        value: node[field],
        revision: nodeRevision(node),
        handlerResult: result,
      };
    },

    async applyInverse(effect, context, signal) {
      throwIfAgentAborted(signal);
      const inverse = parseNodeFieldPayload(effect.inverse, field);
      const forward = parseNodeFieldPayload(effect.effect, field);
      const current = useDataStore
        .getState()
        .bookNodes.find(
          (node) =>
            node.id === inverse.nodeId &&
            node.projectId === effect.projectId,
        );
      if (!current) {
        throw new Error('The node for this Agent review no longer exists');
      }
      // A process can die after the exact inverse usecase commits but before
      // the review row advances from revert_started to reverted. Re-entering
      // review settlement must recognize that durable postimage instead of
      // applying the inverse twice or misclassifying a successful revert as a
      // conflict.
      if (current[field] === inverse.value) {
        return {
          kind: 'node_field_revert',
          nodeId: inverse.nodeId,
          field,
          value: inverse.value,
          revision: nodeRevision(current),
          reconciled: true,
        };
      }
      // Reject must not erase a newer manual edit. Exact inversion is available
      // only while the field still equals the effect this review represents.
      if (current[field] !== forward.value) {
        throw new Error(
          `The node ${field} changed after the Agent write; exact revert is unavailable`,
        );
      }
      const guard = { expectedRevision: current.updatedAt };
      if (field === 'title') {
        await context.write.renameNode(inverse.nodeId, inverse.value, guard);
      } else {
        await context.write.updateNode(
          inverse.nodeId,
          { summary: inverse.value },
          guard,
        );
      }
      throwIfAgentAborted(signal);
      const reverted = useDataStore
        .getState()
        .bookNodes.find((node) => node.id === inverse.nodeId);
      if (!reverted || reverted[field] !== inverse.value) {
        throw new Error(`The node ${field} inverse did not settle exactly`);
      }
      return {
        kind: 'node_field_revert',
        nodeId: inverse.nodeId,
        field,
        value: inverse.value,
        revision: nodeRevision(reverted),
      };
    },
  };
}

function resolveProjectNode(request: AgentToolExecutionRequest) {
  const projectId = request.context.route.projectId;
  const ref = String(
    request.arguments.node ?? request.arguments.nodeId ?? '',
  ).trim();
  if (!projectId || !ref) {
    throw new Error(`${request.name} requires a project-scoped node`);
  }
  const candidates = useDataStore
    .getState()
    .bookNodes.filter((node) => node.projectId === projectId);
  const direct = candidates.find((node) => node.id === ref);
  if (direct) return direct;
  const normalized = ref.toLocaleLowerCase();
  const matches = candidates.filter(
    (node) => node.title.trim().toLocaleLowerCase() === normalized,
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `No node named "${ref}" exists in this project`
        : `Node reference "${ref}" is ambiguous`,
    );
  }
  return matches[0];
}

function requiredString(
  value: unknown,
  message: string,
  allowEmpty: boolean,
): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new Error(message);
  }
  return value;
}

function nodeRevision(node: { id: string; updatedAt: string }) {
  return {
    kind: 'entity_revision',
    entityKind: 'node',
    entityId: node.id,
    updatedAt: node.updatedAt,
  };
}

function parseNodeFieldPayload(
  value: unknown,
  expectedField: 'title' | 'summary',
): { nodeId: string; field: 'title' | 'summary'; value: string } {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { kind?: unknown }).kind !== 'node_field' ||
    typeof (value as { nodeId?: unknown }).nodeId !== 'string' ||
    (value as { field?: unknown }).field !== expectedField ||
    typeof (value as { value?: unknown }).value !== 'string'
  ) {
    throw new Error('The persisted Agent inverse is invalid');
  }
  return value as {
    nodeId: string;
    field: 'title' | 'summary';
    value: string;
  };
}
