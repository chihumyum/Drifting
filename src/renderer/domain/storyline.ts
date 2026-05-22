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
