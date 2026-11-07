//! Fine-grained change events of a prose document, for the editor (F4) and
//! the derived indexes (F2/F3).

use std::ops::Range;
use std::sync::Arc;

use dr_model::prose::InlineMarks;
use dr_model::{Origin, ProseProfile};
use loro::event::{Diff, DiffEvent};
use loro::{ContainerID, EventTriggerKind, LoroDoc, TextDelta};

use super::attrs::{decode_inline, raw};
use crate::schema;

/// What caused an event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    /// A commit on this device.
    Local,
    /// Imported bytes (sync, or loading).
    Import,
    /// A checkout (history views only).
    Checkout,
}

impl From<EventTriggerKind> for Trigger {
    fn from(k: EventTriggerKind) -> Self {
        match k {
            EventTriggerKind::Local => Trigger::Local,
            EventTriggerKind::Import => Trigger::Import,
            EventTriggerKind::Checkout => Trigger::Checkout,
        }
    }
}

/// One step of a body change, in Unicode scalars, applied left to right
/// (Quill-delta semantics).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TextChange {
    /// Keep `len` characters; `restyled` when their marks or paragraph
    /// attributes changed.
    Retain { len: usize, restyled: bool },
    /// Insert `text` here. `marks` are the inline marks the new characters
    /// have after the change, read the way [`super::ProseView`] reads them
    /// (block keys ignored, the profile's rules applied), so a reader can
    /// place the new text without reading the paragraph back. They hold for
    /// every character of `text` but a `\n`, whose paragraph attributes are
    /// not in the event (read that paragraph). Loro reports the attributes
    /// with every insert, local or imported, so they are always known (the
    /// test `insert_events_carry_the_marks_reads_see` holds this against
    /// reads after every step of random edits on three devices).
    Insert { text: String, marks: InlineMarks },
    /// Delete `len` characters here.
    Delete { len: usize },
}

/// A change to one prose document.
#[derive(Clone, Debug)]
pub struct ProseEvent {
    pub trigger: Trigger,
    /// The commit's origin when this device knows it (local commits, and
    /// imports labelled by the importer). `None` for an empty or unknown
    /// label.
    pub origin: Option<Origin>,
    /// Body changes; empty when the body did not change.
    pub body: Vec<TextChange>,
    /// Some embed entry (table structure, cell, material link) changed.
    pub embeds_changed: bool,
    pub meta_changed: bool,
}

/// A replaced span, in coordinates after the change: `at..at + inserted`
/// is new text that replaced `deleted` characters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Splice {
    pub at: usize,
    pub deleted: usize,
    pub inserted: usize,
}

impl ProseEvent {
    /// The body change as splices (after-change coordinates), adjacent
    /// insert/delete pairs merged.
    pub fn splices(&self) -> Vec<Splice> {
        let mut out: Vec<Splice> = Vec::new();
        let mut pos = 0usize;
        for c in &self.body {
            match c {
                TextChange::Retain { len, .. } => pos += len,
                TextChange::Insert { text, .. } => {
                    let n = text.chars().count();
                    match out.last_mut() {
                        Some(s) if s.at + s.inserted == pos => s.inserted += n,
                        _ => out.push(Splice {
                            at: pos,
                            deleted: 0,
                            inserted: n,
                        }),
                    }
                    pos += n;
                }
                TextChange::Delete { len } => match out.last_mut() {
                    Some(s) if s.at + s.inserted == pos => s.deleted += len,
                    _ => out.push(Splice {
                        at: pos,
                        deleted: *len,
                        inserted: 0,
                    }),
                },
            }
        }
        out
    }

    /// Ranges whose marks changed without the text changing (after-change
    /// coordinates).
    pub fn restyled(&self) -> Vec<Range<usize>> {
        let mut out = Vec::new();
        let mut pos = 0usize;
        for c in &self.body {
            match c {
                TextChange::Retain { len, restyled } => {
                    if *restyled {
                        out.push(pos..pos + len);
                    }
                    pos += len;
                }
                TextChange::Insert { text, .. } => pos += text.chars().count(),
                TextChange::Delete { .. } => {}
            }
        }
        out
    }
}

fn root_name(id: &ContainerID) -> Option<&str> {
    match id {
        ContainerID::Root { name, .. } => Some(name.as_str()),
        ContainerID::Normal { .. } => None,
    }
}

pub(crate) fn convert(e: &DiffEvent<'_>, profile: ProseProfile) -> ProseEvent {
    let mut out = ProseEvent {
        trigger: e.triggered_by.into(),
        origin: Origin::parse(e.origin),
        body: Vec::new(),
        embeds_changed: false,
        meta_changed: false,
    };
    for d in &e.events {
        let root = d
            .path
            .first()
            .and_then(|(id, _)| root_name(id))
            .or_else(|| root_name(d.target));
        match root {
            Some(schema::prose::BODY) => {
                if let Diff::Text(delta) = &d.diff {
                    for t in delta {
                        out.body.push(match t {
                            TextDelta::Retain { retain, attributes } => TextChange::Retain {
                                len: *retain,
                                restyled: attributes.as_ref().is_some_and(|a| !a.is_empty()),
                            },
                            TextDelta::Insert { insert, attributes } => TextChange::Insert {
                                text: insert.clone(),
                                marks: attributes
                                    .as_ref()
                                    .map(|a| decode_inline(&raw(a), profile))
                                    .unwrap_or_default(),
                            },
                            TextDelta::Delete { delete } => TextChange::Delete { len: *delete },
                        });
                    }
                }
            }
            Some(schema::prose::EMBEDS) => out.embeds_changed = true,
            Some(schema::prose::META) => out.meta_changed = true,
            _ => {}
        }
    }
    out
}

pub(crate) fn subscribe(
    doc: &LoroDoc,
    profile: ProseProfile,
    f: impl Fn(&ProseEvent) + Send + Sync + 'static,
) -> loro::Subscription {
    doc.subscribe_root(Arc::new(move |e| f(&convert(&e, profile))))
}
