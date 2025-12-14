// Outline item extracted from TipTap content
export interface OutlineItem {
  id: string;              // Unique ID for this outline item
  level: 1 | 2 | 3;        // Heading level (h1/h2/h3)
  text: string;            // Heading text content
  position: number;        // Position in the document (for ordering)
}

// minimal text block for editing 
// TODO: 后续支持一下yjs的东西，现在先简单存储
export interface BookContentRecord {
  id: string;
  node_id: string;         // link to BookNode it belongs to
  pm_json: string;         // prosemirror json (TipTap content)
  outline_json: string;    // JSON array of OutlineItem[] - extracted heading structure
  created_at: string;
  updated_at: string;
  // sync metadata
  sync_status: 'synced' | 'pending' | 'failed' | 'syncing';
  last_modified: number | null;
  is_deleted: 0 | 1;
}