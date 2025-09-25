// minimal text block for editing 
export interface ContentBlock {
  id: string;
  node_id: string; // chapter | scene | beat
  order_index: number;
  pm_json: string;
  plain_text: string;
  created_at: string;
  updated_at: string;
}