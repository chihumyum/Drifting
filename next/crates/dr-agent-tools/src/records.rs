//! Which stored records back a read subject, and what a turn has read of a
//! book (`docs/rust-rewrite/foundations/f3-write-guards.md`).
//!
//! A subject says what the model was shown (`entry:<id>`, `module:<entry>:<module>`,
//! `timeline_view:*`). Its backing is the part of the book document that read
//! came from. A later write is held to the backing of the subjects it needs:
//! a change anywhere else in the book neither refuses it nor costs the turn
//! what it has read.

use std::collections::{BTreeSet, HashMap};

use dr_workspace::{RecordKey, RecordObservation, RecordPrecondition};
use serde_json::Value;

use super::timeline;

pub(super) enum Backing {
    /// Not stored in the book document: prose and session history keep
    /// their own guards.
    Outside,
    Records(Vec<RecordKey>),
    /// No per-record backing: the whole book document, by version.
    Document,
}

/// The backing of `subject` as the read `name(args) -> output` showed it.
pub(super) fn backing(subject: &str, name: &str, output: &Value) -> Backing {
    let Some((domain, id)) = subject.split_once(':') else {
        return Backing::Document;
    };
    let any = matches!(id, "*" | "all");
    let collection = |name: &str| {
        Backing::Records(vec![if any {
            RecordKey::collection(name)
        } else {
            RecordKey::record(name, id)
        }])
    };
    match domain {
        "prose" | "history" => Backing::Outside,
        "entry_history" => Backing::Document,
        // The set of entries is read as the order of the top level; each
        // listed entry is its own subject, with its own record.
        "entry" if any || id == "roots" => Backing::Records(vec![RecordKey::children_of(None)]),
        "entry" => Backing::Records(vec![RecordKey::entry(id)]),
        "level" => Backing::Records(vec![RecordKey::entry(id), RecordKey::children_of(Some(id))]),
        "module" => {
            let Some((entry, module)) = id.split_once(':') else {
                return Backing::Document;
            };
            if name != "module.read" || module == "*" {
                // A list of modules, or a module's prose: the entry was read,
                // not the module's stored content.
                return Backing::Records(vec![RecordKey::entry(entry)]);
            }
            let mut keys = vec![
                RecordKey::entry(entry).at(["fields", module]),
                RecordKey::entry(entry).at([format!("kv:{module}")]),
                RecordKey::plot_grid(entry, module),
            ];
            let rows = |field: &str, collection: &str| {
                output[field]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|row| row["id"].as_str())
                    .map(|id| RecordKey::record(collection, id))
                    .collect::<Vec<_>>()
            };
            keys.extend(rows("patches", "patches"));
            keys.extend(rows("relations", "relations"));
            Backing::Records(keys)
        }
        "entry_template" => collection("templates"),
        "timeline_view" => collection("timeline_views"),
        "entry_relation_type" => collection("relation_types"),
        "membership" => collection("memberships"),
        "book" => Backing::Records(vec![RecordKey::collection("meta")]),
        "fact" => collection("facts"),
        "memory" => collection("memory"),
        "material" => collection("materials"),
        "material_folder" => collection("material_folders"),
        "comment" => collection("comments"),
        "relation" => collection("relations"),
        "asset" => collection("assets"),
        _ => Backing::Document,
    }
}

/// Subjects a read shows beyond those its coverage names: each membership
/// it listed, so removing one is held to that membership and not to every
/// membership of the book.
pub(super) fn also_read(name: &str, output: &Value) -> Vec<String> {
    let rows = |rows: &Value, host: Option<&str>| -> Vec<String> {
        rows.as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| match host {
                Some(host) => Some(format!("membership:{host}|{}", row["id"].as_str()?)),
                None => Some(format!(
                    "membership:{}|{}",
                    row["host"].as_str()?,
                    row["member"].as_str()?
                )),
            })
            .collect()
    };
    match name {
        "membership.list" => rows(output, None),
        // An entry read with what lies below it shows its members.
        "entry.get" => rows(&output["below"]["members"], output["id"].as_str()),
        "entry.list" => output
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|row| rows(&row["below"]["members"], row["id"].as_str()))
            .collect(),
        _ => Vec::new(),
    }
}

/// What one turn has read of its book document.
#[derive(Default)]
pub(super) struct BookReads {
    /// Read subjects and the records each was backed by.
    subjects: HashMap<String, BTreeSet<String>>,
    /// The digest each record had when this turn last read it, by
    /// [`RecordPrecondition::subject`].
    records: HashMap<String, RecordPrecondition>,
    /// Subjects without per-record backing: the book version at their read.
    whole: HashMap<String, String>,
    /// Bound to the `timeline_view` records of the same read. A filtered
    /// list is useful for local edits but does not authorize whole-view
    /// replacement.
    pub(super) timeline_views: Option<timeline::Coverage>,
}

impl BookReads {
    pub(super) fn read_records(&mut self, subject: &str, observed: &[RecordObservation]) {
        let keys = self.subjects.entry(subject.to_owned()).or_default();
        for observation in observed {
            let record = RecordPrecondition::from(observation.clone());
            let name = record.subject();
            keys.insert(name.clone());
            // A newer read of the same record replaces the older digest.
            self.records.insert(name, record);
        }
    }

    pub(super) fn read_whole(&mut self, subject: &str, version: &str) {
        self.whole.insert(subject.to_owned(), version.to_owned());
    }

    /// Whether this turn read `subject` and still holds every digest of it.
    pub(super) fn has(&self, subject: &str) -> bool {
        self.whole.contains_key(subject)
            || self
                .subjects
                .get(subject)
                .is_some_and(|keys| keys.iter().all(|key| self.records.contains_key(key)))
    }

    /// The records `subject` was read from, as preconditions of a write.
    pub(super) fn records_of(&self, subject: &str) -> Vec<RecordPrecondition> {
        self.subjects
            .get(subject)
            .into_iter()
            .flatten()
            .filter_map(|key| self.records.get(key).cloned())
            .collect()
    }

    pub(super) fn version_of(&self, subject: &str) -> Option<&str> {
        self.whole.get(subject).map(String::as_str)
    }

    /// After a write that needed `subject`: what it was read from may have
    /// changed, and a later observation could hold someone else's change too.
    /// Never refresh it implicitly; it has to be read again.
    pub(super) fn forget(&mut self, subject: &str) {
        self.whole.remove(subject);
        for key in self.subjects.remove(subject).into_iter().flatten() {
            self.records.remove(&key);
        }
        if subject.starts_with("timeline_view:") {
            self.timeline_views = None;
        }
    }
}
