export interface BookElement {
  id: string;
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
  startNodeId: string;
  endNodeId: string;
  stageName: string;
  contentJson: string;
  summary: string;
  tagIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface BookElementCategory {
  id: string;
  name: string;
  descriptionJson: string;
  color: string;
}

