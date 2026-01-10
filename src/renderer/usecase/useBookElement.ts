import { useCallback, useRef, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { v7 as uuidv7 } from 'uuid';
import { useDataStore } from '../store/data-store';
import type { BookElement, BookElementCategory } from '../domain/book-element';
import { createBookElementSqliteRepository, createCategorySqliteRepository } from '../repositories/book_element_sqlite';
import { useAuthStore, getProjectId } from '../store/auth';

const getProjectIdForUser = () => {
    const user = useAuthStore.getState().user;
    return getProjectId(user?.id);
};

export interface CreateBookElementInput {
    category: string;
    name: string;
    tags?: string[];
    content_json?: string;
    summary_json?: string;
}

export function useBookElement() {
    const { projectId: routeProjectId } = useParams<{ projectId: string }>();
    const activeProjectId = routeProjectId ?? getProjectIdForUser();

    // Use useMemo ensuring repository is recreated if projectId changes
    const elementRepo = useMemo(() => createBookElementSqliteRepository(activeProjectId), [activeProjectId]);
    const categoryRepoRef = useRef(createCategorySqliteRepository());
    const categoryRepo = categoryRepoRef.current;

    const getElements = useCallback(() => useDataStore.getState().bookElements, []);
    const setElements = useCallback((els: BookElement[]) => useDataStore.getState().setBookElements(els), []);
    const getCategories = useCallback(() => useDataStore.getState().bookElementCategories, []);
    const setCategories = useCallback((cats: BookElementCategory[]) => useDataStore.getState().setBookElementCategories(cats), []);

    const ensureCategory = useCallback(async (categoryName: string): Promise<BookElementCategory> => {
        const categories = getCategories();
        let existing = categories.find(c => c.name === categoryName);
        if (existing) return existing;

        const newCat: BookElementCategory = {
            id: uuidv7(),
            name: categoryName,
            descriptionJson: JSON.stringify({ description: '' }),
            color: '#CCCCCC'
        };
        setCategories([...categories, newCat]);
        await categoryRepo.ensureCategory(categoryName);
        return newCat;
    }, [categoryRepo, getCategories, setCategories]);

    const deleteCategory = useCallback(async (name: string) => {
        await categoryRepo.delete(name);
        const cats = await categoryRepo.findAll();
        setCategories(cats);
    }, [categoryRepo, setCategories]);

    const loadInitial = useCallback(async (projectId?: string) => {
        const pid = projectId ?? activeProjectId;
        const elements = await elementRepo.findAllByProject(pid);
        setElements(elements);
        const categories = await categoryRepo.findAll();
        setCategories(categories);
    }, [elementRepo, categoryRepo, setElements, setCategories, activeProjectId]);

    const createElement = useCallback(async (input: CreateBookElementInput) => {
        // Ensure category exists before creating element (though repo handles it too, maybe duplicate but safer for UI state?)
        // Actually repo's ensureCategoryId handles it. 
        // But we need the category object to update local state optimistically?
        // The previous code did optimistic update manually.
        const category = await ensureCategory(input.category);

        // We can't do full optimistic update without ID.
        // But we can wait for repo return.

        const persisted = await elementRepo.create({
            projectId: activeProjectId,
            categoryName: input.category,
            name: input.name,
            tagIds: input.tags,
            contentJson: input.content_json,
            summary: input.summary_json,
        });

        const prev = getElements();
        setElements([persisted, ...prev]);

        return persisted;
    }, [elementRepo, ensureCategory, getElements, setElements]);

    const updateElement = useCallback(async (id: string, updates: Partial<CreateBookElementInput>) => {
        const now = new Date();
        const elements = getElements();
        const existing = elements.find(e => e.id === id);
        if (!existing) throw new Error(`Element with id ${id} not found`);

        let categoryName = existing.categoryId;
        if (updates.category) {
            const category = await ensureCategory(updates.category);
            categoryName = category.name;
        }

        const updatedElement: BookElement = {
            ...existing,
            categoryId: categoryName,
            name: updates.name ?? existing.name,
            tagIds: updates.tags ?? existing.tagIds,
            contentJson: updates.content_json ?? existing.contentJson,
            summary: updates.summary_json ?? existing.summary,
            updatedAt: now.toISOString(),
        };

        setElements(elements.map(el => el.id === id ? updatedElement : el));

        const persisted = await elementRepo.update(id, updatedElement);
        if (persisted) {
            const current = getElements();
            setElements(current.map(el => el.id === id ? persisted : el));
            return persisted;
        }

        return updatedElement;
    }, [elementRepo, ensureCategory, getElements, setElements]);

    const removeElement = useCallback(async (id: string) => {
        const elements = getElements();
        const existing = elements.find(e => e.id === id);
        if (!existing) throw new Error(`Element with id ${id} not found`);

        const filtered = elements.filter(e => e.id !== id);
        setElements(filtered);

        await elementRepo.delete(id);
        return true;
    }, [elementRepo, getElements, setElements]);

    return useMemo(() => ({
        loadInitial,
        createElement,
        updateElement,
        createCategory: ensureCategory,
        deleteCategory,
        removeElement,
    }), [loadInitial, createElement, updateElement, removeElement, ensureCategory, deleteCategory]);
}
