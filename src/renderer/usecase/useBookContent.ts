import { useCallback, useRef, useMemo } from 'react';

import { createBookContentRepository } from '../sqlite-repo/content-repo';
import type { NodeContent } from '../domain/node-content';
import { initDatabase } from '../lib/db';


export interface UseBookContentContext {
    userId: string;
}

export function useBookContent({ userId }: UseBookContentContext) {
    if (!userId) {
        throw new Error('useBookContent requires a userId');
    }
    const contentRepoRef = useRef(createBookContentRepository());
    const contentRepo = contentRepoRef.current;
    const ensureDb = useCallback(async () => {
        await initDatabase(userId);
    }, [userId]);

    const getContentByNodeId = useCallback(
        async (nodeId: string) => {
            await ensureDb();
            return contentRepo.findByNodeId(nodeId);
        },
        [contentRepo, ensureDb]
    );

    const getContentById = useCallback(
        async (id: string) => {
            await ensureDb();
            return contentRepo.findById(id);
        },
        [contentRepo, ensureDb]
    );

    const updateContentByNodeId = useCallback(
        async (nodeId: string, updates: Partial<NodeContent>) => {
            await ensureDb();
            const cont = await contentRepo.findByNodeId(nodeId);
            if (!cont) {
                throw new Error(`Content with nodeId: ${nodeId} not found`);
            }
            const now = new Date().toISOString();
            const updatedData = {
                ...cont,
                ...updates,
                updatedAt: now,
            };

            return contentRepo.update(cont.nodeId, updatedData);
        },
        [contentRepo, ensureDb]
    );

    const updateContentById = useCallback(
        async (id: string, updates: Partial<NodeContent>) => {
            await ensureDb();
            const cont = await contentRepo.findById(id);
            if (!cont) {
                throw new Error(`Content with id: ${id} not found`);
            }
            const now = new Date().toISOString();
            const updatedData = {
                ...cont,
                ...updates,
                updatedAt: now,
            };


            return contentRepo.update(cont.nodeId, updatedData);
        },
        [contentRepo, ensureDb]
    );


    const createContent = useCallback(async (
        nodeId: string,
        content: Partial<NodeContent>
    ) => {
        await ensureDb();
        const created = await contentRepo.create({
            nodeId,
            contentJson: content.contentJson,
            outlineJson: content.outlineJson,
        });


        return created;
    }, [contentRepo, ensureDb]);

    const getOutlineByNodeId = useCallback(async (nodeId: string) => {
        await ensureDb();
        const content = await contentRepo.findByNodeId(nodeId);
        return content?.outlineJson;
    }, [contentRepo, ensureDb]);

    return useMemo(() => ({
        getContentByNodeId,
        getContentById,
        updateContentById,
        updateContentByNodeId,
        createContent,
        getOutlineByNodeId,
    }), [getContentByNodeId, getContentById, updateContentById, updateContentByNodeId, createContent, getOutlineByNodeId]);
}
