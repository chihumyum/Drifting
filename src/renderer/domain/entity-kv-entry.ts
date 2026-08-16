export const ENTITY_KV_OWNER_KINDS = [
  'project',
  'storyline',
  'element-category',
  'element',
] as const;

export type EntityKvOwnerKind = (typeof ENTITY_KV_OWNER_KINDS)[number];

export const ENTITY_KV_NAMESPACES = [
  'facts',
  'storyline-template',
  'element-template',
] as const;

export type EntityKvNamespace = (typeof ENTITY_KV_NAMESPACES)[number];

export interface EntityKvOwner {
  readonly projectId: string;
  readonly ownerKind: EntityKvOwnerKind;
  readonly ownerId: string;
  readonly namespace: EntityKvNamespace;
}

export interface EntityKvEntry extends EntityKvOwner {
  readonly id: string;
  readonly key: string;
  readonly value: string;
}

export function assertEntityKvOwner(owner: EntityKvOwner): void {
  const allowed =
    (owner.ownerKind === 'project' &&
      (owner.namespace === 'facts' || owner.namespace === 'storyline-template')) ||
    (owner.ownerKind === 'storyline' && owner.namespace === 'facts') ||
    (owner.ownerKind === 'element-category' && owner.namespace === 'element-template') ||
    (owner.ownerKind === 'element' && owner.namespace === 'facts');
  if (!allowed) {
    throw new TypeError(
      `Unsupported KV authority owner ${owner.ownerKind}:${owner.namespace}`,
    );
  }
  if (!owner.projectId || !owner.ownerId) {
    throw new TypeError('KV authority requires projectId and ownerId');
  }
}

/** Opaque, deterministic scope stored by the kv-entry order register. */
export function entityKvOrderScope(owner: EntityKvOwner): string {
  assertEntityKvOwner(owner);
  return JSON.stringify([owner.ownerKind, owner.ownerId, owner.namespace]);
}
