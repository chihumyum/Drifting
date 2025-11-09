// definitions for the sql database
// element rows as stored in SQLite
export interface ElementRecord {
    id: string;
    project_id: string;
    category_id: string;
    type: string;
    name: string;
    content_json: string; // tiptap JSON content
    summary_json: string; // description for display in the list
    created_at: string;
    updated_at: string;
    // 同步字段
    sync_status?: string;
    last_modified?: number | null;
    is_deleted?: number;
}

// element belongs to some categories
// categories belong to books
export interface ElementCategoryRecord {
    id: string;
    name: string;
    description_json: string;
    color?: string;
    // 同步字段
    sync_status?: string;
    last_modified?: number | null;
    is_deleted?: number;
}

// element has tags
export interface ElementTag {
    id: string;
    element_id: string;
    stage_id?: string; // tag could belong to element or element stage
    name: string;
    created_at: string;
}

// link element & element stage
export interface StageElementLink {
    element_stage_id: string;
    element_id: string;
}

// each element could have multiple stages, evolving with the story
export interface ElementStage {
    id: string;
    element_id: string;
    stage_index: number;
    start_node_id: number;
    end_node_id: number;
    name: string;
    content_json: string;
    summary_json: string;
    created_at: string;
    updated_at: string;
}

// each element stage could span over multiple chapters
// element stages span can't exceed element itself's span
export interface ChapterElementStageLink {
    chapter_id: string; // scene or lower level nodes don't apply here
    element_stage_id: string;
}

// element mention/appearance records for text blocks
export interface elementOccurrence {
    id: string;
    element_id: string;
    node_id: string;
    block_id: string;
    spans_json: string;
    created_at: string;
}