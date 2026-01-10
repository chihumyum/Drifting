// story stage for the whole book
// span across multiple storylines


export interface StoryStage {
  id: string;
  projectId: string;
  name: string;
  descriptionJson: string;
  orderKey: number;
  startNodeId: string;
  endNodeId: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}