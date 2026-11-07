//! Where a write came from.
//!
//! Every commit to a Loro document has exactly one origin (the document holder
//! never mixes the author's keystrokes and an Agent's edit in one commit). The
//! origin is local metadata: Loro does not store it, storage records it per
//! update row (`loro_update.origin`), and the editor's undo manager uses it to
//! leave everything but the author's own typing out of Undo. An Agent commit
//! additionally carries its origin as the commit *message*, which Loro does
//! store and replicate, so Agent changes stay recognisable in history; so do
//! Markdown-folder and import commits.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// The prefix of Agent origins.
pub const AGENT_PREFIX: &str = "agent:";

/// A write origin.
#[derive(Clone, PartialEq, Eq, Hash)]
pub enum Origin {
    /// A document's deterministic genesis change.
    Genesis,
    /// The author, through the interface.
    User,
    /// An Agent turn (in-place write, `loro-schema.md` "Agent 写入").
    Agent { session: String, turn: Option<u32> },
    /// The Markdown folder mirror (M-mirror) merging an external edit.
    Mirror,
    /// Updates imported from the sync service.
    Sync,
    /// Importing an old (0.1.x) library or a `.driftingbook`.
    Import,
    /// A deterministic repair `dr-doc` writes on its own (duplicate block
    /// ids after a merge). Not in `loro-schema.md` v0's list; see
    /// `f1-model-doc.md` "待协调".
    Repair,
}

impl Origin {
    pub fn agent(session: impl Into<String>, turn: u32) -> Self {
        Origin::Agent {
            session: session.into(),
            turn: Some(turn),
        }
    }

    /// The string stored with the update and passed to Loro as the commit
    /// origin: `user`, `agent:<session>/<turn>`, `mirror`, `sync`, `import`,
    /// `genesis`, `repair`.
    pub fn as_string(&self) -> String {
        match self {
            Origin::Genesis => "genesis".into(),
            Origin::User => "user".into(),
            Origin::Agent {
                session,
                turn: Some(t),
            } => format!("{AGENT_PREFIX}{session}/{t}"),
            Origin::Agent {
                session,
                turn: None,
            } => format!("{AGENT_PREFIX}{session}"),
            Origin::Mirror => "mirror".into(),
            Origin::Sync => "sync".into(),
            Origin::Import => "import".into(),
            Origin::Repair => "repair".into(),
        }
    }

    /// Parse a stored origin. `agent:<session>` without a turn is accepted;
    /// anything unknown is `None`.
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "genesis" => Origin::Genesis,
            "user" => Origin::User,
            "mirror" => Origin::Mirror,
            "sync" => Origin::Sync,
            "import" => Origin::Import,
            "repair" => Origin::Repair,
            _ => {
                let rest = s.strip_prefix(AGENT_PREFIX)?;
                let (session, turn) = match rest.rsplit_once('/') {
                    Some((sess, t)) if t.bytes().all(|b| b.is_ascii_digit()) && !t.is_empty() => {
                        (sess, Some(t.parse().ok()?))
                    }
                    _ => (rest, None),
                };
                if session.is_empty() {
                    return None;
                }
                Origin::Agent {
                    session: session.to_string(),
                    turn,
                }
            }
        })
    }

    /// The commit message Loro stores with the change, so "who changed
    /// what" can be read from the history itself (it survives compaction and
    /// travels with sync): the origin for Agent, Markdown-folder and import
    /// writes (`agent:<session>/<turn>`, `mirror`, `import`). The author's own
    /// commits carry none; neither do sync (those are other devices' commits,
    /// with their own messages), repair and genesis.
    pub fn commit_message(&self) -> Option<String> {
        matches!(self, Origin::Agent { .. } | Origin::Import | Origin::Mirror)
            .then(|| self.as_string())
    }

    pub fn is_agent(&self) -> bool {
        matches!(self, Origin::Agent { .. })
    }

    /// Whether the author's Undo may revert this write. Only the author's own
    /// typing: an Agent write is undone through snapshot history, and sync,
    /// import, mirror and repair writes are not the author's keystrokes.
    pub fn author_undoable(&self) -> bool {
        matches!(self, Origin::User)
    }
}

/// The Loro origin of the author's *commands* (command palette, the helper
/// acting for the author, object-level undo). The same string as storage's
/// `dr_store::COMMAND_ORIGIN`, written out because dr-model does not depend
/// on dr-store; keep the two equal. Not an [`Origin`]: at the model layer a
/// command is the author's write.
pub const COMMAND_ORIGIN: &str = "user:command";

/// Origin prefixes the editor's undo manager excludes: everything but the
/// author's own typing (`user`). The author's commands are undone by the
/// workspace's journal, so the editor's Undo leaves them out too. Loro
/// matches these as string prefixes; `user` is a prefix of `user:command`,
/// not the other way round, so the author's typing stays undoable.
pub const UNDO_EXCLUDED_ORIGIN_PREFIXES: &[&str] = &[
    AGENT_PREFIX,
    COMMAND_ORIGIN,
    "genesis",
    "mirror",
    "sync",
    "import",
    "repair",
];

impl fmt::Display for Origin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.as_string())
    }
}

impl fmt::Debug for Origin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Origin({})", self.as_string())
    }
}

impl Serialize for Origin {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.as_string())
    }
}

impl<'de> Deserialize<'de> for Origin {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Origin::parse(&s).ok_or_else(|| serde::de::Error::custom(format!("unknown origin {s:?}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_round_trip() {
        for o in [
            Origin::Genesis,
            Origin::User,
            Origin::agent("s1", 3),
            Origin::Agent {
                session: "s1".into(),
                turn: None,
            },
            Origin::Agent {
                session: "a/b".into(),
                turn: Some(2),
            },
            Origin::Mirror,
            Origin::Sync,
            Origin::Import,
            Origin::Repair,
        ] {
            assert_eq!(Origin::parse(&o.as_string()), Some(o.clone()), "{o}");
        }
        assert_eq!(Origin::parse("agent:"), None);
        assert_eq!(Origin::parse("bogus"), None);
        assert_eq!(
            Origin::agent("s", 1).commit_message().as_deref(),
            Some("agent:s/1")
        );
        assert_eq!(Origin::User.commit_message(), None);
        assert_eq!(Origin::Import.commit_message().as_deref(), Some("import"));
        assert_eq!(Origin::Mirror.commit_message().as_deref(), Some("mirror"));
        for o in [Origin::Sync, Origin::Repair, Origin::Genesis] {
            assert_eq!(o.commit_message(), None, "{o}");
        }
    }

    #[test]
    fn only_user_writes_are_author_undoable() {
        for o in [
            Origin::Genesis,
            Origin::agent("s", 1),
            Origin::Mirror,
            Origin::Sync,
            Origin::Import,
            Origin::Repair,
        ] {
            assert!(!o.author_undoable());
            let s = o.as_string();
            assert!(
                UNDO_EXCLUDED_ORIGIN_PREFIXES
                    .iter()
                    .any(|p| s.starts_with(p)),
                "{s} is excluded from undo"
            );
        }
        assert!(Origin::User.author_undoable());
        let excluded = |s: &str| {
            UNDO_EXCLUDED_ORIGIN_PREFIXES
                .iter()
                .any(|p| s.starts_with(p))
        };
        assert!(!excluded("user"));
        assert!(excluded(COMMAND_ORIGIN), "the author's commands");
    }
}
