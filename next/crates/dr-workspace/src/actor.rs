//! Who runs a command: the source every write carries.

use dr_store::AgentWrite;

/// The source of a command. Every document write it makes carries this
/// origin (`dr_model::Origin` for the Loro commit, `dr_store::Origin` for the
/// update row); an Agent write also leaves a settlement record in the same
/// SQLite transaction.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Actor {
    /// The author, through any view.
    User,
    /// An Agent turn: `agent:<session>/<turn>`. `call` is the tool call that
    /// made the write (kept in the settlement record).
    Agent {
        session: String,
        turn: u32,
        call: String,
    },
    /// The Markdown folder mirror.
    Mirror,
    /// Updates from the sync service.
    Sync,
    /// Importing a 0.1 library or a `.driftingbook`.
    Import,
}

impl Actor {
    pub fn agent(session: impl Into<String>, turn: u32, call: impl Into<String>) -> Self {
        Actor::Agent {
            session: session.into(),
            turn,
            call: call.into(),
        }
    }

    /// The origin of the Loro commit (dr-doc).
    pub fn model_origin(&self) -> dr_model::Origin {
        match self {
            Actor::User => dr_model::Origin::User,
            Actor::Agent { session, turn, .. } => dr_model::Origin::agent(session.clone(), *turn),
            Actor::Mirror => dr_model::Origin::Mirror,
            Actor::Sync => dr_model::Origin::Sync,
            Actor::Import => dr_model::Origin::Import,
        }
    }

    /// The origin of the stored update row (dr-store). The two crates have
    /// their own `Origin`; the strings are the same.
    pub fn store_origin(&self) -> dr_store::Origin {
        match self {
            Actor::User => dr_store::Origin::User,
            Actor::Agent { session, turn, .. } => dr_store::Origin::agent(session, turn),
            Actor::Mirror => dr_store::Origin::Mirror,
            Actor::Sync => dr_store::Origin::Sync,
            Actor::Import => dr_store::Origin::Import,
        }
    }

    /// The settlement an Agent write leaves, `None` for everyone else.
    pub(crate) fn agent_write(&self, summary: &str) -> Option<AgentWrite> {
        match self {
            Actor::Agent {
                session,
                turn,
                call,
            } => Some(AgentWrite {
                session: session.clone(),
                turn: turn.to_string(),
                call: call.clone(),
                summary: summary.to_string(),
            }),
            _ => None,
        }
    }

    /// The key of this actor's undo stack in the journal: `user`,
    /// `agent:<session>`, `mirror`, `sync`, `import`.
    pub fn journal_key(&self) -> String {
        match self {
            Actor::User => "user".into(),
            Actor::Agent { session, .. } => format!("agent:{session}"),
            Actor::Mirror => "mirror".into(),
            Actor::Sync => "sync".into(),
            Actor::Import => "import".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_and_store_origins_spell_the_same() {
        for a in [
            Actor::User,
            Actor::agent("s1", 3, "c"),
            Actor::Mirror,
            Actor::Sync,
            Actor::Import,
        ] {
            assert_eq!(a.model_origin().as_string(), a.store_origin().to_string());
        }
        assert!(Actor::User.agent_write("x").is_none());
        let w = Actor::agent("s", 2, "call-1").agent_write("did").unwrap();
        assert_eq!(
            (w.session.as_str(), w.turn.as_str(), w.call.as_str()),
            ("s", "2", "call-1")
        );
        assert_eq!(Actor::agent("s", 2, "c").journal_key(), "agent:s");
    }
}
