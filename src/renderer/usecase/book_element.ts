// operation related to book elements (like character, location, item, etc.)
import type { BookElement, BookElementCategory } from '../domain/book-element';
import { v7 as uuidv7 } from 'uuid';
import type { BookElementRepository, BookElementCategoryRepository } from '../repositories/book_element';

export interface BookElementUsecaseDeps {
    elementRepo: BookElementRepository;
    categoryRepo: BookElementCategoryRepository;
    // state adapters - pass in from a hook so we don't call hooks here
    getElements: () => BookElement[];
    setElements: (elements: BookElement[]) => void;
    getCategories: () => BookElementCategory[];
    setCategories: (categories: BookElementCategory[]) => void;
    now?: () => Date;
}

export interface CreateBookElementInput {
    category: string; // category name (not id yet)
    name: string;
    tags?: string[];
    content_json?: string;
    summary_json?: string;
}


export async function loadInitialBookElements(deps: BookElementUsecaseDeps, projectId: string) {
    const elements = await deps.elementRepo.findAllByProject(projectId);
    deps.setElements(elements);
    const categories = await deps.categoryRepo.findAll();
    deps.setCategories(categories);
}



export async function createBookElement(deps: BookElementUsecaseDeps, input: CreateBookElementInput) {
    const now = (deps.now ?? (() => new Date()))();
    const category = await ensureCategory(deps, input.category);

    const newElement: BookElement = {
        id: uuidv7(),
        category: category.name, // store by name for now (could swap to id later)
        name: input.name,
        tags: input.tags ?? [],
        content_json: input.content_json ?? JSON.stringify({}),
        summary_json: input.summary_json ?? JSON.stringify({}),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        stages: [],
    };

    const prev = deps.getElements();
    deps.setElements([...prev, newElement]);

    const persisted = await deps.elementRepo.create(newElement);

    const current = deps.getElements();
    deps.setElements(current.map(el => el.id === newElement.id ? persisted : el));
    // TODO: rollback strategy & sync with server
    return persisted;
}

export async function updateBookElement(deps: BookElementUsecaseDeps, id: string, updates: Partial<CreateBookElementInput>) {
    const now = (deps.now ?? (() => new Date()))();
    const elements = deps.getElements();
    const existing = elements.find(e => e.id === id);
    if (!existing) throw new Error(`Element with id ${id} not found`);

    let categoryName = existing.category;
    if (updates.category) {
        const category = await ensureCategory(deps, updates.category);
        categoryName = category.name;
    }

    const updatedElement: BookElement = {
        ...existing,
        category: categoryName,
        name: updates.name ?? existing.name,
        tags: updates.tags ?? existing.tags,
        content_json: updates.content_json ?? existing.content_json,
        summary_json: updates.summary_json ?? existing.summary_json,
        updatedAt: now.toISOString(),
    };

    deps.setElements(elements.map(el => el.id === id ? updatedElement : el));

    const persisted = await deps.elementRepo.update(id, updatedElement);
    if (persisted) {
        const current = deps.getElements();
        deps.setElements(current.map(el => el.id === id ? persisted : el));
        return persisted;
    }

    return updatedElement;
}

export async function deleteBookElement(deps: BookElementUsecaseDeps, id: string) {
    const elements = deps.getElements();
    const existing = elements.find(e => e.id === id);
    if (!existing) throw new Error(`Element with id ${id} not found`);

    const filtered = elements.filter(e => e.id !== id);
    deps.setElements(filtered);

    await deps.elementRepo.delete(id);

    return true;
}

async function ensureCategory(deps: BookElementUsecaseDeps, categoryName: string): Promise<BookElementCategory> {
    const categories = deps.getCategories();
    let existing = categories.find(c => c.name === categoryName);
    if (existing) return existing;

    // create in memory
    const newCat: BookElementCategory = {
        id: uuidv7(),
        name: categoryName,
        description_json: JSON.stringify({ description: '' }),
        color: '#CCCCCC'
    };
    deps.setCategories([...categories, newCat]);
    // persist (ignore race condition for now – could add upsert or unique constraint handling)
    await deps.categoryRepo.ensureCategory(categoryName);
    existing = newCat;
    return existing;
}

