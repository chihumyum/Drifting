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
  color: string;
  createdAt: string;
  updatedAt: string;
}
