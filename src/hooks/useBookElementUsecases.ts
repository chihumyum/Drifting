import { useCallback, useRef, useMemo } from 'react';
import { useAppStore } from '../store';
import { createBookElement, updateBookElement, deleteBookElement, loadInitialBookElements, type CreateBookElementInput, type BookElementUsecaseDeps } from '../usecase/book_element';
import { createBookElementSqliteRepository, createCategorySqliteRepository } from '../repositories/book_element_sqlite';

const PROJECT_ID = 'default-project';

export function useBookElementUsecases() {
    const storeApi = useAppStore;
    const depsRef = useRef<BookElementUsecaseDeps | undefined>(undefined);

    if (!depsRef.current) {
        depsRef.current = {
            elementRepo: createBookElementSqliteRepository(PROJECT_ID),
            categoryRepo: createCategorySqliteRepository(),
            getElements: () => storeApi.getState().bookElements,
            setElements: (els) => storeApi.getState().setBookElements(els),
            getCategories: () => storeApi.getState().bookElementCategories,
            setCategories: (cats) => storeApi.getState().setBookElementCategories(cats),
            now: () => new Date(),
        };
    }

    const deps = depsRef.current;
    const loadInitial = useCallback(() => loadInitialBookElements(deps, PROJECT_ID), [deps]);
    const createElement = useCallback((input: CreateBookElementInput) => createBookElement(deps, input), [deps]);
    const updateElement = useCallback((id: string, updates: Partial<CreateBookElementInput>) => updateBookElement(deps, id, updates), [deps]);
    const removeElement = useCallback((id: string) => deleteBookElement(deps, id), [deps]);
    return useMemo(() => ({
        loadInitial,
        createElement,
        updateElement,
        removeElement,
        // expose raw deps if advanced usage is needed
        _deps: deps,
    }), [loadInitial, createElement, updateElement, removeElement, deps]);
}
