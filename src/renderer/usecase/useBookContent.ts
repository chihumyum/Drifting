import { useCallback, useRef, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { createBookContentRepository } from '../repositories/book_content_sqlite';
import type { NodeContent } from '../domain/node-content';
import { syncManager } from '../lib/sync/sync-manager';
import { useAuthStore } from '../store/auth';
import type { SyncTaskType } from '../lib/sync/types';
import log from 'loglevel';

log.setLevel(log.levels.ERROR);

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
    const repoRef = useRef(createBookContentRepository());
    const repo = repoRef.current;
    
    const getContentByNodeId = useCallback(
        (nodeId: string) => repo.findByNodeId(nodeId),
        [repo]
    );
    
    const getContentById = useCallback(
        (id: string) => repo.findById(id),
        [repo]
    );
    
    const updateContent = useCallback(async (updates: Partial<NodeContent>) => {
        const now = new Date().toISOString();
        
        // First get existing content to retrieve projectId and nodeId
        const existing = await repo.findById(updates.id!);
        if (!existing) {
            throw new Error(`Content ${updates.id} not found`);
        }
        
        const updatedData = {
            ...updates,
            updatedAt: now,
        };

        // Use projectId and nodeId from existing content for sync
        if (canSync()) {
            enqueueContentTask('update', existing.nodeId, existing.projectId, {
                pmJson: updatedData.pmJson,
                outlineJson: updatedData.outlineJson,
            });
        }

        await repo.update(updatedData.id!, updatedData);
    }, [repo]);
    
    const createContent = useCallback(async (
        nodeId: string, 
        projectId: string, 
        content: Partial<NodeContent>
    ) => {
        const id = uuidv7();
        const now = new Date().toISOString();
        
        const newContent: Partial<NodeContent> = {
            id,
            nodeId,
            projectId,
            pmJson: content.pmJson,
            outlineJson: content.outlineJson ?? '[]',
            createdAt: now,
            updatedAt: now,
        };
        
        const created = await repo.create(newContent);

        if (canSync()) {
            enqueueContentTask('create', nodeId, projectId, {
                pmJson: created.pmJson,
                outlineJson: created.outlineJson,
            });
        }
        
        return created;
    }, [repo]);
    
    const getOutlineByNodeId = useCallback(async (nodeId: string) => {
        const content = await repo.findByNodeId(nodeId);
        return content?.outlineJson;
    }, [repo]);
    
    return useMemo(() => ({
        getContentByNodeId,
        getContentById,
        updateContent,
        createContent,
        getOutlineByNodeId,
    }), [getContentByNodeId, getContentById, updateContent, createContent, getOutlineByNodeId]);
}
