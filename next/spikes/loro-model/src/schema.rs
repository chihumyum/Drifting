//! Container names, mark keys and the style configuration of schema v0.
//!
//! The authority is `docs/rust-rewrite/loro-schema.md`; this module mirrors it.
//! Style configuration is not stored in a Loro document, so every `LoroDoc`
//! must be configured with [`configure`] before it imports or edits anything.

use loro::{ExpandType, LoroDoc, StyleConfig, StyleConfigMap};

/// Schema version written into every document's `meta` map.
pub const SCHEMA_VERSION: i64 = 0;

/// Object replacement character: the placeholder of a table or material embed.
pub const OBJECT: char = '\u{FFFC}';
/// A line break inside one paragraph (Shift-Enter).
pub const LINE_BREAK: char = '\u{2028}';

/// Root containers of a prose document (one chapter, drift, element body,
/// storyline or category description, or material note).
pub mod prose {
    pub const BODY: &str = "body";
    pub const EMBEDS: &str = "embeds";
    pub const META: &str = "meta";
}

/// Root containers of the book (catalog) document.
pub mod book {
    pub const META: &str = "meta";
    pub const NODES: &str = "nodes";
    pub const ACTS: &str = "acts";
    pub const STORYLINES: &str = "storylines";
    pub const CATEGORIES: &str = "categories";
    pub const ELEMENTS: &str = "elements";
    pub const PATCHES: &str = "patches";
    pub const RELATION_TYPES: &str = "relation_types";
    pub const RELATIONS: &str = "relations";
    pub const TIME_PINS: &str = "time_pins";
    pub const PLOT_GRIDS: &str = "plot_grids";
    pub const COMMENTS: &str = "comments";
    pub const MATERIALS: &str = "materials";
    pub const ASSETS: &str = "assets";
    pub const DRIFT_GROUPS: &str = "drift_groups";
    pub const MATERIAL_FOLDERS: &str = "material_folders";
    pub const FACTS: &str = "facts";
    pub const MEMORY: &str = "memory";
    pub const WRITING_DAYS: &str = "writing_days";
}

/// Paragraph attributes. They are marks on the paragraph's terminating `\n`
/// and always use [`ExpandType::None`].
pub mod block {
    /// Block id (string). Every paragraph has one.
    pub const ID: &str = "bid";
    /// 1, 2 or 3. Absent means a body paragraph.
    pub const HEADING: &str = "heading";
    pub const QUOTE: &str = "quote";
    /// 1–8. Absent means 0.
    pub const INDENT: &str = "indent";
    /// "center" or "right". Absent means left.
    pub const ALIGN: &str = "align";
    /// Horizontal rule paragraph (empty text).
    pub const RULE: &str = "rule";
    // Material-note profile only.
    /// "bullet", "ordered" or "task".
    pub const LIST: &str = "list";
    /// Nesting level of a list item, 0-based. Absent means 0.
    pub const LIST_LEVEL: &str = "list_level";
    pub const CHECKED: &str = "checked";
    /// TODO id a task item is linked to.
    pub const TODO: &str = "todo";
    /// Code block; the value is the language ("" when unknown).
    pub const CODE_BLOCK: &str = "code_block";
    /// Callout kind ("note", "warning", …).
    pub const CALLOUT: &str = "callout";

    pub const ALL: &[&str] = &[
        ID, HEADING, QUOTE, INDENT, ALIGN, RULE, LIST, LIST_LEVEL, CHECKED, TODO, CODE_BLOCK,
        CALLOUT,
    ];

    /// Attributes a new paragraph split off the middle of another inherits.
    pub const INHERITED_ON_SPLIT: &[&str] = &[
        HEADING, QUOTE, INDENT, ALIGN, LIST, LIST_LEVEL, CODE_BLOCK, CALLOUT,
    ];
    /// Attributes an empty paragraph created by Enter at a paragraph's end
    /// inherits (a heading is not continued, a list is).
    pub const INHERITED_AT_END: &[&str] = &[QUOTE, INDENT, ALIGN, LIST, LIST_LEVEL, CALLOUT];
}

/// Inline marks.
pub mod inline {
    pub const BOLD: &str = "bold";
    pub const ITALIC: &str = "italic";
    pub const UNDERLINE: &str = "underline";
    pub const STRIKE: &str = "strike";
    pub const LINK: &str = "link";
    /// Material-note profile only: highlight colour.
    pub const HIGHLIGHT: &str = "highlight";
    /// Material-note profile only: inline code.
    pub const CODE: &str = "code";
    /// Prefix of a character/entity link: the full key is `entity:<target id>`.
    pub const ENTITY: &str = "entity";
    /// On a U+FFFC placeholder: the id of the entry in the `embeds` map.
    pub const EMBED: &str = "embed";

    pub fn entity_key(target_id: &str) -> String {
        format!("{ENTITY}:{target_id}")
    }

    pub fn is_entity_key(key: &str) -> bool {
        key.len() > ENTITY.len() + 1
            && key.starts_with(ENTITY)
            && key.as_bytes()[ENTITY.len()] == b':'
    }
}

/// The text style configuration of schema v0.
pub fn style_config() -> StyleConfigMap {
    let mut map = StyleConfigMap::new();
    let none = StyleConfig {
        expand: ExpandType::None,
    };
    let after = StyleConfig {
        expand: ExpandType::After,
    };
    for key in block::ALL {
        map.insert((*key).into(), none);
    }
    for key in [
        inline::BOLD,
        inline::ITALIC,
        inline::UNDERLINE,
        inline::STRIKE,
    ] {
        map.insert(key.into(), after);
    }
    for key in [
        inline::LINK,
        inline::HIGHLIGHT,
        inline::CODE,
        inline::ENTITY,
        inline::EMBED,
    ] {
        map.insert(key.into(), none);
    }
    map
}

/// Configure a document for schema v0. Call before importing or editing.
pub fn configure(doc: &LoroDoc) {
    doc.config_text_style(style_config());
    doc.set_record_timestamp(true);
}
