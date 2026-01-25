// Storyline Domain Model
// each book contains multiple storylines in parallel

export interface Storyline {
  id: string;
  projectId: string;
  name: string;
  color: string;
  summary: string;
  orderKey: number;
  descriptionJson: string;
  createdAt: string;
  updatedAt: string;
}
