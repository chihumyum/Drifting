import type { useDataStore } from '../store/data-store';
import type { AutoDetectTarget, EntityKind, EntityLinkAutoDetectConfig } from './extensions/entity-link';

type Workspace = ReturnType<typeof useDataStore.getState>;
type NameInput = Pick<Workspace, 'workspaceProjectId' | 'workspaceProjectionEpoch' | 'bookElements' | 'bookNodes'>;

interface NameProjection {
  readonly projectId: string | null;
  readonly epoch: number;
  readonly signature: string;
  readonly elements: readonly { readonly id: string; readonly name: string; readonly aliases: readonly string[] }[];
  readonly nodes: readonly { readonly id: string; readonly title: string }[];
}

// Weak collection keys do not retain old prose-bearing domain records. The
// single latest projection contains only names and is released by its runtime.
let byNodes = new WeakMap<NameInput['bookNodes'], WeakMap<NameInput['bookElements'], NameProjection>>();
let latest: NameProjection | undefined;
const elementNames = new WeakMap<NameInput['bookElements'], { records: NameProjection['elements']; signature: string }>();
const nodeNames = new WeakMap<NameInput['bookNodes'], { records: NameProjection['nodes']; signature: string }>();

export function selectEntityLinkNames(state: NameInput): NameProjection {
  let byElements = byNodes.get(state.bookNodes);
  const cached = byElements?.get(state.bookElements);
  if (cached?.projectId === state.workspaceProjectId && cached.epoch === state.workspaceProjectionEpoch) {
    latest = cached;
    return cached;
  }
  let elements = elementNames.get(state.bookElements);
  if (!elements) {
    const records = state.bookElements.map(({ id, name, aliases }) => ({ id, name, aliases: [...aliases] }));
    elements = { records, signature: JSON.stringify(records) };
    elementNames.set(state.bookElements, elements);
  }
  let nodes = nodeNames.get(state.bookNodes);
  if (!nodes) {
    const records = state.bookNodes.map(({ id, title }) => ({ id, title }));
    nodes = { records, signature: JSON.stringify(records) };
    nodeNames.set(state.bookNodes, nodes);
  }
  const signature = `${elements.signature}\n${nodes.signature}`;
  const projection = latest?.projectId === state.workspaceProjectId
    && latest.epoch === state.workspaceProjectionEpoch && latest.signature === signature
    ? latest
    : { projectId: state.workspaceProjectId, epoch: state.workspaceProjectionEpoch, signature, elements: elements.records, nodes: nodes.records };
  if (!byElements) {
    byElements = new WeakMap();
    byNodes.set(state.bookNodes, byElements);
  }
  byElements.set(state.bookElements, projection);
  latest = projection;
  return projection;
}

export function releaseEntityLinkNames(projectId: string): void {
  if (latest?.projectId !== projectId) return;
  latest = undefined;
  byNodes = new WeakMap();
}

/** Exclude before resolving name collisions, preserving chapter-last priority. */
export function buildEntityAutoDetectTargets(
  names: NameProjection,
  sourceKind: EntityKind,
  sourceId: string,
  parentElementId?: string,
): Map<string, AutoDetectTarget> {
  const targets = new Map<string, AutoDetectTarget>();
  for (const element of names.elements) {
    if ((sourceKind === 'element' && element.id === sourceId) || element.id === parentElementId) continue;
    const target = { kind: 'element' as const, id: element.id };
    if (element.name) targets.set(element.name, target);
    for (const alias of element.aliases) if (alias) targets.set(alias, target);
  }
  for (const node of names.nodes) {
    if (sourceKind === 'node' && node.id === sourceId) continue;
    if (node.title) targets.set(node.title, { kind: 'node', id: node.id });
  }
  return targets;
}

/** Agent writes select their source explicitly, independent of mounted views. */
export function selectProseAutoDetectConfig(
  state: NameInput,
  enabled: boolean,
  projectId: string | null,
  sourceKind: EntityKind,
  sourceId: string,
): EntityLinkAutoDetectConfig {
  if (!enabled || !projectId || state.workspaceProjectId !== projectId) {
    return { autoDetectEnabled: false, autoDetectTargets: new Map() };
  }
  return {
    autoDetectEnabled: true,
    autoDetectTargets: buildEntityAutoDetectTargets(selectEntityLinkNames(state), sourceKind, sourceId),
  };
}
