import { useCallback, useRef, useMemo } from 'react';
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
    const elementRepoRef = useRef(createBookElementSqliteRepository(getProjectIdForUser()));
    const categoryRepoRef = useRef(createCategorySqliteRepository());
    
    const elementRepo = elementRepoRef.current;
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
            pm_json: JSON.stringify({ description: '' }),
            color: '#CCCCCC'
        };
        setCategories([...categories, newCat]);
        await categoryRepo.ensureCategory(categoryName);
        return newCat;
    }, [categoryRepo, getCategories, setCategories]);

    const loadInitial = useCallback(async (projectId?: string) => {
        const pid = projectId ?? getProjectIdForUser();
        const elements = await elementRepo.findAllByProject(pid);
        setElements(elements);
        const categories = await categoryRepo.findAll();
        setCategories(categories);
    }, [elementRepo, categoryRepo, setElements, setCategories]);

    const createElement = useCallback(async (input: CreateBookElementInput) => {
        const now = new Date();
        const category = await ensureCategory(input.category);

        const newElement: BookElement = {
            id: uuidv7(),
            category: category.name,
            name: input.name,
            tags: input.tags ?? [],
            content_json: input.content_json ?? JSON.stringify({}),
            summary_json: input.summary_json ?? JSON.stringify({}),
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            stages: [],
        };

        const prev = getElements();
        setElements([...prev, newElement]);

        const persisted = await elementRepo.create(newElement);

        const current = getElements();
        setElements(current.map(el => el.id === newElement.id ? persisted : el));
        return persisted;
    }, [elementRepo, ensureCategory, getElements, setElements]);

    const updateElement = useCallback(async (id: string, updates: Partial<CreateBookElementInput>) => {
        const now = new Date();
        const elements = getElements();
        const existing = elements.find(e => e.id === id);
        if (!existing) throw new Error(`Element with id ${id} not found`);

        let categoryName = existing.category;
        if (updates.category) {
            const category = await ensureCategory(updates.category);
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
        removeElement,
    }), [loadInitial, createElement, updateElement, removeElement]);
}
