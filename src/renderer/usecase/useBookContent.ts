import { useCallback, useRef, useMemo } from 'react';

import { createBookContentRepository } from '../repositories/content-repo';
import type { NodeContent } from '../domain/node-content';
import loglevel from 'loglevel';

const log = loglevel.getLogger("UseBookContent");
log.setLevel(loglevel.levels.DEBUG);


export function useBookContent() {
    const contentRepoRef = useRef(createBookContentRepository());
    const contentRepo = contentRepoRef.current;

    const getContentByNodeId = useCallback(
        (nodeId: string) => contentRepo.findByNodeId(nodeId),
        [contentRepo]
    );

    const getContentById = useCallback(
        (id: string) => contentRepo.findById(id),
        [contentRepo]
    );

    const updateContentByNodeId = useCallback(
        async (nodeId: string, updates: Partial<NodeContent>) => {
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

            return contentRepo.update(cont.id, updatedData);
        },
        [contentRepo]
    );

    const updateContentById = useCallback(
        async (id: string, updates: Partial<NodeContent>) => {
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


            return contentRepo.update(id, updatedData);
        },
        [contentRepo]
    );


    const createContent = useCallback(async (
        nodeId: string,
        projectId: string,
        content: Partial<NodeContent>
    ) => {
        const created = await contentRepo.create({
            nodeId,
            projectId,
            contentJson: content.contentJson,
            outlineJson: content.outlineJson,
        });


        return created;
    }, [contentRepo]);

    const getOutlineByNodeId = useCallback(async (nodeId: string) => {
        const content = await contentRepo.findByNodeId(nodeId);
        return content?.outlineJson;
    }, [contentRepo]);

    return useMemo(() => ({
        getContentByNodeId,
        getContentById,
        updateContentById,
        updateContentByNodeId,
        createContent,
        getOutlineByNodeId,
    }), [getContentByNodeId, getContentById, updateContentById, updateContentByNodeId, createContent, getOutlineByNodeId]);
}
