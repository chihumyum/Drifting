import { useCallback, useRef, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { v7 as uuidv7 } from 'uuid';
import { useDataStore } from '../store/data-store';
import type { BookElement } from '../domain/book-element';
import { createBookElementSqliteRepository } from '../sqlite-repo/element-repo';
import { createElementTagLinkRepository } from '../sqlite-repo/element-tag-repo';
import loglevel from "loglevel";

const log = loglevel.getLogger("UseBookElement");
log.setLevel(loglevel.levels.WARN);

export interface CreateBookElementInput {
    categoryId: string;
}
export type UpdateElementUsecaseInput = Partial<Omit<BookElement, 'id' | 'updatedAt' | 'projectId' | 'createdAt'>>;

export function useBookElement() {
    // Use route projectId - this is the ONLY source of truth for projectId
    const { projectId: routeProjectId } = useParams<{ projectId: string }>();
    if (!routeProjectId) {
        throw new Error("useBookElement must be used within a project route");
    }
    const activeProjectId = routeProjectId;

    const elementRepo = useMemo(() => createBookElementSqliteRepository(activeProjectId), [activeProjectId]);
    const elementTagLinkRepoRef = useRef(createElementTagLinkRepository());
    const elementTagLinkRepo = elementTagLinkRepoRef.current;

    const getElements = useCallback(() => useDataStore.getState().bookElements, []);
    const setElements = useCallback((els: BookElement[]) => useDataStore.getState().setBookElements(els), []);



    const loadInitial = useCallback(async (projectId?: string) => {
        if (projectId && projectId !== activeProjectId) {
            throw new Error('Cannot load elements for different projectId');
        }
        const elements = await elementRepo.findAll();
        const tagMap = await elementTagLinkRepo.findTagIdsByElementIds(elements.map(el => el.id));
        const hydrated = elements.map(el => ({
            ...el,
            tagIds: tagMap[el.id] ?? [],
        }));
        setElements(hydrated);
    }, [elementRepo, elementTagLinkRepo, setElements, activeProjectId]);

    const createElement = useCallback(async (input: CreateBookElementInput) => {
        const persisted = await elementRepo.create({
            id: uuidv7(),
            projectId: activeProjectId,
            categoryId: input.categoryId,
            name: 'New Element',
            summary: '',
            contentJson: '{}', // TODO: fix this 
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
        const prev = getElements();
        setElements([persisted, ...prev]);

        return persisted;
    }, [elementRepo, getElements, setElements]);

    const updateElement = useCallback(async (id: string, updates: UpdateElementUsecaseInput) => {
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

        setElements(elements.map(el => el.id === id ? updatedElement : el));

        const persisted = await elementRepo.update(id, {
            categoryId: updatedElement.categoryId,
            name: updatedElement.name,
            summary: updatedElement.summary,
            contentJson: updatedElement.contentJson,
            updatedAt: updatedElement.updatedAt,
        });

        if (persisted) {
            const current = getElements();
            const persistedWithTags = {
                ...persisted,
                tagIds: updatedElement.tagIds,
                stageIds: updatedElement.stageIds,
            };
            setElements(current.map(el => el.id === id ? persistedWithTags : el));
            return persistedWithTags;
        } else {
            log.warn(`Failed to persist update for element with id ${id}`);
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
        removeElement,
    }), [loadInitial, createElement, updateElement, removeElement]);
}
