export const RELATION_TYPE_PALETTE = [
  'hsl(var(--story-1))',
  'hsl(var(--story-2))',
  'hsl(var(--story-3))',
  'hsl(var(--story-4))',
  'hsl(var(--story-5))',
  'hsl(var(--story-6))',
  'hsl(var(--ink-3))',
];

/** Keep a relation type's fallback color stable across every Super View. */
export function defaultRelationTypeColor(relationTypeId: string): string {
  let hash = 5381;
  for (let index = 0; index < relationTypeId.length; index += 1) {
    hash = ((hash << 5) + hash) ^ relationTypeId.charCodeAt(index);
  }
  return RELATION_TYPE_PALETTE[Math.abs(hash) % RELATION_TYPE_PALETTE.length];
}
