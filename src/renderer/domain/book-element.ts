export interface BookElement {
  id: string;
  projectId: string;
  // Nullable since the trash refactor: elements with categoryId === null are
  // in the "未分类" bucket (rendered last in SuperElementView).
  categoryId: string | null;
  name: string;
  summary: string;
  contentJson: string;
  // Element's own KV facts. Seeded at creation from the parent category's
  // elementTemplateKvJson and owned thereafter. JSON-stringified
  // Array<{ key, value }> — see domain/kv.ts.
  kvJson: string;
  /**
   * Alternate names this entity is referred to by ("Lady Mira", "M.",
   * "the heir"). DB column `aliases_json` is JSON-encoded; domain surfaces
   * the decoded array. Order is preserved.
   *
   * Uniqueness invariant: across one project, the union of every element's
   * name + aliases is unique case-insensitively. Enforced in
   * useBookElement create/update; violations throw ElementNameConflictError.
   * Same name set drives auto-linking, mention dedup, and copilot dedup.
   */
  aliases: string[];
  // Lightweight secondary grouping label within a category. Null = "ungrouped".
  // See schema/drizzle.ts for rationale.
  groupName: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Decode the `aliases_json` SQLite column into a clean string[]. Trims
 * each entry and drops empties. Returns [] on parse failure (defensive).
 */
export function decodeAliases(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

export function encodeAliases(aliases: string[] | null | undefined): string {
  if (!aliases || aliases.length === 0) return '[]';
  const cleaned = aliases.map((s) => s.trim()).filter((s) => s.length > 0);
  return JSON.stringify(cleaned);
}

/**
 * Every name this element answers to — its canonical `name` plus all
 * aliases, trimmed and deduplicated. Used by lookups (auto-link, mention
 * dedup, copilot context) that need "all the ways this entity can be
 * referred to".
 */
export function allElementNames(element: BookElement): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of [element.name, ...element.aliases]) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Thrown by useBookElement when a create/update would introduce a
 * duplicate (case-insensitive) name or alias within the same project.
 * Carries the offender so the UI can surface a clear conflict message.
 */
export class ElementNameConflictError extends Error {
  constructor(
    public readonly conflictingName: string,
    public readonly conflictingElement: BookElement,
  ) {
    super(
      `Name "${conflictingName}" already used by element "${conflictingElement.name}" ` +
        `(${conflictingElement.id}). Names and aliases must be unique within a project.`,
    );
    this.name = 'ElementNameConflictError';
  }
}

/**
 * Find a case-insensitive collision between `candidateNames` and any
 * existing element's name + aliases in the project. Optionally exclude
 * one element id (the element being updated). Returns the first conflict
 * found, or null if all candidates are free.
 */
export function findElementNameConflict(
  candidateNames: string[],
  existingElements: BookElement[],
  projectId: string,
  excludeElementId?: string,
): { conflictingName: string; conflictingElement: BookElement } | null {
  const candidateSet = new Set(
    candidateNames.map((n) => n.trim().toLowerCase()).filter((n) => n.length > 0),
  );
  if (candidateSet.size === 0) return null;
  for (const el of existingElements) {
    if (el.projectId !== projectId) continue;
    if (excludeElementId && el.id === excludeElementId) continue;
    for (const name of allElementNames(el)) {
      if (candidateSet.has(name.toLowerCase())) {
        return { conflictingName: name, conflictingElement: el };
      }
    }
  }
  return null;
}

/**
 * Produce a project-unique element name from `baseName` by appending an
 * incrementing suffix (" 2", " 3", …) until it no longer collides with any
 * existing element's name or alias. Used for the auto-created placeholder
 * ("New Element") so the "+ element" button never throws an
 * ElementNameConflictError just because a prior un-renamed placeholder is
 * still around. An explicit user-supplied name is NOT auto-numbered — that
 * path keeps throwing so the conflict surfaces to the user.
 */
export function makeUniqueElementName(
  baseName: string,
  existingElements: BookElement[],
  projectId: string,
): string {
  const base = baseName.trim() || 'New Element';
  if (!findElementNameConflict([base], existingElements, projectId)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!findElementNameConflict([candidate], existingElements, projectId)) {
      return candidate;
    }
  }
}

export type ElementCategoryLayoutMode = 'auto' | 'pinned';

export interface BookElementCategory {
  id: string;
  projectId: string;
  name: string;
  // Body editor's TipTap JSON. Renamed from descriptionJson (migration 0029).
  contentJson: string;
  // TipTap doc JSON used as the starter content when a new element is created
  // under this category. `'{}'` means "no template" — element starts blank.
  // Existing elements are never touched when this changes.
  elementTemplateJson: string;
  // KV template seeded into a new element's kvJson at creation. Same shape
  // as the entity's own KV — see domain/kv.ts. Edits only affect future
  // elements; existing element KV is untouched.
  elementTemplateKvJson: string;
  color: string;
  // SuperElementView placement. 'auto' = skyline solver picks the slot;
  // 'pinned' = user dragged this category and gridX/gridY hold the anchor.
  layoutMode: ElementCategoryLayoutMode;
  gridX: number | null;
  gridY: number | null;
  createdAt: string;
  updatedAt: string;
}
