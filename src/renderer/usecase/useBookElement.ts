import { useCallback, useRef, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { useDataStore } from '../store/data-store';
import type { BookElement } from '../domain/book-element';
import { createBookElementSqliteRepository } from '../sqlite-repo/element-repo';
import { createElementTagLinkRepository } from '../sqlite-repo/element-tag-repo';
import { initDatabase } from '../lib/db';
import { withOptimisticUpdate } from './optimistic';
import { syncElementCreate, syncElementUpdate, syncElementDelete } from './sync-helpers';

export interface CreateBookElementInput {
    categoryId: string;
}
export type UpdateElementUsecaseInput = Partial<Omit<BookElement, 'id' | 'updatedAt' | 'projectId' | 'createdAt'>>;

export interface UseBookElementContext {
    projectId: string;
    userId: string;
}

export function useBookElement({ projectId, userId }: UseBookElementContext) {
    if (!projectId) {
        throw new Error("useBookElement requires a projectId");
    }
    if (!userId) {
        throw new Error("useBookElement requires a userId");
    }
    const activeProjectId = projectId;

    const elementRepo = useMemo(() => createBookElementSqliteRepository(activeProjectId), [activeProjectId]);
    const elementTagLinkRepoRef = useRef(createElementTagLinkRepository());
    const elementTagLinkRepo = elementTagLinkRepoRef.current;
    const ensureDb = useCallback(async () => {
        await initDatabase(userId);
    }, [userId]);

    const getElements = useCallback(() => useDataStore.getState().bookElements, []);
    const setElements = useCallback((els: BookElement[]) => useDataStore.getState().setBookElements(els), []);



    const loadInitial = useCallback(async (projectId?: string) => {
        if (projectId && projectId !== activeProjectId) {
            throw new Error('Cannot load elements for different projectId');
        }
        await ensureDb();
        const elements = await elementRepo.findAll();
        const tagMap = await elementTagLinkRepo.findTagIdsByElementIds(elements.map(el => el.id));
        const hydrated = elements.map(el => ({
            ...el,
            tagIds: tagMap[el.id] ?? [],
        }));
        setElements(hydrated);
    }, [elementRepo, elementTagLinkRepo, setElements, activeProjectId, ensureDb]);

    const createElement = useCallback(async (input: CreateBookElementInput) => {
        await ensureDb();
        const prev = getElements().slice();
        const now = new Date().toISOString();
        const newElement: BookElement = {
            id: uuidv7(),
            projectId: activeProjectId,
            categoryId: input.categoryId,
            name: 'New Element',
            summary: '',
            contentJson: '{}', // TODO: fix this
            createdAt: now,
            updatedAt: now,
            tagIds: [],
            stageIds: [],
        };

        return withOptimisticUpdate({
            apply: () => setElements([newElement, ...prev]),
            rollback: () => setElements(prev),
            effect: () => elementRepo.create(newElement),
            onSuccess: (persisted) => {
                const current = getElements();
                const updated = current.map(el => el.id === persisted.id ? { ...persisted, tagIds: newElement.tagIds, stageIds: newElement.stageIds } : el);
                setElements(updated);
            },
            sync: (persisted) => syncElementCreate(persisted.id, activeProjectId, {
                id: persisted.id, categoryId: persisted.categoryId,
                name: persisted.name, summary: persisted.summary, contentJson: persisted.contentJson,
            }),
        });
    }, [elementRepo, getElements, setElements, ensureDb, activeProjectId]);

    const updateElement = useCallback(async (id: string, updates: UpdateElementUsecaseInput) => {
        await ensureDb();
        const now = new Date();
        const elements = getElements();
        const existing = elements.find(e => e.id === id);
        if (!existing) {
            throw new Error(`Element with id ${id} not found`);
        }

        const updatedElement: BookElement = {
            ...existing,
            categoryId: updates.categoryId ?? existing.categoryId,
            name: updates.name ?? existing.name,
            stageIds: updates.stageIds ?? existing.stageIds,
            contentJson: updates.contentJson ?? existing.contentJson,
            summary: updates.summary ?? existing.summary,
            updatedAt: now.toISOString(),
        };

        return withOptimisticUpdate({
            apply: () => setElements(elements.map(el => el.id === id ? updatedElement : el)),
            rollback: () => setElements(elements),
            effect: async () => {
                const persisted = await elementRepo.update(id, {
                    categoryId: updatedElement.categoryId,
                    name: updatedElement.name,
                    summary: updatedElement.summary,
                    contentJson: updatedElement.contentJson,
                    updatedAt: updatedElement.updatedAt,
                });
                if (!persisted) {
                    throw new Error(`Element with id ${id} not found`);
                }
                return persisted;
            },
            onSuccess: (persisted) => {
                const current = getElements();
                const persistedWithTags = {
                    ...persisted,
                    tagIds: updatedElement.tagIds,
                    stageIds: updatedElement.stageIds,
                };
                setElements(current.map(el => el.id === id ? persistedWithTags : el));
            },
            sync: (persisted) => syncElementUpdate(id, activeProjectId, {
                categoryId: persisted.categoryId, name: persisted.name,
                summary: persisted.summary, contentJson: persisted.contentJson,
            }),
        });
    }, [elementRepo, getElements, setElements, ensureDb, activeProjectId]);

    const removeElement = useCallback(async (id: string) => {
        await ensureDb();
        const elements = getElements();
        const existing = elements.find(e => e.id === id);
        if (!existing) throw new Error(`Element with id ${id} not found`);

        const filtered = elements.filter(e => e.id !== id);
        return withOptimisticUpdate({
            apply: () => setElements(filtered),
            rollback: () => setElements(elements),
            effect: () => elementRepo.delete(id),
            sync: () => syncElementDelete(id, activeProjectId),
        });
    }, [elementRepo, getElements, setElements, ensureDb, activeProjectId]);

    return useMemo(() => ({
        loadInitial,
        createElement,
        updateElement,
        removeElement,
    }), [loadInitial, createElement, updateElement, removeElement]);
}
