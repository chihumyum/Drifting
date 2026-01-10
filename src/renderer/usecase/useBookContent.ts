import { useCallback, useRef, useMemo } from 'react';

import { createBookContentRepository } from '../repositories/book_content_sqlite';
import type { NodeContent } from '../domain/node-content';
import { syncManager } from '../lib/sync/sync-manager';
import { useAuthStore } from '../store/auth';
import type { SyncTaskType } from '../lib/sync/types';
import loglevel from 'loglevel';

const log = loglevel.getLogger("UseBookContent");
log.setLevel(loglevel.levels.DEBUG);

const canSync = () => {
    const { isAuthenticated } = useAuthStore.getState();
    return isAuthenticated;
};

const enqueueContentTask = (
    type: SyncTaskType,
    nodeId: string,
    projectId: string,
    data: { pmJson?: string; outlineJson?: string },
) => {
    if (!canSync()) {
        log.warn('User is not authenticated, cannot sync content');
        return;
    }

    let pmJson: unknown = undefined;
    if (data.pmJson !== undefined) {
        try {
            pmJson = JSON.parse(data.pmJson);
        } catch {
            pmJson = data.pmJson;
        }
    }

    syncManager.enqueue({
        type,
        entity: 'content',
        localId: nodeId,
        projectId,
        data: {
            ...(pmJson !== undefined ? { pmJson } : {}),
            ...(data.outlineJson !== undefined ? { outline: data.outlineJson } : {}),
        },
        priority: 'normal',
    });
};

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

            // Use projectId and nodeId from existing content for sync
            if (canSync()) {
                enqueueContentTask('update', cont.nodeId, cont.projectId, {
                    pmJson: updatedData.contentJson,
                    outlineJson: updatedData.outlineJson,
                });
            }

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

            // Use projectId and nodeId from existing content for sync
            if (canSync()) {
                enqueueContentTask('update', cont.nodeId, cont.projectId, {
                    pmJson: updatedData.contentJson,
                    outlineJson: updatedData.outlineJson,
                });
            }

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

        if (canSync()) {
            enqueueContentTask('create', nodeId, projectId, {
                pmJson: created.contentJson,
                outlineJson: created.outlineJson,
            });
        }

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
