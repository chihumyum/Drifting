//! The text format: container name, paragraph attributes, inline marks and
//! the Loro style configuration.
//!
//! One body text is one flat `LoroText` under the root key [`BODY`]. Every
//! paragraph ends with `\n`, and the text always ends with `\n`. Paragraph
//! attributes are marks on that terminating newline (Quill style), always
//! [`ExpandType::None`]; inline marks sit on the other characters.
//!
//! This is the body-text part of Drifting's loro-schema v0
//! (`docs/rust-rewrite/loro-schema.md`). Loro does not store style
//! configuration in a document, so every `LoroDoc` must be configured with
//! [`configure`] (or the same table) before it imports or edits anything; a
//! host that configures documents itself must use an identical table, or local
//! inserts expand marks differently on different devices.

use loro::{ExpandType, LoroDoc, StyleConfig, StyleConfigMap};

/// Root key of the body text in every body document.
pub const BODY: &str = "body";
/// A line break inside one paragraph (Shift-Enter).
pub const LINE_BREAK: char = '\u{2028}';
/// Object replacement character: the placeholder of an embed.
pub const OBJECT: char = '\u{FFFC}';

/// Paragraph attributes: marks on the paragraph's terminating `\n`.
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
    /// A horizontal-rule paragraph (empty text).
    pub const RULE: &str = "rule";
    /// "bullet", "ordered" or "task" (note profile).
    pub const LIST: &str = "list";
    /// Nesting level of a list item, 0-based. Absent means 0.
    pub const LIST_LEVEL: &str = "list_level";
    pub const CHECKED: &str = "checked";
    /// A task item's linked TODO id.
    pub const TODO: &str = "todo";
    /// Code block; the value is the language ("" when unknown).
    pub const CODE_BLOCK: &str = "code_block";
    /// Callout kind ("note", "warning", …).
    pub const CALLOUT: &str = "callout";

    /// Every paragraph attribute, block id first.
    pub const ALL: &[&str] = &[
        ID, HEADING, QUOTE, INDENT, ALIGN, RULE, LIST, LIST_LEVEL, CHECKED, TODO, CODE_BLOCK,
        CALLOUT,
    ];

    /// What the first half of a paragraph split in the middle inherits.
    pub const INHERITED_ON_SPLIT: &[&str] = &[
        HEADING, QUOTE, INDENT, ALIGN, LIST, LIST_LEVEL, CODE_BLOCK, CALLOUT,
    ];

    /// What the empty paragraph made by Enter at a paragraph's end (or start)
    /// inherits: a heading is not continued, a list is.
    pub const INHERITED_AT_END: &[&str] = &[QUOTE, INDENT, ALIGN, LIST, LIST_LEVEL, CALLOUT];

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
    /// The value is the URL.
    pub const LINK: &str = "link";
    /// Note profile: highlight colour.
    pub const HIGHLIGHT: &str = "highlight";
    /// Note profile: inline code.
    pub const CODE: &str = "code";
    /// Prefix of an entity link (a character, a place, a chapter …): the full
    /// key is `entity:<target id>`, so links to different targets overlap.
    pub const ENTITY: &str = "entity";
    /// On a U+FFFC placeholder: the id of the embedded object.
    pub const EMBED: &str = "embed";

    /// Marks that a caret-only toggle (⌘B with nothing selected) can set
    /// for the next typed text.
    pub const TOGGLES: &[&str] = &[BOLD, ITALIC, UNDERLINE, STRIKE];

    pub fn entity_key(target_id: &str) -> String {
        format!("{ENTITY}:{target_id}")
    }

    /// The target id of an `entity:<id>` key.
    pub fn entity_target(key: &str) -> Option<&str> {
        key.strip_prefix(ENTITY)?.strip_prefix(':')
    }
}

/// The style table: every paragraph attribute `None`; bold, italic, underline
/// and strike `After` (typing right after bold text stays bold); links,
/// highlights, code, entity links and embeds `None`. `entity` is a prefix:
/// Loro gives `entity:<id>` the `entity` entry. Drifting compares it with
/// `dr-doc`'s table key by key (`dr-editor`'s tests).
pub const STYLE_TABLE: &[(&str, ExpandType)] = &[
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
    (inline::BOLD, ExpandType::After),
    (inline::ITALIC, ExpandType::After),
    (inline::UNDERLINE, ExpandType::After),
    (inline::STRIKE, ExpandType::After),
    (inline::LINK, ExpandType::None),
    (inline::HIGHLIGHT, ExpandType::None),
    (inline::CODE, ExpandType::None),
    (inline::ENTITY, ExpandType::None),
    (inline::EMBED, ExpandType::None),
];

/// How keys not in [`STYLE_TABLE`] expand (a mark a newer version added).
pub const DEFAULT_EXPAND: ExpandType = ExpandType::None;

/// [`STYLE_TABLE`] as Loro's configuration map.
pub fn style_config() -> StyleConfigMap {
    let mut map = StyleConfigMap::new();
    for (key, expand) in STYLE_TABLE {
        map.insert((*key).into(), StyleConfig { expand: *expand });
    }
    map
}

/// Applies [`style_config`] to a document. Call before importing or editing.
pub fn configure(doc: &LoroDoc) {
    doc.config_text_style(style_config());
    doc.config_default_text_style(Some(StyleConfig {
        expand: DEFAULT_EXPAND,
    }));
}
