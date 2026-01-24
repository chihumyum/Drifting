import { useCallback, useRef, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { v7 as uuidv7 } from 'uuid';
import { useDataStore } from '../store/data-store';
import type { BookElement, BookElementCategory } from '../domain/book-element';
import { createBookElementSqliteRepository, createCategorySqliteRepository } from '../repositories/element-repo';
import { useAuthStore } from '../store/auth';

export interface CreateBookElementInput {
    categoryId: string;
}

export function useBookElement() {
    const { projectId: routeProjectId } = useParams<{ projectId: string }>();
    // Use route projectId - this is the ONLY source of truth for projectId
    const activeProjectId = routeProjectId;

    // Use useMemo ensuring repository is recreated if projectId changes
    const elementRepo = useMemo(() => createBookElementSqliteRepository(activeProjectId), [activeProjectId]);
    // Also recreate category repo when Project ID changes, so invariants are scoped correctly
    const categoryRepo = useMemo(() => createCategorySqliteRepository(activeProjectId), [activeProjectId]);

    const getElements = useCallback(() => useDataStore.getState().bookElements, []);
    const setElements = useCallback((els: BookElement[]) => useDataStore.getState().setBookElements(els), []);
    const getCategories = useCallback(() => useDataStore.getState().bookElementCategories, []);
    const setCategories = useCallback((cats: BookElementCategory[]) => useDataStore.getState().setBookElementCategories(cats), []);


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
        const persisted = await elementRepo.create({
            projectId: activeProjectId,
            categoryId: input.categoryId,
            name: input.name,
            tagIds: input.tagIds,
            stageIds: input.stageIds,
            summary: input.summary,
            contentJson: input.contentJson,
        });

        const prev = getElements();
        setElements([persisted, ...prev]);

        return persisted;
    }, [elementRepo, getElements, setElements]);

    const updateElement = useCallback(async (id: string, updates: Partial<CreateBookElementInput>) => {
        const now = new Date();
        const elements = getElements();
        const existing = elements.find(e => e.id === id);
        if (!existing) throw new Error(`Element with id ${id} not found`);

        const updatedElement: BookElement = {
            ...existing,
            categoryId: updates.categoryId ?? existing.categoryId,
            name: updates.name ?? existing.name,
            tagIds: updates.tagIds ?? existing.tagIds,
            stageIds: updates.stageIds ?? existing.stageIds,
            contentJson: updates.contentJson ?? existing.contentJson,
            summary: updates.summary ?? existing.summary,
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
    }, [elementRepo, getElements, setElements]);

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
        deleteCategory,
        removeElement,
    }), [loadInitial, createElement, updateElement, removeElement, deleteCategory]);
}
