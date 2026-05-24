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
  // Lightweight secondary grouping label within a category. Null = "ungrouped".
  // See schema/drizzle.ts for rationale.
  groupName: string | null;
  createdAt: string;
  updatedAt: string;
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
