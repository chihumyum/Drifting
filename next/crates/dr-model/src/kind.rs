//! String-valued enums stored in the book document.
//!
//! Every one is *open*: a value this version does not know (written by a newer
//! version, or an old value imported as-is) reads as `Other` and is written
//! back unchanged. Readers decide how to show it; nothing is dropped. This is
//! the "unknown values are kept" rule of `loro-schema.md` ("版本").

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

macro_rules! open_enum {
    (
        $(#[$meta:meta])*
        $name:ident {
            $( $(#[$vmeta:meta])* $var:ident = $s:literal $(| $alias:literal)* ),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum $name {
            $( $(#[$vmeta])* $var, )+
            /// A value this version does not know, kept as written.
            Other(Box<str>),
        }

        impl $name {
            /// The values this version knows, as stored.
            pub const KNOWN: &'static [&'static str] = &[$($s),+];

            /// Never fails: unknown values become [`Self::Other`].
            pub fn parse(s: &str) -> Self {
                match s {
                    $( $s $(| $alias)* => Self::$var, )+
                    other => Self::Other(other.into()),
                }
            }

            /// The stored string.
            pub fn as_str(&self) -> &str {
                match self {
                    $( Self::$var => $s, )+
                    Self::Other(s) => s,
                }
            }

            pub fn is_known(&self) -> bool {
                !matches!(self, Self::Other(_))
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                match self {
                    Self::Other(s) => write!(f, "{}::Other({:?})", stringify!($name), s),
                    _ => write!(f, "{}::{}", stringify!($name), self.as_str()),
                }
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                Self::parse(s)
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = String::deserialize(d)?;
                Ok(Self::parse(&s))
            }
        }
    };
}

open_enum!(
    /// Chapter or idea. Readers go by `kind`: a chapter without a primary
    /// storyline is still a chapter.
    NodeKind {
        Chapter = "chapter",
        /// An idea (构想, English "Ideas"; internal name drift).
        Drift = "drift",
    }
);

open_enum!(
    /// Writing status. Chapters use `draft` / `finished` / `discarded`
    /// (`discarded` keeps the chapter on the timeline, styled as set aside);
    /// ideas use `drifting` / `resting`. One field, disambiguated by
    /// [`NodeKind`], as in the old `writing_status` column.
    NodeStatus {
        Draft = "draft",
        Finished = "finished",
        Discarded = "discarded",
        Drifting = "drifting",
        Resting = "resting",
    }
);

impl NodeStatus {
    /// The status a new node of `kind` starts with.
    pub fn default_for(kind: &NodeKind) -> Self {
        match kind {
            NodeKind::Drift => NodeStatus::Drifting,
            _ => NodeStatus::Draft,
        }
    }

    /// Whether this status belongs to `kind` (a chapter status on an idea,
    /// for example, is shown as the kind's default).
    pub fn fits(&self, kind: &NodeKind) -> bool {
        match kind {
            NodeKind::Chapter => matches!(
                self,
                NodeStatus::Draft | NodeStatus::Finished | NodeStatus::Discarded
            ),
            NodeKind::Drift => matches!(self, NodeStatus::Drifting | NodeStatus::Resting),
            NodeKind::Other(_) => true,
        }
    }
}

open_enum!(
    /// What an entity reference (relation end, comment target, memory target,
    /// entity link) points at.
    ///
    /// v0 names materials `material` (the root container is `materials`); the
    /// old `library_item` is read as [`EntityKind::Material`].
    EntityKind {
        Node = "node",
        Element = "element",
        Patch = "patch",
        Category = "category",
        Storyline = "storyline",
        Comment = "comment",
        Material = "material" | "library_item",
    }
);

impl EntityKind {
    /// Canonical, referenceable things: the only kinds a relation may point
    /// *to*, and what an @-mention may name.
    pub fn is_structural(&self) -> bool {
        matches!(
            self,
            EntityKind::Node
                | EntityKind::Element
                | EntityKind::Patch
                | EntityKind::Category
                | EntityKind::Storyline
        )
    }

    /// Kinds a relation may start *from*: structural ones plus comments and
    /// materials (author-side scaffolding links out, never in).
    pub fn may_start_relation(&self) -> bool {
        self.is_structural() || matches!(self, EntityKind::Comment | EntityKind::Material)
    }

    /// Kinds a comment may target: structural ones plus materials (region
    /// comments on images and PDFs, margin comments on notes).
    pub fn may_be_commented(&self) -> bool {
        self.is_structural() || matches!(self, EntityKind::Material)
    }

    /// Kinds an inline entity link (`entity:<id>`) may point at.
    pub fn may_be_linked(&self) -> bool {
        matches!(
            self,
            EntityKind::Element | EntityKind::Node | EntityKind::Storyline | EntityKind::Category
        )
    }
}

open_enum!(
    RelationOrientation {
        Directed = "directed",
        /// Endpoints are stored in canonical order (see
        /// [`crate::book::canonical_symmetric`]).
        Symmetric = "symmetric",
    }
);

open_enum!(
    /// The system key of a built-in relation type. Only one exists.
    SystemRelationKey {
        GenericAssociation = "generic-association",
    }
);

open_enum!(
    /// How a category's elements are laid out in the element overview.
    CategoryLayout {
        Auto = "auto",
        Pinned = "pinned",
    }
);

open_enum!(
    /// A margin note or a TODO. Old values other than these are kept as
    /// written (`loro-schema.md`: "旧值原样").
    CommentKind {
        Note = "note",
        Todo = "todo",
    }
);

open_enum!(
    /// The retired `converted` (a Copilot suggestion that was accepted) is
    /// not a v2 value; importing turns it into `resolved` (see
    /// [`crate::legacy`]).
    CommentStatus {
        Open = "open",
        Resolved = "resolved",
    }
);

open_enum!(
    /// Who wrote a comment. The retired Copilot's comments import as `ai`.
    CommentAuthorKind {
        User = "user",
        Ai = "ai",
        External = "external",
    }
);

open_enum!(
    /// How a comment was made: by hand, or through the Agent / MCP. The
    /// retired `copilot` imports as `api`.
    CommentSource {
        Manual = "manual",
        Api = "api",
    }
);

open_enum!(
    /// What generated a TODO from prose.
    ProjectionKind {
        /// A typed `TODO:` marker in a chapter (the old `todo-autoparse`).
        Marker = "marker",
        /// A task line in a material note (the old `note-task`).
        NoteTask = "note_task",
    }
);

open_enum!(
    CommentPriority {
        Low = "low",
        Med = "med",
        High = "high",
    }
);

open_enum!(
    /// What a material is. URL materials were retired (old migration 0011);
    /// an old `url` value reads as `Other`.
    MaterialKind {
        Image = "image",
        Pdf = "pdf",
        /// A text material: the author's note (its body is a `material:` prose
        /// document in the note profile).
        Text = "text",
    }
);

impl MaterialKind {
    /// Image and PDF materials have asset bytes; text materials do not.
    pub fn needs_asset(&self) -> bool {
        matches!(self, MaterialKind::Image | MaterialKind::Pdf)
    }
}

open_enum!(
    AssetKind {
        Image = "image",
        Pdf = "pdf",
    }
);

open_enum!(
    /// Project Memory entry kind.
    MemoryKind {
        Preference = "preference",
        Veto = "veto",
        Directive = "directive",
    }
);

open_enum!(
    MemoryStatus {
        Pending = "pending",
        Active = "active",
        Dismissed = "dismissed",
    }
);

open_enum!(
    MemorySource {
        Author = "author",
        Agent = "agent",
    }
);

open_enum!(
    /// List item kind in a material note.
    ListKind {
        Bullet = "bullet",
        Ordered = "ordered",
        Task = "task",
    }
);

open_enum!(
    /// Immutable contents projected from the local Agent event journal.
    ConversationEntryKind {
        User = "user",
        Assistant = "assistant",
        Thinking = "thinking",
        ToolCall = "tool_call",
        ToolResult = "tool_result",
    }
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_values_survive() {
        let k = CommentKind::parse("suggestion");
        assert_eq!(k, CommentKind::Other("suggestion".into()));
        assert_eq!(k.as_str(), "suggestion");
        assert!(!k.is_known());
        let json = serde_json::to_string(&k).unwrap();
        assert_eq!(json, "\"suggestion\"");
        assert_eq!(serde_json::from_str::<CommentKind>(&json).unwrap(), k);
    }

    #[test]
    fn library_item_is_read_as_material() {
        assert_eq!(EntityKind::parse("library_item"), EntityKind::Material);
        assert_eq!(EntityKind::Material.as_str(), "material");
    }

    #[test]
    fn entity_kind_roles_match_the_old_vocabulary() {
        // entity-kinds.ts: STRUCTURAL = node, element, patch, category,
        // storyline; relation `from` may also be comment / library_item;
        // relation `to` is structural only.
        let all: Vec<EntityKind> = EntityKind::KNOWN
            .iter()
            .map(|s| EntityKind::parse(s))
            .collect();
        let structural: Vec<&str> = all
            .iter()
            .filter(|k| k.is_structural())
            .map(|k| k.as_str())
            .collect();
        assert_eq!(
            structural,
            vec!["node", "element", "patch", "category", "storyline"]
        );
        assert!(all.iter().all(|k| k.may_start_relation()));
        assert!(EntityKind::Material.may_be_commented());
        assert!(!EntityKind::Comment.may_be_commented());
        assert!(!EntityKind::Patch.may_be_linked());
    }

    #[test]
    fn node_status_fits_its_kind() {
        assert!(NodeStatus::Draft.fits(&NodeKind::Chapter));
        assert!(!NodeStatus::Draft.fits(&NodeKind::Drift));
        assert_eq!(
            NodeStatus::default_for(&NodeKind::Drift),
            NodeStatus::Drifting
        );
    }
}
