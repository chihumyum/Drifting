export interface BookElement {
  id: string;
  projectId: string;
  categoryId: string;
  name: string;
  summary: string;
  contentJson: string;
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
  descriptionJson: string;
  // TipTap doc JSON used as the starter content when a new element is created
  // under this category. `'{}'` means "no template" — element starts blank.
  // Existing elements are never touched when this changes.
  elementTemplateJson: string;
  color: string;
  // SuperElementView placement. 'auto' = skyline solver picks the slot;
  // 'pinned' = user dragged this category and gridX/gridY hold the anchor.
  layoutMode: ElementCategoryLayoutMode;
  gridX: number | null;
  gridY: number | null;
  createdAt: string;
  updatedAt: string;
}
