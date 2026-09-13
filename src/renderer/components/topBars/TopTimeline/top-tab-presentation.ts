import type { useDataStore } from '../../../store/data-store';
import type { AnyTab, LeafTab } from '../../../store/ui-store';
import { indexById } from '../../../lib/immutable-id-index';

type Workspace = ReturnType<typeof useDataStore.getState>;
type Input = Pick<Workspace, 'workspaceProjectId' | 'workspaceProjectionGeneration' | 'bookNodes' |
  'storylines' | 'bookElements' | 'bookElementCategories' | 'primaryStorylineByNode'>;
type Fallback = 'chapter' | 'drift' | 'storyline' | 'element' | 'category' | 'all-chapters';
export interface TabLabel { title: string; fallback: Fallback }
export interface TabAppearance { color: string | undefined; isDrift: boolean }
export interface TopTabPresentation {
  projectId: string | null;
  generation: string | null;
  labels: ReadonlyMap<string, TabLabel>;
  appearances: ReadonlyMap<string, TabAppearance>;
}
export const leafPresentationKey = (leaf: LeafTab) => JSON.stringify([leaf.entityType, leaf.id]);

/** One mounted strip owns only its open leaves' display projection. Shared weak
 * ID indexes avoid repeated array searches and retire with their source arrays. */
export function createTopTabPresentationSelector(projectId: string, tabs: readonly AnyTab[]) {
  const leaves = new Map<string, LeafTab>();
  for (const tab of tabs) {
    const targets = tab.kind === 'leaf' ? [tab] : tab.kind === 'split' ? [tab.left, tab.right] : [];
    for (const leaf of targets) leaves.set(leafPresentationKey(leaf), leaf);
  }
  let previous: TopTabPresentation | undefined;
  let previousInput: readonly unknown[] | undefined;
  return (state: Input): TopTabPresentation => {
    const inputs = [state.workspaceProjectId, state.workspaceProjectionGeneration, state.bookNodes,
      state.storylines, state.bookElements, state.bookElementCategories, state.primaryStorylineByNode];
    if (previous && previousInput?.every((value, index) => value === inputs[index])) return previous;
    previousInput = inputs;
    const available = state.workspaceProjectId === projectId && state.workspaceProjectionGeneration !== null;
    const generation = available ? state.workspaceProjectionGeneration : null;
    const authorityMatches = previous?.projectId === (available ? projectId : null) && previous.generation === generation;
    const labels = new Map<string, TabLabel>(); const appearances = new Map<string, TabAppearance>();
    // Resolve lazily: a strip with only chapter tabs need not index element bodies.
    for (const [key, leaf] of leaves) {
      let title = ''; let fallback: Fallback = leaf.entityType === 'node' ? 'chapter' : leaf.entityType;
      let color: string | undefined; let isDrift = false;
      if (available) {
        switch (leaf.entityType) {
          case 'node': {
            const node = indexById(state.bookNodes).get(leaf.id);
            title = node?.title || ''; isDrift = node?.kind === 'drift'; fallback = isDrift ? 'drift' : 'chapter';
            const primary = node ? state.primaryStorylineByNode[node.id] : undefined;
            color = primary ? indexById(state.storylines).get(primary)?.color : undefined;
            break;
          }
          case 'storyline': {
            const storyline = indexById(state.storylines).get(leaf.id);
            title = storyline?.name || ''; color = storyline?.color; break;
          }
          case 'element': {
            const element = indexById(state.bookElements).get(leaf.id);
            title = element?.name || '';
            color = element && element.categoryId !== null
              ? indexById(state.bookElementCategories).get(element.categoryId)?.color : undefined;
            break;
          }
          case 'category': {
            const category = indexById(state.bookElementCategories).get(leaf.id);
            title = category?.name || ''; color = category?.color; break;
          }
          case 'all-chapters': break;
        }
      }
      labels.set(key, { title, fallback }); appearances.set(key, { color, isDrift });
    }
    const sameLabels = authorityMatches && [...labels].every(([key, value]) => {
      const before = previous?.labels.get(key); return before?.title === value.title && before.fallback === value.fallback;
    });
    const sameAppearances = authorityMatches && [...appearances].every(([key, value]) => {
      const before = previous?.appearances.get(key); return before?.color === value.color && before?.isDrift === value.isDrift;
    });
    if (previous && sameLabels && sameAppearances) return previous;
    previous = { projectId: available ? projectId : null, generation,
      labels: sameLabels ? previous!.labels : labels,
      appearances: sameAppearances ? previous!.appearances : appearances,
    };
    return previous;
  };
}
