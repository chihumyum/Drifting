import { v7 as uuidv7 } from 'uuid';
import type { BookContentRepository } from "../repositories/book_content";
import type { BookContent } from "../domain/book_content";
import { syncManager } from '../lib/sync/sync-manager';
import { useAuthStore } from '../store/auth';
import type { SyncTaskType } from '../lib/sync/types';
import log from 'loglevel';
log.setLevel(log.levels.ERROR);

export {
    loadBookContent,
    updateBookContent,
    newBookContent,
}

export interface BookContentUsecaseDeps {
    contentRepo: BookContentRepository;

    getContentState: () => BookContent | null;
    setContentState: (content: BookContent | null) => void;
    updateContentState: (updates: Partial<BookContent>) => void;
    getProjectIdForNodeId: (nodeId: string) => string | null;
    now?: () => Date;
}
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
            // If parsing fails, still send string; backend will ignore/overwrite if it can't use it.
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





async function loadBookContent(deps: BookContentUsecaseDeps, nodeId: string) {
    const content = await deps.contentRepo.findByNodeId(nodeId);
    deps.setContentState(content);
    // console.log('Loaded content for nodeId', nodeId, ':', content);
}

async function updateBookContent(deps: BookContentUsecaseDeps, updates: Partial<BookContent>) {
    const now = (deps.now ?? (() => new Date()))();
    const updatedData = {
        ...updates,
        updatedAt: now.toISOString(),
    };
    deps.updateContentState(updatedData);

    const nodeId = updatedData.nodeId ?? deps.getContentState()?.nodeId;
    if (nodeId) {
        const projectId = deps.getProjectIdForNodeId(nodeId);
        if (projectId) {
            enqueueContentTask('update', nodeId, projectId, {
                pmJson: updatedData.pmJson,
                outlineJson: updatedData.outlineJson,
            });
        }
    }

    await deps.contentRepo.update(updatedData.id!, updatedData);
}

async function newBookContent(deps: BookContentUsecaseDeps, nodeId: string, pmJson: string) {
    const id = uuidv7();
    const now = (deps.now ?? (() => new Date()))();
    const newContent: Partial<BookContent> = {
        id,
        nodeId,
        pmJson: pmJson,
        outlineJson: '[]',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
    };
    const created = await deps.contentRepo.create(newContent);
    deps.setContentState(created);

    const projectId = deps.getProjectIdForNodeId(nodeId);
    if (projectId) {
        enqueueContentTask('create', nodeId, projectId, {
            pmJson: created.pmJson,
            outlineJson: created.outlineJson,
        });
    }
    return created;
}


