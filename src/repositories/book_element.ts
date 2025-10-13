// translate book element between domain and schema

import type { BookElement, BookElementCategory } from "../domain/book_element";
import type { ElementCategoryRecord, ElementRecord } from "../schema/book_element";

export interface BookElementRepository {
    findById(id: string): Promise<ElementRecord | null>;
    findAll(): Promise<ElementRecord[]>;
    findAllByProject(projectId: string): Promise<ElementRecord[]>;
    findAllByCategory(projectId: string, category: string): Promise<ElementRecord[]>;
    findAllByTag(projectId: string, tag: string): Promise<ElementRecord[]>;
    create(data: Partial<BookElement>): Promise<ElementRecord>;
    update(id: string, data: Partial<BookElement>): Promise<ElementRecord | null>;
    delete(id: string): Promise<boolean>;

    ensureCategory(name: BookElementCategory): Promise<void>;
    setElementCategory(elementId: string, categoryId: string): Promise<void>;
    getElementCategory(elementId: string): Promise<string | null>;
    updateElementCategory(elementId: string, categoryId: string): Promise<void>;

    getElementTags(elementId: string): Promise<string[]>;
    addElementTag(elementId: string, tag: string): Promise<void>;
    removeElementTag(elementId: string, tag: string): Promise<void>;
    setElementTags(elementId: string, tags: string[]): Promise<void>;

    getElementContent(elementId: string): Promise<string>;
    setElementContent(elementId: string, content: string): Promise<void>;

    // multi-stage element implement later
}

export interface BookElementCategoryRepository {
    findAll(): Promise<string[]>;
    findByName(name: string): Promise<ElementCategoryRecord | null>;
    create(name: string, color?: string): Promise<ElementCategoryRecord>;
    update(name: string, color: string): Promise<ElementCategoryRecord | null>;
    delete(name: string): Promise<boolean>;
    ensureCategory(name: string): Promise<void>;
}