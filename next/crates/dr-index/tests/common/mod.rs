//! A stand-in for dr-store's document holder: a configured `LoroDoc` that
//! imports what dr-doc writes and collects the Loro diffs as the holder
//! does, so the deriver sees exactly what it sees in the app.

#![allow(dead_code)]

use std::borrow::Cow;
use std::sync::{Arc, Mutex};

use dr_doc::prose::ProseDoc;
use dr_store::ContainerChange;
use dr_store::index::{DeriveInput, Derived, DerivedUpdate, Deriver};
use loro::event::{Diff, DiffEvent, MapDelta};
use loro::{EventTriggerKind, LoroDoc, Subscription};

/// dr-store's `owned_diff` (holder.rs).
pub fn owned_diff(diff: Diff<'_>) -> Diff<'static> {
    match diff {
        Diff::List(l) => Diff::List(l),
        Diff::Text(t) => Diff::Text(t),
        Diff::Map(m) => Diff::Map(MapDelta {
            updated: m
                .updated
                .into_iter()
                .map(|(k, v)| (Cow::Owned(k.into_owned()), v))
                .collect(),
        }),
        Diff::Tree(t) => Diff::Tree(Cow::Owned(t.into_owned())),
        Diff::Counter(c) => Diff::Counter(c),
        Diff::Unknown => Diff::Unknown,
    }
}

pub struct StoreDoc {
    pub doc_id: String,
    pub doc: LoroDoc,
    changes: Arc<Mutex<Vec<ContainerChange>>>,
    _sub: Subscription,
}

impl StoreDoc {
    pub fn new(doc_id: &str, peer: u64) -> Self {
        let doc = LoroDoc::new();
        dr_doc::schema::configure(&doc);
        doc.set_peer_id(peer).unwrap();
        let changes: Arc<Mutex<Vec<ContainerChange>>> = Arc::default();
        let sink = changes.clone();
        let sub = doc.subscribe_root(Arc::new(move |e: DiffEvent<'_>| {
            if matches!(e.triggered_by, EventTriggerKind::Checkout) {
                return;
            }
            let mut sink = sink.lock().unwrap();
            for c in e.events {
                sink.push(ContainerChange {
                    target: c.target.clone(),
                    path: c.path.to_vec(),
                    diff: owned_diff(c.diff),
                });
            }
        }));
        Self {
            doc_id: doc_id.to_string(),
            doc,
            changes,
            _sub: sub,
        }
    }

    /// Import everything `from` has that this copy lacks.
    pub fn pull(&self, from: &ProseDoc) {
        let bytes = from.export_updates_since(&self.doc.oplog_vv()).unwrap();
        self.doc.import(&bytes).unwrap();
    }

    pub fn take_changes(&self) -> Vec<ContainerChange> {
        std::mem::take(&mut *self.changes.lock().unwrap())
    }

    pub fn derive(&self, d: &dyn Deriver, changes: Option<&[ContainerChange]>) -> Derived {
        let input = DeriveInput {
            doc_id: &self.doc_id,
            kind: "node",
            book_id: Some("b1"),
            doc: &self.doc,
            changes,
        };
        match d.derive(&input) {
            Some(DerivedUpdate::Full(d)) => d,
            other => panic!("nothing derived: {other:?}"),
        }
    }
}
