//! What a paragraph and a run of text can carry, independent of Loro.
//!
//! `dr-doc` stores these as marks (block attributes on a paragraph's `\n`,
//! inline marks on its characters; `loro-schema.md` "正文文档"). The outline is
//! act / chapter / H1 / H2 / H3: three heading levels treated alike, named
//! H1/H2/H3 only.

use serde::{Deserialize, Serialize};

use crate::id::{BlockId, CommentId, EmbedId};
use crate::kind::{EntityKind, ListKind};

/// Largest paragraph indent.
pub const MAX_INDENT: u8 = 8;

/// A heading level. Absent means a body paragraph.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Heading {
    H1,
    H2,
    H3,
}

impl Heading {
    pub const ALL: [Heading; 3] = [Heading::H1, Heading::H2, Heading::H3];

    /// 1, 2 or 3: the stored value.
    pub fn level(self) -> i64 {
        match self {
            Heading::H1 => 1,
            Heading::H2 => 2,
            Heading::H3 => 3,
        }
    }

    /// `None` for anything but 1, 2 or 3 (a damaged value reads as a body
    /// paragraph).
    pub fn from_level(level: i64) -> Option<Self> {
        match level {
            1 => Some(Heading::H1),
            2 => Some(Heading::H2),
            3 => Some(Heading::H3),
            _ => None,
        }
    }
}

/// Paragraph alignment. Left is the absence of the attribute.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Align {
    #[default]
    Left,
    Center,
    Right,
}

impl Align {
    /// The stored string; `None` for left (not stored).
    pub fn as_stored(self) -> Option<&'static str> {
        match self {
            Align::Left => None,
            Align::Center => Some("center"),
            Align::Right => Some("right"),
        }
    }

    /// Unknown strings read as left.
    pub fn from_stored(s: &str) -> Self {
        match s {
            "center" => Align::Center,
            "right" => Align::Right,
            _ => Align::Left,
        }
    }
}

/// Block attributes of one paragraph, `bid` excluded. The default is a plain
/// body paragraph.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockAttrs {
    pub heading: Option<Heading>,
    pub quote: bool,
    /// 0–[`MAX_INDENT`]; readers clamp larger stored values.
    pub indent: u8,
    pub align: Align,
    /// A horizontal-rule paragraph (its text is empty).
    pub rule: bool,
    // Note profile only (material notes).
    pub list: Option<ListKind>,
    /// Nesting level of a list item, 0-based.
    pub list_level: u32,
    /// Whether an unlinked task item is ticked. A task item linked to a TODO
    /// (`todo`) has no state of its own: it shows the TODO's status, so the
    /// TODO is the only truth. Readers and writers ignore `checked` then.
    pub checked: bool,
    /// The TODO a task item is linked to.
    pub todo: Option<CommentId>,
    /// Code block; the language (may be empty).
    pub code_block: Option<String>,
    /// Callout kind ("note", "warning", …).
    pub callout: Option<String>,
}

impl BlockAttrs {
    pub fn heading(level: Heading) -> Self {
        Self {
            heading: Some(level),
            ..Self::default()
        }
    }

    pub fn is_plain(&self) -> bool {
        *self == Self::default()
    }

    /// What a new paragraph split off the middle of this one inherits:
    /// heading, quote, indent, alignment, list, code block and callout.
    pub fn inherited_on_split(&self) -> Self {
        Self {
            heading: self.heading,
            quote: self.quote,
            indent: self.indent,
            align: self.align,
            rule: false,
            list: self.list.clone(),
            list_level: self.list_level,
            checked: false,
            todo: None,
            code_block: self.code_block.clone(),
            callout: self.callout.clone(),
        }
    }

    /// What the empty paragraph made by Enter at the end of this one
    /// inherits: quote, indent, alignment, list and callout. A heading is not
    /// continued, a list is.
    pub fn inherited_at_end(&self) -> Self {
        Self {
            heading: None,
            quote: self.quote,
            indent: self.indent,
            align: self.align,
            rule: false,
            list: self.list.clone(),
            list_level: self.list_level,
            checked: false,
            todo: None,
            code_block: None,
            callout: self.callout.clone(),
        }
    }

    /// Drop what `profile` does not allow (note-only attributes in a prose
    /// document).
    pub fn restricted_to(mut self, profile: crate::id::ProseProfile) -> Self {
        if profile == crate::id::ProseProfile::Prose {
            self.list = None;
            self.list_level = 0;
            self.checked = false;
            self.todo = None;
            self.code_block = None;
            self.callout = None;
        }
        self
    }
}

/// An inline link from prose to an entity (人物链接 and its siblings).
/// Stored as the mark `entity:<target>` with value `{kind, block?, end_block?}`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct EntityLink {
    /// The target entity id (an element, chapter, storyline or category).
    pub target: String,
    pub kind: EntityKind,
    /// A link to a range of a chapter: first and last block.
    pub block: Option<BlockId>,
    pub end_block: Option<BlockId>,
}

/// Inline marks of one run of text.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InlineMarks {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub link: Option<String>,
    /// Entity links covering this run, sorted by target. They may overlap
    /// (different targets use different keys).
    pub entities: Vec<EntityLink>,
    // Note profile only.
    pub highlight: Option<String>,
    pub code: bool,
    /// Only on a U+FFFC placeholder: the embed it stands for.
    pub embed: Option<EmbedId>,
}

impl InlineMarks {
    pub fn is_plain(&self) -> bool {
        *self == Self::default()
    }
}

/// The inline marks a command can set or clear on a range.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum InlineStyle {
    Bold,
    Italic,
    Underline,
    Strike,
    Link(String),
    /// Note profile only.
    Highlight(String),
    /// Note profile only.
    Code,
}

impl InlineStyle {
    /// Whether `profile` allows this style.
    pub fn allowed_in(&self, profile: crate::id::ProseProfile) -> bool {
        match self {
            InlineStyle::Highlight(_) | InlineStyle::Code => {
                profile == crate::id::ProseProfile::Note
            }
            _ => true,
        }
    }
}

/// Object replacement character: the placeholder of a table or material embed.
pub const OBJECT_CHAR: char = '\u{FFFC}';
/// A line break inside one paragraph (Shift-Enter).
pub const LINE_BREAK: char = '\u{2028}';
/// Ends every paragraph.
pub const PARAGRAPH_END: char = '\n';

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id::ProseProfile;

    #[test]
    fn heading_levels() {
        for h in Heading::ALL {
            assert_eq!(Heading::from_level(h.level()), Some(h));
        }
        assert_eq!(Heading::from_level(0), None);
        assert_eq!(Heading::from_level(4), None);
    }

    #[test]
    fn inheritance_follows_the_schema() {
        let a = BlockAttrs {
            heading: Some(Heading::H2),
            quote: true,
            indent: 3,
            align: Align::Center,
            list: Some(ListKind::Task),
            checked: true,
            todo: Some(CommentId::parse("t1").unwrap()),
            code_block: Some("rust".into()),
            callout: Some("note".into()),
            ..BlockAttrs::default()
        };
        let split = a.inherited_on_split();
        assert_eq!(split.heading, Some(Heading::H2));
        assert_eq!(split.code_block.as_deref(), Some("rust"));
        assert!(!split.checked && split.todo.is_none());
        let end = a.inherited_at_end();
        assert_eq!(end.heading, None);
        assert_eq!(end.code_block, None);
        assert_eq!(end.list, Some(ListKind::Task));
        assert_eq!(end.callout.as_deref(), Some("note"));
        let prose = a.clone().restricted_to(ProseProfile::Prose);
        assert_eq!(prose.list, None);
        assert_eq!(prose.heading, Some(Heading::H2));
        assert_eq!(a.clone().restricted_to(ProseProfile::Note), a);
    }
}
