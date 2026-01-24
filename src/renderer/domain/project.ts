// Domain model for a book project
// AKA a book

export interface Project {
  id: string;
  userId: string;
  name: string;
  descriptionJson: string;
  createdAt: string;
  updatedAt: string;
}
