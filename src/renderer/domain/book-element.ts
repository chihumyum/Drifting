export interface BookElement {
  id: string;
  projectId: string;
  categoryId: string;
  name: string;
  summary: string;
  contentJson: string;
  stageIds: string[];
  tagIds: string[];
  createdAt: string;
  updatedAt: string;
}

// element could have multiple stages as the story progresses
// the contentJson acts like a base, then each new stages patches the element
// this stage has nothing to do with story stages and storylines
export interface BookElementStage {
  id: string;
  elementId: string;
  orderKey: number;
  startNodeId: string | null;
  endNodeId: string | null;
  stageName: string;
  contentJson: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export interface BookElementCategory {
  id: string;
  projectId: string;
  name: string;
  descriptionJson: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}
