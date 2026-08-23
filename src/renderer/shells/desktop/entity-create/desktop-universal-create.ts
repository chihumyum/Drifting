import { CHAPTER_ORDER_STRIDE, isChapter, type BookNode } from '../../../domain/book-node';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import type {
  CreateTabDraft,
  UniversalCreateEntityKind,
} from '../../../store/ui-store';
import type { CreateBookElementInput } from '../../../usecase/useBookElement';
import type { CreateNodeUsecaseInput } from '../../../usecase/useBookNode';
import type { CreateElementCategoryInput } from '../../../usecase/useElementCategory';
import type { CreateStorylineInput } from '../../../usecase/useStoryline';

export interface UniversalCreateServices {
  createNode(input: CreateNodeUsecaseInput): Promise<{ id: string }>;
  createStoryline(input: CreateStorylineInput): Promise<{ id: string }>;
  createElement(input: CreateBookElementInput): Promise<{ id: string }>;
  createCategory(input?: CreateElementCategoryInput): Promise<{ id: string }>;
}

export async function createUniversalEntity(input: {
  kind: UniversalCreateEntityKind;
  projectId: string;
  draft: CreateTabDraft;
  bookNodes: BookNode[];
  services: UniversalCreateServices;
}): Promise<WorkspaceTarget> {
  const { kind, projectId, draft, bookNodes, services } = input;
  if (kind === 'chapter') {
    const maxOrder = bookNodes
      .filter(isChapter)
      .reduce((max, node) => Math.max(max, node.bookOrder), 0);
    const created = await services.createNode({
      kind: 'chapter',
      title: 'New Chapter',
      bookOrder: maxOrder + CHAPTER_ORDER_STRIDE,
      mainStorylineId: draft.storylineId,
    });
    return { entityType: 'node', id: created.id };
  }
  if (kind === 'drift') {
    const created = await services.createNode({
      kind: 'drift',
      title: 'New Drift',
      bookOrder: null,
      mainStorylineId: null,
      driftGroupId: draft.driftGroupId,
    });
    return { entityType: 'node', id: created.id };
  }
  if (kind === 'element') {
    if (!draft.categoryId) throw new Error('A category is required to create an element');
    const created = await services.createElement({
      categoryId: draft.categoryId,
      groupName: draft.elementGroupName,
    });
    return { entityType: 'element', id: created.id };
  }
  if (kind === 'storyline') {
    const created = await services.createStoryline({ projectId, name: 'New Storyline' });
    return { entityType: 'storyline', id: created.id };
  }
  const created = await services.createCategory();
  return { entityType: 'category', id: created.id };
}

export function createUniversalSubmissionGate() {
  let running = false;
  return {
    async run<T>(task: () => Promise<T>): Promise<{ started: false } | { started: true; value: T }> {
      if (running) return { started: false };
      running = true;
      try {
        return { started: true, value: await task() };
      } finally {
        running = false;
      }
    },
  };
}
