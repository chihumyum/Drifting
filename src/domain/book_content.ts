// convert between schema record and domain model for book content

import type {BookContentRecord} from '../schema/book_content';


export interface BookContent {
  id: string;
  nodeId: string;
  pm_json: string;
  createdAt: string;
  updatedAt: string;
}
export function toBookContent(record: BookContentRecord): BookContent {
  return {
    id: record.id,
    nodeId: record.node_id,
    pm_json: record.pm_json,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export function bookContentToRecord(node: BookContent): BookContentRecord {
  return {
    id: node.id,
    node_id: node.nodeId,
    pm_json: node.pm_json,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
  };
}

