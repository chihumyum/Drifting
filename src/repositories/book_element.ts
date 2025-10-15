import type { BookElement, BookElementCategory } from '../domain/book_element';

export interface BookElementRepository {
    findById(id: string): Promise<BookElement | null>;
    findAll(): Promise<BookElement[]>;
    findAllByProject(projectId: string): Promise<BookElement[]>;
    findAllByCategory(projectId: string, category: string): Promise<BookElement[]>;
    findAllByTag(projectId: string, tag: string): Promise<BookElement[]>;
    create(element: BookElement): Promise<BookElement>;
    update(id: string, element: BookElement): Promise<BookElement | null>;
    delete(id: string): Promise<boolean>;

    setElementCategory(elementId: string, categoryName: string): Promise<void>;
    getElementCategory(elementId: string): Promise<string | null>;
    updateElementCategory(elementId: string, categoryName: string): Promise<void>;

    getElementTags(elementId: string): Promise<string[]>;
    addElementTag(elementId: string, tag: string): Promise<void>;
    removeElementTag(elementId: string, tag: string): Promise<void>;
    setElementTags(elementId: string, tags: string[]): Promise<void>;

    getElementContent(elementId: string): Promise<string>;
    setElementContent(elementId: string, content: string): Promise<void>;
}

export interface BookElementCategoryRepository {
    findAll(): Promise<BookElementCategory[]>;
    findByName(name: string): Promise<BookElementCategory | null>;
    create(name: string, color?: string): Promise<BookElementCategory>;
    update(name: string, color: string): Promise<BookElementCategory | null>;
    delete(name: string): Promise<boolean>;
    ensureCategory(name: string): Promise<void>;
}
