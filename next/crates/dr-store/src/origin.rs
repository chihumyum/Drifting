//! Where a write comes from. Every commit carries exactly one origin.

use std::fmt;

/// The prefix of an Agent origin and commit message; the editor's
/// `UndoManager` excludes it (`add_exclude_origin_prefix`).
pub const AGENT_PREFIX: &str = "agent:";

/// The origin of the author's *commands* ([`Origin::Command`]). An editor's
/// undo manager excludes it (`add_exclude_origin_prefix`), so the editor's
/// Undo only takes back the editor's own typing.
pub const COMMAND_ORIGIN: &str = "user:command";

/// The source of one commit. The origin is local-only (Loro does not persist
/// it); it is stored in `loro_update.origin`. An Agent commit also carries
/// the same string as its commit message, which Loro persists and syncs.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Origin {
    /// The author, through the editor or any other view.
    User,
    /// The author through a command rather than an editor: the command
    /// palette, an Agent acting for the author, an object-level undo
    /// (dr-workspace). It is the author's write in every respect (history,
    /// attribution, labels: no commit message, like [`Self::User`]); only the
    /// origin differs, so an editor's undo leaves it to the command journal
    /// and listeners can tell it from typing.
    Command,
    /// An Agent: `<session>` or `<session>/<turn>`.
    Agent(String),
    /// The Markdown folder mirror.
    Mirror,
    /// Updates from the sync service.
    Sync,
    /// The 0.1 library import.
    Import,
    /// A deterministic repair dr-doc writes on its own (for example duplicate
    /// block ids after a merge).
    Repair,
    /// A document's deterministic genesis change.
    Genesis,
    /// Operations someone wrote to the document outside its holder. A bug:
    /// the holder commits them separately so they never join another origin.
    Outside,
}

impl Origin {
    pub fn agent(session: &str, turn: impl fmt::Display) -> Self {
        Self::Agent(format!("{session}/{turn}"))
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "user" => Self::User,
            COMMAND_ORIGIN => Self::Command,
            "mirror" => Self::Mirror,
            "sync" => Self::Sync,
            "import" => Self::Import,
            "repair" => Self::Repair,
            "genesis" => Self::Genesis,
            "outside" => Self::Outside,
            _ => Self::Agent(
                s.strip_prefix(AGENT_PREFIX)
                    .filter(|r| !r.is_empty())?
                    .into(),
            ),
        })
    }

    pub fn is_agent(&self) -> bool {
        matches!(self, Self::Agent(_))
    }

    /// The author's own write: typing ([`Self::User`]) or a command
    /// ([`Self::Command`]).
    pub fn is_author(&self) -> bool {
        matches!(self, Self::User | Self::Command)
    }

    /// The commit message Loro stores with this origin's changes, so the
    /// origin survives compaction, snapshots and sync: Agent, Markdown
    /// mirror, import and stray outside writes are named; the author's own
    /// commits (and remote ones, which carry their own) are not. dr-doc's
    /// repairs are named too: they are nobody's edit.
    pub fn commit_message(&self) -> Option<String> {
        match self {
            Self::Agent(_) | Self::Mirror | Self::Import | Self::Repair | Self::Outside => {
                Some(self.to_string())
            }
            Self::User | Self::Command | Self::Sync | Self::Genesis => None,
        }
    }
}

impl fmt::Display for Origin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::User => f.write_str("user"),
            Self::Command => f.write_str(COMMAND_ORIGIN),
            Self::Agent(s) => write!(f, "{AGENT_PREFIX}{s}"),
            Self::Mirror => f.write_str("mirror"),
            Self::Sync => f.write_str("sync"),
            Self::Import => f.write_str("import"),
            Self::Repair => f.write_str("repair"),
            Self::Genesis => f.write_str("genesis"),
            Self::Outside => f.write_str("outside"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// dr-model has its own Origin (the domain's); both must store the same
    /// strings so rows and Loro origins mean one thing.
    #[test]
    fn origin_strings_match_dr_model() {
        use dr_model::Origin as M;
        let pairs = [
            (M::Genesis, Origin::Genesis),
            (M::User, Origin::User),
            (M::agent("s", 7), Origin::agent("s", 7)),
            (M::Mirror, Origin::Mirror),
            (M::Sync, Origin::Sync),
            (M::Import, Origin::Import),
            (M::Repair, Origin::Repair),
        ];
        for (m, o) in pairs {
            assert_eq!(m.as_string(), o.to_string());
            assert_eq!(Origin::parse(&m.as_string()), Some(o));
        }
    }

    #[test]
    fn origins_round_trip() {
        for o in [
            Origin::User,
            Origin::Command,
            Origin::agent("s1", 3),
            Origin::Agent("s2".into()),
            Origin::Mirror,
            Origin::Sync,
            Origin::Import,
            Origin::Repair,
            Origin::Genesis,
            Origin::Outside,
        ] {
            assert_eq!(Origin::parse(&o.to_string()), Some(o));
        }
        assert_eq!(Origin::agent("s", 1).to_string(), "agent:s/1");
        assert_eq!(Origin::parse("agent:"), None);
        assert_eq!(Origin::parse("nobody"), None);
        assert_eq!(Origin::User.commit_message(), None);
        assert_eq!(Origin::Command.commit_message(), None);
        assert_eq!(Origin::Command.to_string(), "user:command");
        assert!(Origin::Command.is_author() && Origin::User.is_author());
        assert!(!Origin::agent("s", 1).is_author() && !Origin::Mirror.is_author());
        assert_eq!(Origin::Sync.commit_message(), None);
        assert_eq!(Origin::Mirror.commit_message().as_deref(), Some("mirror"));
        assert_eq!(Origin::Import.commit_message().as_deref(), Some("import"));
        assert_eq!(
            Origin::agent("s", 1).commit_message().as_deref(),
            Some("agent:s/1")
        );
    }
}
