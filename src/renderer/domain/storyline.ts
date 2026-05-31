// Storyline Domain Model
// each book contains multiple storylines in parallel

export interface Storyline {
  id: string;
  projectId: string;
  name: string;
  color: string;
  summary: string;
  orderKey: number;
  // The TipTap body editor's serialized JSON. Renamed from descriptionJson
  // (which was a misnomer — the column holds the editor body, not a short
  // description). See migration 0029.
  contentJson: string;
  // Storyline's own KV facts. Seeded at creation from the parent project's
  // storylineTemplateKvJson and owned thereafter. JSON-stringified
  // Array<{ key, value }> — see domain/kv.ts.
  kvJson: string;
  // TipTap doc JSON seeded into a new node's content under this storyline.
  // '{}' = no template (new node starts blank). Edits only affect future nodes.
  nodeContentTemplateJson: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A project-unique storyline name so the writing agent can address a storyline
 * by name instead of its uuid. Case-insensitive; appends " 2", " 3", … until
 * free. `excludeId` is the storyline being renamed. Empty → "New Storyline".
 */
export function makeUniqueStorylineName(
  baseName: string,
  existing: Storyline[],
  projectId: string,
  excludeId?: string,
): string {
  const base = (baseName ?? '').trim() || 'New Storyline';
  const taken = new Set(
    existing
      .filter((s) => s.projectId === projectId && s.id !== excludeId)
      .map((s) => s.name.trim().toLowerCase()),
  );
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
