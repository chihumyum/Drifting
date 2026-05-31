// Domain model for a book project
// AKA a book

export interface Project {
  id: string;
  userId: string;
  name: string;
  summary: string;
  // Project's own KV facts (book goal / writing style / reference works / …).
  // JSON-stringified Array<{ key: string; value: string }> — see domain/kv.ts.
  kvJson: string;
  // KV template seeded into every new storyline under this project.
  // Same shape as kvJson; editing only affects future storylines.
  storylineTemplateKvJson: string;
  createdAt: string;
  updatedAt: string;
}
