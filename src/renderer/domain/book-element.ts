export interface BookElement {
  id: string;
  projectId: string;
  categoryId: string;
  name: string;
  summary: string;
  contentJson: string;
  createdAt: string;
  updatedAt: string;
}

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
  createdAt: string;
  updatedAt: string;
}
