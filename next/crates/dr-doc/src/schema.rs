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

/// Root containers of an append-only Agent conversation.
pub mod conversation {
    pub const META: &str = "meta";
    pub const ENTRIES: &str = "entries";
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

/// The text style table of the schema: every configured mark key and how
/// it expands on local inserts. **The one source of truth.**
///
/// Loro does not store the table in the document; every `LoroDoc` is
/// configured at run time, and `LoroDoc::config_text_style` *replaces* the
/// whole table (the default, set by `config_default_text_style`, is kept
/// separately), so whatever configures a document last wins. And it matters
/// beyond that device: when a mark is made, Loro copies the key's rule from
/// the table into the mark itself, and every device afterwards follows the
/// mark's own rule (tested in `a_mark_made_under_another_table_keeps_its_rule`).
/// A wrong table therefore writes wrong marks into the book for good. Anything
/// that configures a document holding Drifting text must use exactly this
/// table and [`DEFAULT_EXPAND`], or better call [`configure`]. In Drifting
/// only `dr-doc` / `dr-store` configure documents (`dr-editor` does not call
/// `gpui_prose::schema::configure`); `dr-editor`'s tests compare
/// `gpui-prose`'s table with this one key by key
/// ([`style_config_mismatches`]), so a change to either is caught. `dr-doc`
/// does not depend on `gpui-prose`.
///
/// `entity` is a prefix: Loro gives `entity:<id>` the `entity` entry.
pub const STYLE_TABLE: &[(&str, ExpandType)] = &[
    // Paragraph attributes, on the newline only.
    (block::ID, ExpandType::None),
    (block::HEADING, ExpandType::None),
    (block::QUOTE, ExpandType::None),
    (block::INDENT, ExpandType::None),
    (block::ALIGN, ExpandType::None),
    (block::RULE, ExpandType::None),
    (block::LIST, ExpandType::None),
    (block::LIST_LEVEL, ExpandType::None),
    (block::CHECKED, ExpandType::None),
    (block::TODO, ExpandType::None),
    (block::CODE_BLOCK, ExpandType::None),
    (block::CALLOUT, ExpandType::None),
    // Inline marks: typing right after bold text continues it…
    (inline::BOLD, ExpandType::After),
    (inline::ITALIC, ExpandType::After),
    (inline::UNDERLINE, ExpandType::After),
    (inline::STRIKE, ExpandType::After),
    // …but not a link, highlight, code, entity link or embed.
    (inline::LINK, ExpandType::None),
    (inline::HIGHLIGHT, ExpandType::None),
    (inline::CODE, ExpandType::None),
    (inline::ENTITY, ExpandType::None),
    (inline::EMBED, ExpandType::None),
];

/// How keys not in [`STYLE_TABLE`] expand (a mark a newer version added):
/// not at all.
pub const DEFAULT_EXPAND: ExpandType = ExpandType::None;

/// [`STYLE_TABLE`] as Loro's configuration map (without the default, which
/// Loro sets separately: [`configure`] does both).
pub fn style_config() -> StyleConfigMap {
    let mut map = StyleConfigMap::new();
    for (key, expand) in STYLE_TABLE {
        map.insert((*key).into(), StyleConfig { expand: *expand });
    }
    map
}

/// Where `other` (another crate's table and default) differs from the
/// schema's: one line per missing, extra or different key, and the default.
/// Empty when they are identical. For parity tests (`dr-editor` against
/// `gpui-prose`).
pub fn style_table_mismatches(
    other: &[(&str, ExpandType)],
    other_default: Option<ExpandType>,
) -> Vec<String> {
    let mut out = Vec::new();
    for (key, want) in STYLE_TABLE {
        match other
            .iter()
            .filter(|(k, _)| k == key)
            .map(|(_, e)| *e)
            .collect::<Vec<_>>()[..]
        {
            [] => out.push(format!("{key}: missing (schema: {want:?})")),
            [got] if got == *want => {}
            [got] => out.push(format!("{key}: {got:?} (schema: {want:?})")),
            _ => out.push(format!("{key}: listed more than once")),
        }
    }
    for (key, got) in other {
        if !STYLE_TABLE.iter().any(|(k, _)| k == key) {
            out.push(format!("{key}: {got:?}, not in the schema"));
        }
    }
    match other_default {
        Some(d) if d == DEFAULT_EXPAND => {}
        Some(d) => out.push(format!("default: {d:?} (schema: {DEFAULT_EXPAND:?})")),
        None => out.push(format!("default: not set (schema: {DEFAULT_EXPAND:?})")),
    }
    out
}

/// Where another crate's Loro style map (`gpui_prose::schema::style_config()`)
/// differs from [`STYLE_TABLE`]: one line per key it lacks or expands
/// differently. Empty when it gives every schema key the schema's rule.
///
/// Only the keys are compared. `LoroDoc::config_text_style` takes the keys of
/// a map and ignores its default (that is `config_default_text_style`), and
/// Loro cannot list a map's keys, so extra keys are not seen here: compare
/// lists with [`style_table_mismatches`] for that.
pub fn style_config_mismatches(other: &StyleConfigMap) -> Vec<String> {
    STYLE_TABLE
        .iter()
        .filter_map(
            |(key, want)| match other.get(&(*key).into()).map(|c| c.expand) {
                Some(got) if got == *want => None,
                Some(got) => Some(format!("{key}: {got:?} (schema: {want:?})")),
                None => Some(format!("{key}: missing (schema: {want:?})")),
            },
        )
        .collect()
}

/// Configure a document: the style table, its default and per-commit
/// timestamps (seconds). Call before importing or editing; nothing should
/// configure text styles after it.
pub fn configure(doc: &LoroDoc) {
    doc.config_text_style(style_config());
    // The default is separate from the table.
    doc.config_default_text_style(Some(StyleConfig {
        expand: DEFAULT_EXPAND,
    }));
    doc.set_record_timestamp(true);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_style_table_covers_every_mark_key_once() {
        let keys: Vec<&str> = STYLE_TABLE.iter().map(|(k, _)| *k).collect();
        let mut sorted = keys.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), keys.len(), "no key twice");
        for k in block::ALL {
            assert!(keys.contains(k), "{k}");
        }
        for k in [
            inline::BOLD,
            inline::ITALIC,
            inline::UNDERLINE,
            inline::STRIKE,
            inline::LINK,
            inline::HIGHLIGHT,
            inline::CODE,
            inline::ENTITY,
            inline::EMBED,
        ] {
            assert!(keys.contains(&k), "{k}");
        }
        let map = style_config();
        for (k, e) in STYLE_TABLE {
            assert_eq!(map.get(&(*k).into()).map(|c| c.expand), Some(*e));
        }
    }

    #[test]
    fn mismatches_name_every_difference() {
        assert!(style_table_mismatches(STYLE_TABLE, Some(DEFAULT_EXPAND)).is_empty());
        let mut other: Vec<(&str, ExpandType)> = STYLE_TABLE.to_vec();
        other.retain(|(k, _)| *k != inline::LINK);
        other
            .iter_mut()
            .find(|(k, _)| *k == inline::BOLD)
            .unwrap()
            .1 = ExpandType::None;
        other.push(("comment", ExpandType::Both));
        let m = style_table_mismatches(&other, None);
        assert_eq!(m.len(), 4, "{m:?}");
        assert!(m.iter().any(|l| l.starts_with("link: missing")));
        assert!(m.iter().any(|l| l.starts_with("bold: None")));
        assert!(m.iter().any(|l| l.starts_with("comment:")));
        assert!(m.iter().any(|l| l.starts_with("default: not set")));
    }

    #[test]
    fn map_mismatches_name_missing_and_different_keys() {
        assert!(style_config_mismatches(&style_config()).is_empty());
        let mut other = StyleConfigMap::new();
        for (k, e) in STYLE_TABLE {
            if *k == inline::LINK {
                continue;
            }
            let expand = if *k == inline::BOLD {
                ExpandType::None
            } else {
                *e
            };
            other.insert((*k).into(), StyleConfig { expand });
        }
        let m = style_config_mismatches(&other);
        assert_eq!(
            m,
            vec![
                "bold: None (schema: After)".to_string(),
                "link: missing (schema: None)".to_string()
            ]
        );
    }

    #[test]
    fn a_mark_made_under_another_table_keeps_its_rule() {
        // Why the table must have one source. Device A marks bold under some
        // table; device B types right after the bold. Whether B's text is
        // bold depends only on A's table at the moment A marked: the rule
        // travels inside the mark.
        use loro::{ExportMode, LoroDoc};
        let runs_after_b_types = |a_uses_schema: bool, b_uses_schema: bool| {
            let a = LoroDoc::new();
            configure(&a);
            a.set_peer_id(1).unwrap();
            if !a_uses_schema {
                a.config_text_style(StyleConfigMap::new());
            }
            let ta = a.get_text("body");
            ta.insert(0, "ab").unwrap();
            ta.mark(0..2, inline::BOLD, true).unwrap();
            a.commit();
            let b = LoroDoc::new();
            configure(&b);
            if !b_uses_schema {
                b.config_text_style(StyleConfigMap::new());
            }
            b.set_peer_id(2).unwrap();
            b.import(&a.export(ExportMode::all_updates()).unwrap())
                .unwrap();
            let tb = b.get_text("body");
            tb.insert(2, "c").unwrap();
            tb.to_delta().len()
        };
        assert_eq!(runs_after_b_types(true, true), 1, "bold continues (After)");
        assert_eq!(
            runs_after_b_types(true, false),
            1,
            "B's own table does not matter"
        );
        assert_eq!(
            runs_after_b_types(false, true),
            2,
            "A's wrong table broke it for B too"
        );
        assert_eq!(runs_after_b_types(false, false), 2);
    }

    #[test]
    fn entity_keys() {
        assert_eq!(inline::entity_key("el-1"), "entity:el-1");
        assert_eq!(inline::entity_target("entity:el-1"), Some("el-1"));
        assert_eq!(inline::entity_target("entity:"), None);
        assert_eq!(inline::entity_target("entityx"), None);
        assert_eq!(inline::entity_target("bold"), None);
    }
}
