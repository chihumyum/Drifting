import { useCallback, useRef } from 'react';
import { useAppStore } from '../store';
import { createBookElement, updateBookElement, deleteBookElement, loadInitialBookElements, type CreateBookElementInput, type BookElementUsecaseDeps } from '../usecase/book_element';
import { createBookElementSqliteRepository, createCategorySqliteRepository } from '../repositories/book_element_sqlite';

const PROJECT_ID = 'default-project';

export function useBookElementUsecases() {
    const storeApi = useAppStore; // we use .getState() below to avoid re-renders
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
    const loadInitialElementsAndCategories = useCallback(() => loadInitialBookElements(deps, PROJECT_ID), [deps]);

    return {
        loadInitial: loadInitialElementsAndCategories,
        createElement: (input: CreateBookElementInput) => createBookElement(deps, input),
        updateElement: (id: string, updates: Partial<CreateBookElementInput>) => updateBookElement(deps, id, updates),
        removeElement: (id: string) => deleteBookElement(deps, id),
        // expose raw deps if advanced usage is needed
        _deps: deps,
    };
}
