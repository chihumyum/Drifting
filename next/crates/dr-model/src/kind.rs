//! String-valued enums stored in the book document.
//!
//! Every one is *open*: a value this version does not know (written by a newer
//! version, or an old value imported as-is) reads as `Other` and is written
//! back unchanged. Readers decide how to show it; nothing is dropped. This is
//! the "unknown values are kept" rule of `loro-schema.md` ("版本").

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

        impl ::std::fmt::Display for $name {
            fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl ::std::fmt::Debug for $name {
            fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
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

        impl ::serde::Serialize for $name {
            fn serialize<S: ::serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(self.as_str())
            }
        }

        impl<'de> ::serde::Deserialize<'de> for $name {
            fn deserialize<D: ::serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = <String as ::serde::Deserialize>::deserialize(d)?;
                Ok(Self::parse(&s))
            }
        }
    };
}
pub(crate) use open_enum;

open_enum!(
    /// What an entity reference (relation end, comment target, memory target,
    /// entity link) points at.
    ///
    /// v0 names materials `material` (the root container is `materials`); the
    /// old `library_item` is read as [`EntityKind::Material`].
    ///
    /// A canonical reference names `entry`, `comment`, `patch` or `asset`
    /// (`kernel-v5.md`). `node`, `element`, `category`, `storyline` and
    /// `material` are the 0.1 source format's values. They stay known here, not in
    /// `import_v1`, because this is the stored vocabulary and shared code
    /// still meets them: an entity link written without a kind reads as
    /// `element` (the prose codec and the editor), and the role predicates
    /// below decide which stored references the shared readers accept.
    /// Canonical writers check [`EntityKind::may_be_linked_v3`].
    EntityKind {
        /// Source format only.
        Node = "node",
        /// Source format; also what an entity link without a kind reads as.
        Element = "element",
        Patch = "patch",
        /// Source format only.
        Category = "category",
        /// Source format only.
        Storyline = "storyline",
        Entry = "entry",
        Comment = "comment",
        /// Source format only.
        Material = "material" | "library_item",
        /// A file in the project's asset library (`assets`, `kernel-v5.md` §6).
        Asset = "asset",
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
                | EntityKind::Entry
        )
    }

    /// Kinds a relation may start *from*: structural ones plus comments and
    /// materials (author-side scaffolding links out, never in).
    pub fn may_start_relation(&self) -> bool {
        self.is_structural()
            || matches!(
                self,
                EntityKind::Comment | EntityKind::Material | EntityKind::Asset
            )
    }

    /// Kinds a comment may target: structural ones plus materials (region
    /// comments on images and PDFs, margin comments on notes).
    pub fn may_be_commented(&self) -> bool {
        self.is_structural() || matches!(self, EntityKind::Material | EntityKind::Asset)
    }

    /// Kinds an inline entity link (`entity:<id>`) may point at.
    pub fn may_be_linked(&self) -> bool {
        matches!(
            self,
            EntityKind::Element
                | EntityKind::Node
                | EntityKind::Storyline
                | EntityKind::Category
                | EntityKind::Entry
        )
    }

    /// Kinds a canonical v5 relation may point *to* (`entry`, `patch`, or `asset`).
    pub fn is_structural_v3(&self) -> bool {
        matches!(
            self,
            EntityKind::Entry | EntityKind::Patch | EntityKind::Asset
        )
    }

    /// Kinds a canonical v5 relation may start *from* (`entry`, `patch`, `comment`, or `asset`).
    pub fn may_start_relation_v3(&self) -> bool {
        matches!(
            self,
            EntityKind::Entry | EntityKind::Patch | EntityKind::Comment | EntityKind::Asset
        )
    }

    /// Kinds a canonical v5 comment may target (`entry` or `asset`, `kernel-v5.md` §6, §7 & §10).
    pub fn may_be_commented_v3(&self) -> bool {
        matches!(self, EntityKind::Entry | EntityKind::Asset)
    }

    /// Kinds a canonical inline link may point at (`entry` only, `kernel-v5.md` §6 & §10).
    pub fn may_be_linked_v3(&self) -> bool {
        matches!(self, EntityKind::Entry)
    }
}

open_enum!(
    RelationOrientation {
        Directed = "directed",
        /// Endpoints are stored in canonical order (see
        /// [`crate::shared::canonical_symmetric`]).
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
    /// Source-format (0.1 import replay) comment kind (`note` or `todo`).
    /// Canonical v5 comments have no `kind` (`kernel-v5.md` §7).
    CommentKind {
        Note = "note",
        Todo = "todo",
    }
);

open_enum!(
    /// How a comment came to be (`origin` in `comments`, `kernel-v5.md` §7 & §10).
    CommentOrigin {
        Manual = "manual",
        Marker = "marker",
        Task = "task",
        Agent = "agent",
        Reader = "reader",
    }
);

open_enum!(
    /// The retired `converted` (a Copilot suggestion that was accepted) is
    /// not a v2 value; importing turns it into `resolved` (see
    /// [`crate::import_v1::legacy`]).
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

        for (raw, expected) in [
            ("manual", CommentOrigin::Manual),
            ("marker", CommentOrigin::Marker),
            ("task", CommentOrigin::Task),
            ("agent", CommentOrigin::Agent),
            ("reader", CommentOrigin::Reader),
        ] {
            let parsed = CommentOrigin::parse(raw);
            assert_eq!(parsed, expected);
            assert!(parsed.is_known());
            assert_eq!(parsed.as_str(), raw);
        }
        let custom = CommentOrigin::parse("future_origin");
        assert!(!custom.is_known());
        assert_eq!(custom.as_str(), "future_origin");
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
            vec!["node", "element", "patch", "category", "storyline", "entry",]
        );
        assert!(all.iter().all(|k| k.may_start_relation()));
        assert!(EntityKind::Material.may_be_commented());
        assert!(!EntityKind::Comment.may_be_commented());
        assert!(!EntityKind::Patch.may_be_linked());
        assert!(!EntityKind::Material.may_be_linked());
        assert!(EntityKind::Entry.may_be_linked());
        assert!(EntityKind::Entry.may_be_linked_v3());
        assert!(!EntityKind::Material.may_be_linked_v3());
        assert!(!EntityKind::Element.may_be_linked_v3());
        assert!(EntityKind::Entry.may_start_relation_v3());
        assert!(EntityKind::Comment.may_start_relation_v3());
        assert!(!EntityKind::Material.may_start_relation_v3());
        assert!(EntityKind::Entry.is_structural_v3());
        assert!(!EntityKind::Material.is_structural_v3());
        assert!(EntityKind::Entry.may_be_commented_v3());
        assert!(EntityKind::Asset.may_be_commented_v3());
        assert!(EntityKind::Asset.may_start_relation_v3());
        assert!(EntityKind::Asset.is_structural_v3());
        assert!(!EntityKind::Asset.may_be_linked_v3());
        assert!(!EntityKind::Material.may_be_commented_v3());
    }
}
