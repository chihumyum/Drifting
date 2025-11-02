// minimal text block for editing 
// TODO: 后续支持一下yjs的东西，现在先简单存储
export interface BookContentRecord {
  id: string;
  node_id: string; // link to BookNode it belongs to
  pm_json: string; // prosemirror json
  created_at: string;
  updated_at: string;
}