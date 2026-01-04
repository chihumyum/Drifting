export interface BookElement {
  id: string;
  category: string;
  name: string;
  tags: string[];
  content_json: string;
  summary_json: string;
  createdAt: string;
  updatedAt: string;
  stages: BookElementStage[];
}

export interface BookElementStage {
  id: string;
  elementId: string;
  stage_index: number; // identify sequence for this element
  start_node_id: number; // get start chapter/scene/beat from book nodes
  end_node_id: number;  // get end chapter/scene/beat from book nodes
  cur_stage_tags: string[];
  cur_stage_content_json: string;
  cur_stage_summary_json: string;
  createdAt: string;
  updatedAt: string;
}


export interface BookElementCategory {
  id: string;
  name: string;
  description_json: string;
  color?: string;
}

