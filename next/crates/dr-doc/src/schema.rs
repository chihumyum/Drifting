//! Container names, keys and the text style configuration of the schema.
//!
//! The authority is `docs/rust-rewrite/loro-schema.md`; this module mirrors it
//! and nothing outside `dr-doc` should spell these strings. Style
//! configuration is not stored in a Loro document, so every `LoroDoc` is
//! configured with [`configure`] before it imports or edits anything (the
//! document types in this crate do it for you).

use loro::{ExpandType, LoroDoc, StyleConfig, StyleConfigMap};

/// `meta.v` of every document this version creates. v1 fixed the built-in
/// relation type of v0; v2 moved plain lists to position keys and reshaped
/// comments and materials. See `loro-schema.md` "版本".
pub const SCHEMA_VERSION: i64 = 2;

/// Version of the genesis content; part of the genesis peer's hash.
pub const GENESIS_VERSION: u32 = 2;

/// Keys every document's `meta` map has.
pub mod meta {
    pub const VERSION: &str = "v";
    /// Prose documents: the document id string.
    pub const DOC: &str = "doc";
    /// Book document: the book id.
    pub const BOOK: &str = "book";
}

/// Root containers of a prose document.
pub mod prose {
    pub const BODY: &str = "body";
    pub const EMBEDS: &str = "embeds";
    pub const META: &str = "meta";
}

/// Root containers of the book document.
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

    /// Root maps of the form "id → entity map".
    pub const ENTITY_MAPS: &[&str] = &[
        NODES,
        ACTS,
        STORYLINES,
        CATEGORIES,
        ELEMENTS,
        PATCHES,
        RELATION_TYPES,
        RELATIONS,
        TIME_PINS,
        PLOT_GRIDS,
        COMMENTS,
        MATERIALS,
        ASSETS,
        MEMORY,
    ];
}

/// Paragraph attributes: marks on the paragraph's terminating `\n`, always
/// [`ExpandType::None`].
pub mod block {
    pub const ID: &str = "bid";
    pub const HEADING: &str = "heading";
    pub const QUOTE: &str = "quote";
    pub const INDENT: &str = "indent";
    pub const ALIGN: &str = "align";
    pub const RULE: &str = "rule";
    pub const LIST: &str = "list";
    pub const LIST_LEVEL: &str = "list_level";
    pub const CHECKED: &str = "checked";
    pub const TODO: &str = "todo";
    pub const CODE_BLOCK: &str = "code_block";
    pub const CALLOUT: &str = "callout";

    pub const ALL: &[&str] = &[
        ID, HEADING, QUOTE, INDENT, ALIGN, RULE, LIST, LIST_LEVEL, CHECKED, TODO, CODE_BLOCK,
        CALLOUT,
    ];

    pub fn is_block_key(key: &str) -> bool {
        ALL.contains(&key)
    }
}

/// Inline marks.
pub mod inline {
    pub const BOLD: &str = "bold";
    pub const ITALIC: &str = "italic";
    pub const UNDERLINE: &str = "underline";
    pub const STRIKE: &str = "strike";
    pub const LINK: &str = "link";
    pub const HIGHLIGHT: &str = "highlight";
    pub const CODE: &str = "code";
    /// Prefix of an entity link: the full key is `entity:<target id>`.
    pub const ENTITY: &str = "entity";
    /// On a U+FFFC placeholder: the id of the entry in the `embeds` map.
    pub const EMBED: &str = "embed";

    pub fn entity_key(target_id: &str) -> String {
        format!("{ENTITY}:{target_id}")
    }

    /// The target id of an entity-link key, if `key` is one.
    pub fn entity_target(key: &str) -> Option<&str> {
        key.strip_prefix(ENTITY)?
            .strip_prefix(':')
            .filter(|t| !t.is_empty())
    }
}

/// The text style configuration: one `ExpandType` per mark key. Part of the
/// schema: two devices configured differently would extend marks differently
/// on local inserts.
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

/// Configure a document: text styles and per-commit timestamps (seconds).
pub fn configure(doc: &LoroDoc) {
    doc.config_text_style(style_config());
    // Keys a newer version adds and this one does not configure behave like
    // `None` (no expansion) on local inserts rather than Loro's default.
    doc.config_default_text_style(Some(StyleConfig {
        expand: ExpandType::None,
    }));
    doc.set_record_timestamp(true);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entity_keys() {
        assert_eq!(inline::entity_key("el-1"), "entity:el-1");
        assert_eq!(inline::entity_target("entity:el-1"), Some("el-1"));
        assert_eq!(inline::entity_target("entity:"), None);
        assert_eq!(inline::entity_target("entityx"), None);
        assert_eq!(inline::entity_target("bold"), None);
    }
}
