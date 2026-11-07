//! The Agent's changes, kept in their ink until the author's pointer touches
//! them, across restarts (M31's residue; F4d's `Ink` with `Touch::Fade`).
//!
//! Every Agent write to a prose document leaves a settlement record in
//! dr-store with the document's versions before and after it. The ledger
//! (one per library) takes each new record, compares the two versions on the
//! document's holder thread (Loro's diff of the body) and keeps every run of
//! new text as a mark: words that only came in are [`MarkKind::New`]
//! (green), words that replaced others [`MarkKind::Changed`] (purple). A
//! mark is two Loro cursors, so it follows every later edit and finds its
//! words again after a restart, whether or not the chapter was open when the
//! Agent wrote. Edits another editor made (the Markdown mirror's origin,
//! M40) are [`MarkKind::External`] (blue), from the workspace's prose events.
//!
//! The marks live in a small JSON file in the library folder, on this device
//! only (`agent-marks.json`). Touching a mark drops it, so "seen" is simply
//! "no longer listed"; so do words edited away. The newest settlement taken
//! is kept too, so a restart neither repeats nor misses one. A library seen
//! for the first time starts from its newest settlement: the history of
//! earlier Agent turns is not coloured.

use std::collections::BTreeMap;
use std::ops::Range;
use std::path::PathBuf;

use dr_model::book::EncodedAnchor;
use dr_store::{OpenDoc, Origin};
use dr_workspace::dto::AnchorBytes;
use dr_workspace::{Workspace, WsEvent};
use futures::StreamExt;
use futures::channel::mpsc;
use gpui::{App, AppContext, Context, Entity, EventEmitter, Global, WeakEntity};
use gpui_prose::schema::BODY;
use loro::cursor::Side;
use loro::{ContainerID, Frontiers, LoroDoc, TextDelta, event::Diff};
use serde_json::{Value, json};

/// What kind of change a mark keeps.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MarkKind {
    /// Words the Agent added.
    New,
    /// Words the Agent wrote in place of others.
    Changed,
    /// Words another editor brought in.
    External,
}

impl MarkKind {
    fn as_str(self) -> &'static str {
        match self {
            MarkKind::New => "new",
            MarkKind::Changed => "chg",
            MarkKind::External => "ext",
        }
    }

    fn parse(s: &str) -> Option<MarkKind> {
        match s {
            "new" => Some(MarkKind::New),
            "chg" => Some(MarkKind::Changed),
            "ext" => Some(MarkKind::External),
            _ => None,
        }
    }
}

/// One coloured run of words.
#[derive(Clone, Debug, PartialEq)]
pub struct Mark {
    pub id: String,
    pub kind: MarkKind,
    pub anchor: EncodedAnchor,
}

/// The marks of a document changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarksChanged {
    pub doc: String,
}

/// The ledger of one library.
pub struct AgentMarks {
    ws: Workspace,
    path: PathBuf,
    /// The newest settlement taken.
    last: i64,
    docs: BTreeMap<String, Vec<Mark>>,
    serial: u64,
    busy: bool,
    again: bool,
    _sub: dr_workspace::events::Subscription,
}

impl EventEmitter<MarksChanged> for AgentMarks {}

#[derive(Default)]
struct Ledgers(BTreeMap<PathBuf, WeakEntity<AgentMarks>>);

impl Global for Ledgers {}

/// What the workspace told the ledger.
enum Notice {
    Settled,
    External {
        doc: String,
        ranges: Vec<Range<usize>>,
    },
}

const FILE: &str = "agent-marks.json";

impl AgentMarks {
    /// The ledger of `ws`'s library: one per library, made on first use.
    pub fn of(ws: &Workspace, cx: &mut App) -> Entity<AgentMarks> {
        let root = ws.library().paths().root.clone();
        if let Some(found) = cx
            .default_global::<Ledgers>()
            .0
            .get(&root)
            .and_then(WeakEntity::upgrade)
        {
            return found;
        }
        let ledger = cx.new(|cx| AgentMarks::open(ws.clone(), root.join(FILE), cx));
        cx.default_global::<Ledgers>()
            .0
            .insert(root, ledger.downgrade());
        ledger
    }

    fn open(ws: Workspace, path: PathBuf, cx: &mut Context<Self>) -> AgentMarks {
        let (tx, mut rx) = mpsc::unbounded::<Notice>();
        let sub = ws.subscribe(move |e| {
            let notice = match e {
                WsEvent::Local(c) if c.table == "agent_settlement" => Some(Notice::Settled),
                WsEvent::Prose(p) if p.origin == Origin::Mirror => Some(Notice::External {
                    doc: p.doc.to_string(),
                    ranges: p.ranges.iter().filter(|r| !r.is_empty()).cloned().collect(),
                }),
                _ => None,
            };
            if let Some(n) = notice {
                let _ = tx.unbounded_send(n);
            }
        });
        cx.spawn(async move |this, cx| {
            while let Some(notice) = rx.next().await {
                let alive = this.update(cx, |this, cx| match notice {
                    Notice::Settled => this.take_settlements(cx),
                    Notice::External { doc, ranges } => this.take_external(doc, ranges, cx),
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
        let (last, docs) = match std::fs::read(&path) {
            Ok(bytes) => read_file(&bytes),
            // First time: start after the newest settlement.
            Err(_) => (newest_settlement(&ws), BTreeMap::new()),
        };
        let serial = docs.values().flatten().count() as u64;
        let mut ledger = AgentMarks {
            ws,
            path,
            last,
            docs,
            serial,
            busy: false,
            again: false,
            _sub: sub,
        };
        // Settlements written while the app was closed (or before the
        // ledger was made).
        ledger.take_settlements(cx);
        ledger
    }

    /// The marks on prose document `doc`.
    pub fn marks(&self, doc: &str) -> &[Mark] {
        self.docs.get(doc).map(Vec::as_slice).unwrap_or_default()
    }

    /// Drops marks (touched by the pointer, or their words edited away).
    pub fn forget(&mut self, doc: &str, ids: &[&str], cx: &mut Context<Self>) {
        let Some(marks) = self.docs.get_mut(doc) else {
            return;
        };
        let before = marks.len();
        marks.retain(|m| !ids.contains(&m.id.as_str()));
        if marks.len() != before {
            if marks.is_empty() {
                self.docs.remove(doc);
            }
            self.save();
            cx.emit(MarksChanged {
                doc: doc.to_owned(),
            });
        }
    }

    fn add(&mut self, doc: String, found: Vec<(MarkKind, EncodedAnchor)>, cx: &mut Context<Self>) {
        if found.is_empty() {
            return;
        }
        let marks = self.docs.entry(doc.clone()).or_default();
        for (kind, anchor) in found {
            self.serial += 1;
            marks.push(Mark {
                id: format!("m{}", self.serial),
                kind,
                anchor,
            });
        }
        cx.emit(MarksChanged { doc });
    }

    /// Takes the settlements written since the last one taken.
    fn take_settlements(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            self.again = true;
            return;
        }
        self.busy = true;
        let (ws, last) = (self.ws.clone(), self.last);
        cx.spawn(async move |this, cx| {
            let taken = cx
                .background_executor()
                .spawn(async move { settled_marks(&ws, last) })
                .await;
            this.update(cx, |this, cx| {
                this.busy = false;
                match taken {
                    Ok((newest, found)) => {
                        let changed = newest != this.last || !found.is_empty();
                        this.last = newest;
                        for (doc, marks) in found {
                            this.add(doc, marks, cx);
                        }
                        if changed {
                            this.save();
                        }
                    }
                    Err(e) => log::warn!("dr-editor: Agent marks: {e}"),
                }
                if std::mem::take(&mut this.again) {
                    this.take_settlements(cx);
                }
            })
            .ok();
        })
        .detach();
    }

    fn take_external(&mut self, doc: String, ranges: Vec<Range<usize>>, cx: &mut Context<Self>) {
        let ws = self.ws.clone();
        cx.spawn(async move |this, cx| {
            let doc_id = doc.clone();
            let found = cx
                .background_executor()
                .spawn(async move { external_marks(&ws, &doc_id, ranges) })
                .await;
            this.update(cx, |this, cx| match found {
                Ok(found) => {
                    this.add(doc, found, cx);
                    this.save();
                }
                Err(e) => log::warn!("dr-editor: external marks: {e}"),
            })
            .ok();
        })
        .detach();
    }

    fn save(&self) {
        let docs: serde_json::Map<String, Value> = self
            .docs
            .iter()
            .map(|(doc, marks)| {
                let list: Vec<Value> = marks
                    .iter()
                    .map(|m| {
                        let bytes = AnchorBytes::from(&m.anchor);
                        json!({ "id": m.id, "kind": m.kind.as_str(), "start": bytes.start, "end": bytes.end })
                    })
                    .collect();
                (doc.clone(), Value::Array(list))
            })
            .collect();
        let file = json!({ "v": 1, "last_settlement": self.last, "docs": docs });
        let tmp = self.path.with_extension("json.tmp");
        let written =
            std::fs::write(&tmp, file.to_string()).and_then(|()| std::fs::rename(&tmp, &self.path));
        if let Err(e) = written {
            log::warn!("dr-editor: writing {}: {e}", self.path.display());
        }
    }
}

fn read_file(bytes: &[u8]) -> (i64, BTreeMap<String, Vec<Mark>>) {
    let Ok(file) = serde_json::from_slice::<Value>(bytes) else {
        return (0, BTreeMap::new());
    };
    let last = file["last_settlement"].as_i64().unwrap_or(0);
    let mut docs = BTreeMap::new();
    if let Some(map) = file["docs"].as_object() {
        for (doc, list) in map {
            let marks: Vec<Mark> = list
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|m| {
                    let bytes = AnchorBytes {
                        start: m["start"].as_str()?.to_owned(),
                        end: m["end"].as_str()?.to_owned(),
                    };
                    Some(Mark {
                        id: m["id"].as_str()?.to_owned(),
                        kind: MarkKind::parse(m["kind"].as_str()?)?,
                        anchor: bytes.bytes()?,
                    })
                })
                .collect();
            if !marks.is_empty() {
                docs.insert(doc.clone(), marks);
            }
        }
    }
    (last, docs)
}

fn newest_settlement(ws: &Workspace) -> i64 {
    ws.library()
        .settlements(None, None)
        .ok()
        .and_then(|s| s.last().map(|s| s.id))
        .unwrap_or(0)
}

type Found = Vec<(String, Vec<(MarkKind, EncodedAnchor)>)>;

/// The marks of every settlement after `last`: (newest id, marks by doc).
fn settled_marks(ws: &Workspace, last: i64) -> Result<(i64, Found), String> {
    let lib = ws.library();
    let settlements = lib.settlements(None, None).map_err(|e| e.to_string())?;
    let mut newest = last;
    let mut found: Found = Vec::new();
    for s in settlements.into_iter().filter(|s| s.id > last) {
        newest = newest.max(s.id);
        if !s.doc_id.starts_with("node:") {
            continue;
        }
        let Ok(handle) = lib.open_doc(&s.doc_id, OpenDoc::Existing) else {
            continue;
        };
        let (before, after) = (s.before.clone(), s.after.clone());
        let marks = handle
            .read(move |d| changed_runs(d, &before, &after))
            .map_err(|e| e.to_string())?;
        if !marks.is_empty() {
            found.push((s.doc_id, marks));
        }
    }
    Ok((newest, found))
}

/// The runs of new text between two versions of a body, as marks anchored
/// at `after`.
pub fn changed_runs(
    d: &LoroDoc,
    before: &Frontiers,
    after: &Frontiers,
) -> Vec<(MarkKind, EncodedAnchor)> {
    let Ok(diff) = d.diff(before, after) else {
        return Vec::new();
    };
    let deltas = diff.iter().find_map(|(id, diff)| match (id, diff) {
        (ContainerID::Root { name, .. }, Diff::Text(deltas)) if name.as_str() == BODY => {
            Some(deltas.clone())
        }
        _ => None,
    });
    let Some(deltas) = deltas else {
        return Vec::new();
    };
    // The body as it was before, to compare replaced words with.
    let before_text: Vec<char> = match d.fork_at(before) {
        Ok(f) => f.get_text(BODY).to_string().chars().collect(),
        Err(_) => Vec::new(),
    };
    let runs = runs_of(&deltas, &before_text);
    if runs.is_empty() {
        return Vec::new();
    }
    // Cursors on the characters as they were right after the write.
    let forked;
    let doc = if d.state_frontiers() == *after {
        d
    } else {
        match d.fork_at(after) {
            Ok(f) => {
                forked = f;
                &forked
            }
            Err(_) => return Vec::new(),
        }
    };
    let text = doc.get_text(BODY);
    runs.into_iter()
        .filter_map(|(range, kind)| {
            let start = text.get_cursor(range.start, Side::Left)?;
            let end = text.get_cursor(range.end - 1, Side::Right)?;
            Some((
                kind,
                EncodedAnchor {
                    start: start.encode(),
                    end: end.encode(),
                },
            ))
        })
        .collect()
}

/// Runs of new text in a body delta (positions in the new text). Each place
/// the delta deleted and inserted is compared with the old text (`before`,
/// the body before the change): the words both share at its start and end
/// are left alone, and what is left is `Changed` if old words went, `New`
/// if words only came in (so replacing 「钟」 with 「钟楼」 marks 「楼」 as
/// new). Runs of only whitespace (a new empty paragraph) are left out.
pub fn runs_of(deltas: &[TextDelta], before: &[char]) -> Vec<(Range<usize>, MarkKind)> {
    let mut runs = Vec::new();
    let (mut old, mut new) = (0usize, 0usize);
    // The place being gathered: where it starts in the new text, the old
    // words deleted and the new words inserted there.
    let mut deleted: Vec<char> = Vec::new();
    let mut inserted: Vec<char> = Vec::new();
    let mut at = 0usize;
    let close =
        |at: usize, deleted: &mut Vec<char>, inserted: &mut Vec<char>, runs: &mut Vec<_>| {
            if !inserted.is_empty() {
                let prefix = deleted
                    .iter()
                    .zip(inserted.iter())
                    .take_while(|(a, b)| a == b)
                    .count();
                let room = deleted.len().min(inserted.len()) - prefix;
                let suffix = deleted
                    .iter()
                    .rev()
                    .zip(inserted.iter().rev())
                    .take(room)
                    .take_while(|(a, b)| a == b)
                    .count();
                let words = &inserted[prefix..inserted.len() - suffix];
                if words.iter().any(|c| !c.is_whitespace()) {
                    let kind = if deleted.len() > prefix + suffix {
                        MarkKind::Changed
                    } else {
                        MarkKind::New
                    };
                    let start = at + prefix;
                    runs.push((start..start + words.len(), kind));
                }
            }
            deleted.clear();
            inserted.clear();
        };
    for delta in deltas {
        match delta {
            TextDelta::Retain { retain, .. } => {
                close(at, &mut deleted, &mut inserted, &mut runs);
                old += retain;
                new += retain;
                at = new;
            }
            TextDelta::Delete { delete } => {
                let end = (old + delete).min(before.len());
                deleted.extend_from_slice(&before[old.min(end)..end]);
                old += delete;
            }
            TextDelta::Insert { insert, .. } => {
                if inserted.is_empty() && deleted.is_empty() {
                    at = new;
                }
                inserted.extend(insert.chars());
                new += insert.chars().count();
            }
        }
    }
    close(at, &mut deleted, &mut inserted, &mut runs);
    runs
}

/// Marks for what another editor wrote (ranges in the body now).
fn external_marks(
    ws: &Workspace,
    doc: &str,
    ranges: Vec<Range<usize>>,
) -> Result<Vec<(MarkKind, EncodedAnchor)>, String> {
    let handle = ws
        .library()
        .open_doc(doc, OpenDoc::Existing)
        .map_err(|e| e.to_string())?;
    handle
        .read(move |d| {
            let text = d.get_text(BODY);
            let len = text.len_unicode();
            ranges
                .into_iter()
                .filter(|r| r.end <= len && !r.is_empty())
                .filter_map(|r| {
                    let start = text.get_cursor(r.start, Side::Left)?;
                    let end = text.get_cursor(r.end - 1, Side::Right)?;
                    Some((
                        MarkKind::External,
                        EncodedAnchor {
                            start: start.encode(),
                            end: end.encode(),
                        },
                    ))
                })
                .collect()
        })
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inserted_runs_are_new_or_changed() {
        let retain = |n| TextDelta::Retain {
            retain: n,
            attributes: None,
        };
        let insert = |s: &str| TextDelta::Insert {
            insert: s.into(),
            attributes: None,
        };
        let before: Vec<char> = "开头。中间。结尾。\n".chars().collect();
        // 「中间」 → 「钟楼底下」: rewritten; 「结尾」 → 「结尾处」: only 「处」 is new;
        // a new empty paragraph is no mark.
        let deltas = vec![
            retain(3),
            TextDelta::Delete { delete: 2 },
            insert("钟楼底下"),
            retain(1),
            TextDelta::Delete { delete: 2 },
            insert("结尾处"),
            retain(2),
            insert("\n"),
        ];
        assert_eq!(
            runs_of(&deltas, &before),
            vec![(3..7, MarkKind::Changed), (10..11, MarkKind::New)]
        );
        // A plain insertion.
        let deltas = vec![retain(3), insert("新加的"), retain(7)];
        assert_eq!(runs_of(&deltas, &before), vec![(3..6, MarkKind::New)]);
    }

    #[test]
    fn the_ledger_file_round_trips() {
        let anchor = EncodedAnchor {
            start: vec![1, 2, 3],
            end: vec![4, 5],
        };
        let bytes = AnchorBytes::from(&anchor);
        let file = json!({
            "v": 1,
            "last_settlement": 7,
            "docs": { "node:a": [ { "id": "m1", "kind": "chg", "start": bytes.start, "end": bytes.end } ] }
        });
        let (last, docs) = read_file(file.to_string().as_bytes());
        assert_eq!(last, 7);
        assert_eq!(
            docs["node:a"],
            vec![Mark {
                id: "m1".into(),
                kind: MarkKind::Changed,
                anchor,
            }]
        );
        // A damaged file is an empty ledger, not a crash.
        assert_eq!(read_file(b"not json").0, 0);
    }
}
