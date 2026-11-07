//! Where a write comes from. Every commit carries exactly one origin.

use std::fmt;

/// The prefix of an Agent origin and commit message; the editor's
/// `UndoManager` excludes it (`add_exclude_origin_prefix`).
pub const AGENT_PREFIX: &str = "agent:";

/// The source of one commit. The origin is local-only (Loro does not persist
/// it); it is stored in `loro_update.origin`. An Agent commit also carries
/// the same string as its commit message, which Loro persists and syncs.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Origin {
    /// The author, through the editor or any other view.
    User,
    /// An Agent: `<session>` or `<session>/<turn>`.
    Agent(String),
    /// The Markdown folder mirror.
    Mirror,
    /// Updates from the sync service.
    Sync,
    /// The 0.1 library import.
    Import,
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
            "mirror" => Self::Mirror,
            "sync" => Self::Sync,
            "import" => Self::Import,
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

    /// The commit message Loro stores with this origin's changes: Agent
    /// commits are recognisable in history after sync and snapshots.
    pub fn commit_message(&self) -> Option<String> {
        self.is_agent().then(|| self.to_string())
    }
}

impl fmt::Display for Origin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::User => f.write_str("user"),
            Self::Agent(s) => write!(f, "{AGENT_PREFIX}{s}"),
            Self::Mirror => f.write_str("mirror"),
            Self::Sync => f.write_str("sync"),
            Self::Import => f.write_str("import"),
            Self::Genesis => f.write_str("genesis"),
            Self::Outside => f.write_str("outside"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_round_trip() {
        for o in [
            Origin::User,
            Origin::agent("s1", 3),
            Origin::Agent("s2".into()),
            Origin::Mirror,
            Origin::Sync,
            Origin::Import,
            Origin::Genesis,
            Origin::Outside,
        ] {
            assert_eq!(Origin::parse(&o.to_string()), Some(o));
        }
        assert_eq!(Origin::agent("s", 1).to_string(), "agent:s/1");
        assert_eq!(Origin::parse("agent:"), None);
        assert_eq!(Origin::parse("nobody"), None);
        assert_eq!(Origin::User.commit_message(), None);
        assert_eq!(
            Origin::agent("s", 1).commit_message().as_deref(),
            Some("agent:s/1")
        );
    }
}
