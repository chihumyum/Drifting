import { v7 as uuidv7 } from 'uuid';
import type { BookContentRepository } from "../repositories/book_content";
import type { BookContent } from "../domain/book_content";

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
    now?: () => Date;
}




async function loadBookContent(deps: BookContentUsecaseDeps, nodeId: string) {
    const content = await deps.contentRepo.findByNodeId(nodeId);
    deps.setContentState(content);
}

async function updateBookContent(deps: BookContentUsecaseDeps, updates: Partial<BookContent>) {
    const now = (deps.now ?? (() => new Date()))();
    const updatedData = {
        ...updates,
        updatedAt: now.toString(),
    };
    deps.updateContentState(updatedData);
    deps.contentRepo.update(updatedData.id!, updatedData);
}

async function newBookContent(deps: BookContentUsecaseDeps, nodeId: string, pmJson: string) {
    const id = uuidv7();
    const now = (deps.now ?? (() => new Date()))();
    const newContent: Partial<BookContent> = {
        id,
        nodeId,
        pmJson: pmJson,
        createdAt: now.toString(),
        updatedAt: now.toString(),
    };
    const created = await deps.contentRepo.create(newContent);
    deps.setContentState(created);
    return created;
}


