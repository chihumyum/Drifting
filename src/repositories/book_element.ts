// translate entity between domain and schema

import type { ElementCategoryRecord, ElementRecord } from "../schema/book_element";

export interface BookElementRepository {
    findById(id: string): Promise<ElementRecord | null>;
    findAll(): Promise<ElementRecord[]>;
    findAllByProject(projectId: string): Promise<ElementRecord[]>;
    findAllByCategory(projectId: string, category: string): Promise<ElementRecord[]>;
    findAllByTag(projectId: string, tag: string): Promise<ElementRecord[]>;
    create(data: Partial<ElementRecord>): Promise<ElementRecord>;
    update(id: string, data: Partial<ElementRecord>): Promise<ElementRecord | null>;
    delete(id: string): Promise<boolean>;

    setElementCategory(entityId: string, categoryId: string): Promise<void>;
    getElementCategory(entityId: string): Promise<string | null>;
    updateElementCategory(entityId: string, categoryId: string): Promise<void>;

    getElementTags(entityId: string): Promise<string[]>;
    addElementTag(entityId: string, tag: string): Promise<void>;
    removeElementTag(entityId: string, tag: string): Promise<void>;
    setElementTags(entityId: string, tags: string[]): Promise<void>;

    getElementContent(entityId: string): Promise<string>;
    setElementContent(entityId: string, content: string): Promise<void>;

    // multi-stage entity implement later
}

export interface BookElementCategoryRepository {
    findAll(): Promise<string[]>;
    findByName(name: string): Promise<ElementCategoryRecord | null>;
    create(name: string, color?: string): Promise<ElementCategoryRecord>;
    update(name: string, color: string): Promise<ElementCategoryRecord | null>;
    delete(name: string): Promise<boolean>;
    ensureCategory(name: string): Promise<void>;
}