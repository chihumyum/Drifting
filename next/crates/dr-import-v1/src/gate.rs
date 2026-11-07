//! The gate before anything is written: can every body be proven to be the
//! latest? A library that went through the handoff (`docs/v2-handoff.md`)
//! passes; one that did not (the author skipped the last 0.1 release) is
//! stopped by default, with the bodies that cannot be proven listed and a way
//! to import anyway (decided by the author, 2026-11-07).
//!
//! Copy is not settled here: [`messages`] holds placeholder message keys for
//! dr-i18n (F6 will render them), with the arguments they take.

use serde::Serialize;

use crate::legacy::{Freshness, ProseKind, ProseOwner, SyncBlockers};

/// Where the last 0.1 release is published (`docs/releasing.md`). The page
/// of the final 0.1 tag is filled in when that release exists (M42).
pub const LAST_RELEASE_URL: &str = "https://github.com/chihumyum/Drifting/releases/latest";

/// Placeholder message keys of the gate and the receipt (dr-i18n is not
/// built yet; F6 renders them in nine languages).
pub mod messages {
    /// "Some bodies may be missing their last seconds of typing."
    pub const BLOCKED_TITLE: &str = "import.v1.blocked.title";
    /// The library never ran a 0.1 build with the handoff. `{release_url}`.
    pub const NO_HANDOFF: &str = "import.v1.blocked.no_handoff";
    /// `{count}` bodies cannot be proven to be the latest; listed below.
    pub const UNPROVEN: &str = "import.v1.blocked.unproven";
    /// `{count}` chapters are known to be older than what the author wrote.
    pub const STALE: &str = "import.v1.blocked.stale";
    /// `{count}` bodies changed after the handoff checked them.
    pub const CHANGED_AFTER_HANDOFF: &str = "import.v1.blocked.changed_after_handoff";
    /// Sync has unresolved conflicts, gaps or quarantined objects.
    pub const SYNC: &str = "import.v1.blocked.sync";
    /// How to fix it: open the library once in the last 0.1 release
    /// (`{release_url}`), quit it, then import again.
    pub const GET_LAST_RELEASE: &str = "import.v1.blocked.get_last_release";
    /// Button: open the last 0.1 release's download page.
    pub const ACTION_DOWNLOAD: &str = "import.v1.action.download_last_release";
    /// Button: import anyway, from the caches (`{count}` may lack their last
    /// seconds).
    pub const ACTION_IMPORT_ANYWAY: &str = "import.v1.action.import_anyway";
}

/// One body the gate is about.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyRef {
    pub book: String,
    pub kind: ProseKind,
    /// The 0.1 document id (`node-content:<id>`, …).
    pub doc: String,
    pub freshness: Freshness,
    /// What the author would recognise (chapter title, element name, …),
    /// filled in by the caller.
    pub title: Option<String>,
    /// The book's name, filled in by the caller.
    pub book_name: Option<String>,
    /// A node body that is an idea (构想), not a chapter; filled in by the
    /// caller.
    pub drift: bool,
}

/// Why the gate stops.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    /// No handoff stamp, and some bodies cannot be proven.
    NoHandoff,
    /// Bodies changed after creation with nothing recording their revision.
    Unproven,
    /// Chapters whose word-count basis proves the cache older.
    Stale,
    /// Caches changed after the handoff checked them.
    ChangedAfterHandoff,
    /// Sync has unresolved conflicts, gaps or quarantined objects.
    Sync,
}

impl Reason {
    pub fn message(self) -> &'static str {
        match self {
            Reason::NoHandoff => messages::NO_HANDOFF,
            Reason::Unproven => messages::UNPROVEN,
            Reason::Stale => messages::STALE,
            Reason::ChangedAfterHandoff => messages::CHANGED_AFTER_HANDOFF,
            Reason::Sync => messages::SYNC,
        }
    }
}

/// What the author accepted with "import anyway".
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Accept {
    /// Import bodies that cannot be proven (or are known stale) from their
    /// caches.
    pub unproven_bodies: bool,
    /// Import although sync has unresolved conflicts, gaps or quarantined
    /// objects.
    pub sync_blockers: bool,
}

impl Accept {
    pub const NOTHING: Accept = Accept {
        unproven_bodies: false,
        sync_blockers: false,
    };
    pub const EVERYTHING: Accept = Accept {
        unproven_bodies: true,
        sync_blockers: true,
    };
}

/// The gate's verdict on one library.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    pub handed_off: bool,
    pub handoff_app_version: Option<String>,
    pub bodies: usize,
    /// Bodies by freshness.
    pub by_freshness: std::collections::BTreeMap<Freshness, usize>,
    /// Every body that is not proven fresh, in a stable order.
    pub doubtful: Vec<BodyRef>,
    pub sync: SyncBlockers,
    pub reasons: Vec<Reason>,
    /// Where to get the last 0.1 release.
    pub release_url: &'static str,
}

impl Gate {
    pub fn decide(
        handed_off: bool,
        handoff_app_version: Option<String>,
        owners: &[ProseOwner],
        sync: SyncBlockers,
    ) -> Self {
        let mut by_freshness = std::collections::BTreeMap::new();
        let mut doubtful = Vec::new();
        for o in owners {
            *by_freshness.entry(o.freshness).or_default() += 1;
            if !o.freshness.proven_fresh() {
                doubtful.push(BodyRef {
                    book: o.project_id.clone(),
                    kind: o.kind,
                    doc: o.old_doc_id(),
                    freshness: o.freshness,
                    title: None,
                    book_name: None,
                    drift: false,
                });
            }
        }
        doubtful.sort_by(|a, b| (&a.book, a.kind, &a.doc).cmp(&(&b.book, b.kind, &b.doc)));
        let mut reasons = Vec::new();
        let has = |f: Freshness| doubtful.iter().any(|d| d.freshness == f);
        if has(Freshness::Unproven) {
            if !handed_off {
                reasons.push(Reason::NoHandoff);
            }
            reasons.push(Reason::Unproven);
        }
        if has(Freshness::NodeBasisBehind) {
            reasons.push(Reason::Stale);
        }
        if has(Freshness::HandoffMismatch) {
            reasons.push(Reason::ChangedAfterHandoff);
        }
        if sync.any() {
            reasons.push(Reason::Sync);
        }
        Gate {
            handed_off,
            handoff_app_version,
            bodies: owners.len(),
            by_freshness,
            doubtful,
            sync,
            reasons,
            release_url: LAST_RELEASE_URL,
        }
    }

    /// Nothing to ask: every body is proven and sync is settled.
    pub fn clear(&self) -> bool {
        self.reasons.is_empty()
    }

    /// Whether the import may go ahead with what the author accepted.
    pub fn allows(&self, accept: Accept) -> bool {
        self.reasons.iter().all(|r| match r {
            Reason::Sync => accept.sync_blockers,
            Reason::NoHandoff | Reason::Unproven | Reason::Stale | Reason::ChangedAfterHandoff => {
                accept.unproven_bodies
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner(f: Freshness) -> ProseOwner {
        ProseOwner {
            kind: ProseKind::Element,
            id: format!("{f:?}"),
            project_id: "b".into(),
            cache: None,
            updated_at: String::new(),
            updates: 2,
            snapshot: false,
            revision: Some(2),
            freshness: f,
        }
    }

    #[test]
    fn a_handed_off_library_passes() {
        let g = Gate::decide(
            true,
            None,
            &[owner(Freshness::Handoff), owner(Freshness::SeedOnly)],
            SyncBlockers::default(),
        );
        assert!(g.clear() && g.allows(Accept::NOTHING));
        assert!(g.doubtful.is_empty());
    }

    #[test]
    fn without_handoff_unproven_bodies_stop_it_until_accepted() {
        let g = Gate::decide(
            false,
            None,
            &[owner(Freshness::Unproven), owner(Freshness::CreationSeed)],
            SyncBlockers::default(),
        );
        assert_eq!(g.reasons, vec![Reason::NoHandoff, Reason::Unproven]);
        assert!(!g.allows(Accept::NOTHING));
        assert!(g.allows(Accept {
            unproven_bodies: true,
            sync_blockers: false
        }));
        assert_eq!(g.doubtful.len(), 1);
        assert_eq!(g.release_url, LAST_RELEASE_URL);
    }

    #[test]
    fn sync_needs_its_own_consent() {
        let g = Gate::decide(
            true,
            None,
            &[owner(Freshness::HandoffMismatch)],
            SyncBlockers {
                open_conflicts: 1,
                ..SyncBlockers::default()
            },
        );
        assert_eq!(g.reasons, vec![Reason::ChangedAfterHandoff, Reason::Sync]);
        assert!(!g.allows(Accept {
            unproven_bodies: true,
            sync_blockers: false
        }));
        assert!(g.allows(Accept::EVERYTHING));
    }
}
