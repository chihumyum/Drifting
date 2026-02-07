import type { BookNode } from '../../domain/book-node';
import type { Storyline } from '../../domain/storyline';

export interface TimelineNode extends BookNode {
  storylines: Storyline[];
}

export type BottomTimelineContextMenuType = 'storyline' | 'node';

export interface BottomTimelineContextMenuState {
  x: number;
  y: number;
  type: BottomTimelineContextMenuType;
  storylineId?: string;
  nodeId?: string;
  position?: number;
  canAddCurrentNode?: boolean;
  nodeTitle?: string;
  nodeSummary?: string | null;
  nodeStorylines?: Storyline[];
}

export type BottomTimelineContextMenuAction =
  | 'createChapter'
  | 'editChapter'
  | 'removeFromStoryline'
  | 'deleteNode'
  | 'addToStoryline';
