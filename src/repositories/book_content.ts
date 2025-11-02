import type { BookContent } from '../domain/book_content';


export interface BookContentRepository {
  findById(id: string): Promise<BookContent | null>;
  findByNodeId(nodeId: string): Promise<BookContent | null>;
  create(data: Partial<BookContent>): Promise<BookContent>;
  update(contentId: string, data: Partial<BookContent>): Promise<BookContent | null>;
  updateByNodeId(nodeId: string, data: Partial<BookContent>): Promise<BookContent | null>;
  delete(id: string): Promise<boolean>;
  deleteByNodeId(nodeId: string): Promise<boolean>;
}
