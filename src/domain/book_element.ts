import type { ElementRecord } from '../schema/book_element'

export interface BookElement {
  id: string;
  category: string;
  name: string;
  tags: string[];
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface BookElementCategory {
  id: string;
  name: string;
  color?: string;
}