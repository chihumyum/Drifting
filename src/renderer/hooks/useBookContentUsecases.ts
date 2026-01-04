import { useMemo, useRef } from "react";
import { useAppStore } from "../store";
import { createBookContentRepository } from "../repositories/book_content_sqlite";
import type { BookContentUsecaseDeps } from "../usecase/book_content";
import {
    loadBookContent,
    updateBookContent,
    newBookContent,
} from "../usecase/book_content";
import type { BookContent } from "../domain/book_content";

// const PROJECT_ID = 'default-project';


export function useBookContentUsecases() {
    const store = useAppStore;
    const depsRef = useRef<BookContentUsecaseDeps | null>(null);

    // bind state related ops here, so usecase functions could use
    // them along with repo ops
    if (!depsRef.current) {
        depsRef.current = {
            contentRepo: createBookContentRepository(),
            getContentState: () => store.getState().bookContent,
            setContentState: (content) => store.getState().setBookContent(content),
            updateContentState: (updates) => store.getState().updateBookContent(updates),
                        getProjectIdForNodeId: (nodeId: string) => {
                            const node = store.getState().bookNodes.find((n) => n.id === nodeId);
                            return node?.projectId ?? null;
                        },
            now: () => new Date(),
        };
    }
    const deps = depsRef.current!;
    return useMemo(() => ({
        loadContent: async (nodeId: string) => {
            return loadBookContent(deps, nodeId);
        },
        updateContent: async (updates: Partial<BookContent>) => {
            return updateBookContent(deps, updates);
        },
        newContent: async (nodeId: string, pmJson: string) => {
            return newBookContent(deps, nodeId, pmJson);
        },
    }), [deps]);

}