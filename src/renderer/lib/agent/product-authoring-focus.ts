import { useDataStore } from '../../store/data-store';
import { focusedLeafOf, isSingletonTabType, tabKey, useUiStore } from '../../store/ui-store';
import {
  editorTabSelectionKey,
  getEditorSelectionSnapshot,
} from '../../lib/editor-selection-memory';
import {
  buildAgentWritingTurnContext,
  type AgentAuthoringFocus,
  type AgentKnownAuthoringTarget,
  type AgentWritingTurnContext,
} from './runtime/writing-intelligence';

function pathSegment(value: string): string {
  const cleaned = value.trim() || '(untitled)';
  return cleaned.replaceAll('%', '%25').replaceAll('/', '%2F').replaceAll('\\', '%5C');
}

/** Resolve the author-visible editor pane into the canonical workspace entity. */
export function getActiveAgentAuthoringFocus(projectId: string): AgentAuthoringFocus | null {
  const projectTabs = useUiStore.getState().tabsByProject[projectId];
  if (!projectTabs?.activeTabKey) return null;
  const activeTab = projectTabs.openTabs.find(
    (candidate) => tabKey(candidate) === projectTabs.activeTabKey,
  );
  if (!activeTab) return null;
  const leaf = focusedLeafOf(activeTab);
  if (isSingletonTabType(leaf.entityType)) return null;

  const data = useDataStore.getState();
  let entity: AgentAuthoringFocus['entity'] | null = null;
  if (leaf.entityType === 'node') {
    const node = data.bookNodes.find(
      (candidate) => candidate.id === leaf.id && candidate.projectId === projectId,
    );
    if (node) {
      entity = {
        kind: node.kind,
        id: node.id,
        name: node.title,
        path: `/${node.kind === 'chapter' ? 'chapters' : 'drifts'}/${pathSegment(node.title)}/prose.md`,
      };
    }
  } else if (leaf.entityType === 'element') {
    const element = data.bookElements.find(
      (candidate) => candidate.id === leaf.id && candidate.projectId === projectId,
    );
    if (element) {
      const categoryName = element.categoryId
        ? (data.bookElementCategories.find(
            (candidate) => candidate.id === element.categoryId && candidate.projectId === projectId,
          )?.name ?? '未分类')
        : '未分类';
      entity = {
        kind: 'element',
        id: element.id,
        name: element.name,
        path: `/elements/${pathSegment(categoryName)}/${pathSegment(element.name)}/body.md`,
      };
    }
  } else if (leaf.entityType === 'storyline') {
    const storyline = data.storylines.find(
      (candidate) => candidate.id === leaf.id && candidate.projectId === projectId,
    );
    if (storyline) {
      entity = {
        kind: 'storyline',
        id: storyline.id,
        name: storyline.name,
        path: `/storylines/${pathSegment(storyline.name)}/body.md`,
      };
    }
  } else if (leaf.entityType === 'category') {
    const category = data.bookElementCategories.find(
      (candidate) => candidate.id === leaf.id && candidate.projectId === projectId,
    );
    if (category) {
      entity = {
        kind: 'category',
        id: category.id,
        name: category.name,
        path: `/categories/${pathSegment(category.name)}/body.md`,
      };
    }
  }
  if (!entity) return null;

  const selection = getEditorSelectionSnapshot(editorTabSelectionKey(projectId, leaf));
  return {
    projectId,
    entity,
    mode: selection?.mode ?? 'entity',
    selectedText: selection?.selectedText ?? '',
    selectedBlocks: selection?.selectedBlocks ?? [],
    contextBefore: selection?.contextBefore ?? [],
    contextAfter: selection?.contextAfter ?? [],
  };
}

/** Build the immutable product-derived writing contract before a turn starts. */
export function buildProductAgentWritingContext(
  projectId: string,
  authorPrompt: string,
): AgentWritingTurnContext {
  const data = useDataStore.getState();
  const categories = data.bookElementCategories.filter(
    (category) => category.projectId === projectId,
  );
  const knownTargets: AgentKnownAuthoringTarget[] = [
    ...data.bookNodes
      .filter((node) => node.projectId === projectId)
      .map((node) => ({
        entity: {
          kind: node.kind,
          id: node.id,
          name: node.title,
          path: `/${node.kind === 'chapter' ? 'chapters' : 'drifts'}/${pathSegment(node.title)}/prose.md`,
        },
        terms: [node.title],
      })),
    ...data.bookElements
      .filter((element) => element.projectId === projectId)
      .map((element) => {
        const categoryName = element.categoryId
          ? (categories.find((category) => category.id === element.categoryId)?.name ?? '未分类')
          : '未分类';
        return {
          entity: {
            kind: 'element' as const,
            id: element.id,
            name: element.name,
            path: `/elements/${pathSegment(categoryName)}/${pathSegment(element.name)}/body.md`,
          },
          terms: [element.name, ...element.aliases],
        };
      }),
    ...data.storylines
      .filter((storyline) => storyline.projectId === projectId)
      .map((storyline) => ({
        entity: {
          kind: 'storyline' as const,
          id: storyline.id,
          name: storyline.name,
          path: `/storylines/${pathSegment(storyline.name)}/body.md`,
        },
        terms: [storyline.name],
      })),
    ...categories.map((category) => ({
      entity: {
        kind: 'category' as const,
        id: category.id,
        name: category.name,
        path: `/categories/${pathSegment(category.name)}/body.md`,
      },
      terms: [category.name],
    })),
  ];
  const canonTerms = [
    ...data.bookNodes.filter((node) => node.projectId === projectId).map((node) => node.title),
    ...data.bookElements
      .filter((element) => element.projectId === projectId)
      .flatMap((element) => [element.name, ...element.aliases]),
    ...data.storylines
      .filter((storyline) => storyline.projectId === projectId)
      .map((storyline) => storyline.name),
    ...categories.map((category) => category.name),
  ];
  return buildAgentWritingTurnContext(
    authorPrompt,
    getActiveAgentAuthoringFocus(projectId),
    canonTerms,
    knownTargets,
  );
}
