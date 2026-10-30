import { CHAPTER_ORDER_STRIDE, isChapter, type BookNode } from '../../../domain/book-node';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import type { CreateBookElementInput } from '../../../usecase/useBookElement';
import type { CreateNodeUsecaseInput } from '../../../usecase/useBookNode';
import type { CreateElementCategoryInput } from '../../../usecase/useElementCategory';
import type { CreateStorylineInput } from '../../../usecase/useStoryline';

/** What Project Home can create, in the order its row shows them. */
export const HOME_CREATE_KINDS = [
  'chapter',
  'drift',
  'element',
  'storyline',
  'category',
  'material',
] as const;

export type HomeCreateKind = (typeof HOME_CREATE_KINDS)[number];

/**
 * Where the new thing goes: the second-level choice the author pointed at
 * (a chapter's storyline, a drift's group, an element's category). Nothing
 * is named first; the editor opens with the default name selected.
 */
export interface HomeCreatePlace {
  storylineId?: string | null;
  driftGroupId?: string | null;
  categoryId?: string | null;
}

export interface HomeCreateServices {
  createNode(input: CreateNodeUsecaseInput): Promise<{ id: string }>;
  createStoryline(input: CreateStorylineInput): Promise<{ id: string }>;
  createElement(input: CreateBookElementInput): Promise<{ id: string }>;
  createCategory(input?: CreateElementCategoryInput): Promise<{ id: string }>;
  createTextMaterial(title: string): Promise<{ id: string }>;
}

export interface HomeCreateNames {
  chapter: string;
  drift: string;
  storyline: string;
  material: string;
}

/** Creates one entity and returns where to open it. */
export async function createHomeEntity(input: {
  kind: HomeCreateKind;
  projectId: string;
  place: HomeCreatePlace;
  bookNodes: readonly BookNode[];
  names: HomeCreateNames;
  services: HomeCreateServices;
}): Promise<WorkspaceTarget> {
  const { kind, projectId, place, bookNodes, names, services } = input;
  if (kind === 'chapter') {
    const maxOrder = bookNodes
      .filter(isChapter)
      .reduce((max, node) => Math.max(max, node.bookOrder), 0);
    const created = await services.createNode({
      kind: 'chapter',
      title: names.chapter,
      bookOrder: maxOrder + CHAPTER_ORDER_STRIDE,
      mainStorylineId: place.storylineId ?? null,
    });
    return { entityType: 'node', id: created.id };
  }
  if (kind === 'drift') {
    const created = await services.createNode({
      kind: 'drift',
      title: names.drift,
      bookOrder: null,
      mainStorylineId: null,
      driftGroupId: place.driftGroupId ?? null,
    });
    return { entityType: 'node', id: created.id };
  }
  if (kind === 'element') {
    if (!place.categoryId) throw new Error('A category is required to create an element');
    const created = await services.createElement({ categoryId: place.categoryId, groupName: null });
    return { entityType: 'element', id: created.id };
  }
  if (kind === 'storyline') {
    const created = await services.createStoryline({ projectId, name: names.storyline });
    return { entityType: 'storyline', id: created.id };
  }
  if (kind === 'material') {
    const created = await services.createTextMaterial(names.material);
    return { entityType: 'library_item', id: created.id };
  }
  const created = await services.createCategory();
  return { entityType: 'category', id: created.id };
}

/** One create at a time: a second click while the first is writing is ignored. */
export function createSubmissionGate() {
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
