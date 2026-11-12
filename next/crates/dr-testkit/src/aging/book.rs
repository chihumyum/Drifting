//! A book document after a year or three of ordinary use on two devices.
//!
//! [`age`] replays days. On about seven days in ten the author works, most
//! often on the first device; one working day in seven on both. A session is
//! either writing or planning:
//!
//! - **Writing** (25–150 minutes). The writing-day recorder
//!   (`dr-view-stats`, `PERSIST_DELAY` 60 s) stores this device's words for
//!   today once for every minute in which something was typed (about seven
//!   minutes in ten). Every 15 minutes the app saves an entry checkpoint for
//!   each entry whose content changed (`dr-view-history`'s
//!   `AutomaticHistory`), and one more when the session closes; each save
//!   thins that entry's older automatic checkpoints by dr-store's rule. Now
//!   and then the author changes a field (status, title, summary), adds a
//!   fact, a comment or an idea, resolves a comment, and about twice a week
//!   an Agent turn leaves a checkpoint that is never thinned.
//!
//!   An entry's content, as the checkpoints see it
//!   (`BookViewV3::entry_owned_raw_state`), includes the ordered list of its
//!   siblings. So a new idea, or a chapter moved among its siblings, changes
//!   every sibling, and each of them earns a checkpoint too (the spike
//!   `history-aging-spike` probes this through the real commands).
//! - **Planning** (one session in eight): 30–120 drags (idea cards on the
//!   board, chapters on the timeline, elements in the relation view, the
//!   manuscript order) and a time pin or two, with the checkpoints the
//!   dragged entries earn at the next quarter of an hour.
//!
//! Every write is one commit made through dr-doc's typed transaction, with
//! the timestamp the session clock gives it, so Loro cuts its changes where
//! a real library would. [`AgedBook::commits`] lists each commit (when, on
//! which device, of which kind, how many update bytes), which is what a sync
//! cadence is judged on ([`uploads`]).

use std::collections::BTreeMap;

use dr_doc::Result;
use dr_doc::v3::novel::{
    MOD_FIELDS, MOD_KV, MOD_PROSE, TPL_CHAPTER, TPL_CHARACTER, TPL_IDEA, TPL_IDEA_GROUP, TPL_IDEAS,
};
use dr_doc::v3::{BookDocV3, BookTxnV3};
use dr_model::id::{
    CommentId, DeviceKey, EntryId, EntryTemplateId, KvEntryId, ModuleId, TimePinId, TimelineViewId,
};
use dr_model::kind::{CommentAuthorKind, CommentKind, CommentSource, CommentStatus, EntityKind};
use dr_model::pos::PosKey;
use dr_model::shared::{BlockSnapshot, EntityRef, KvEntry};
use dr_model::v3::{FieldValue, TimelinePin};
use dr_model::{Origin, Timestamp};
use dr_workspace::commands::stats::day_of_number;
use dr_workspace::commands::v3::snapshots::{Point, checkpoint_manifest_checksum};

use super::{DAY_S, device_peer, ops};
use crate::rng::Rng;
use crate::seed::T0;
use crate::text;

/// How to age a book.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookAging {
    pub seed: u64,
    /// Calendar days of use.
    pub days: u32,
    /// Devices the author writes on (1 or 2).
    pub devices: usize,
    /// Leave the writing-day recorder's writes out (everything else stays
    /// exactly the same): what the book document would hold if writing days
    /// lived elsewhere.
    pub without_writing_days: bool,
    /// Leave the entry checkpoints out, likewise.
    pub without_checkpoints: bool,
}

impl BookAging {
    pub fn days(days: u32) -> Self {
        Self {
            seed: crate::seed::DEFAULT_SEED,
            days,
            devices: 2,
            without_writing_days: false,
            without_checkpoints: false,
        }
    }
}

/// What a commit to the book document was for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// The writing-day recorder's minute.
    WritingDay,
    /// An entry checkpoint saved (and older automatic ones thinned).
    Checkpoint,
    /// A field, a fact, a title.
    Field,
    /// A card dragged on a board, a pin in the relation view.
    Layout,
    /// A chapter moved on the timeline, a time pin.
    Timeline,
    /// A comment written or resolved.
    Comment,
    /// An entry created or moved in the tree.
    Structure,
}

impl Kind {
    pub const ALL: [Kind; 7] = [
        Kind::WritingDay,
        Kind::Checkpoint,
        Kind::Field,
        Kind::Layout,
        Kind::Timeline,
        Kind::Comment,
        Kind::Structure,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Kind::WritingDay => "writingDay",
            Kind::Checkpoint => "checkpoint",
            Kind::Field => "field",
            Kind::Layout => "layout",
            Kind::Timeline => "timeline",
            Kind::Comment => "comment",
            Kind::Structure => "structure",
        }
    }
}

/// One commit to the book document.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Commit {
    /// Seconds since the epoch.
    pub ts: i64,
    pub device: u8,
    pub kind: Kind,
    /// Bytes of the Loro update of exactly this commit (what storage appends
    /// and a sync that uploaded every commit would send).
    pub bytes: u32,
}

/// What [`age`] did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookStats {
    pub days: u32,
    pub working_days: u32,
    pub sessions: u32,
    pub planning_sessions: u32,
    pub concurrent_sessions: u32,
    pub commits: usize,
    pub writing_day_writes: usize,
    pub checkpoints_saved: usize,
    pub checkpoints_thinned: usize,
    pub checkpoints_kept: usize,
    /// Of the saved, checkpoints of entries whose only change was a sibling
    /// created or moved.
    pub checkpoints_for_siblings: usize,
    pub field_edits: usize,
    pub layout_moves: usize,
    pub timeline_moves: usize,
    pub comments: usize,
    pub entries_created: usize,
    /// Operations in the history when aging stopped.
    pub ops: usize,
}

/// An aged book document: the first device's replica, level with the other.
pub struct AgedBook {
    pub doc: BookDocV3,
    pub stats: BookStats,
    /// Every commit of the aging, oldest first.
    pub commits: Vec<Commit>,
}

/// A live automatic checkpoint: `(id, ts in ms)`.
type Auto = Vec<(String, i64)>;

struct World {
    plan: BookAging,
    rng: Rng,
    book: String,
    devices: Vec<DeviceKey>,
    chapters: Vec<EntryId>,
    ideas: Vec<EntryId>,
    elements: Vec<EntryId>,
    ideas_root: Option<EntryId>,
    idea_groups: Vec<EntryId>,
    view: Option<TimelineViewId>,
    open_comments: Vec<CommentId>,
    /// Words stored per `(device, day)`.
    words: BTreeMap<(usize, i64), i64>,
    /// Live automatic checkpoints per entry.
    auto: BTreeMap<EntryId, Auto>,
    /// The checkpoints each device's replica holds (saved there or synced).
    known: Vec<std::collections::HashSet<String>>,
    created: usize,
    stats: BookStats,
    commits: Vec<Commit>,
}

fn tid(s: &str) -> EntryTemplateId {
    EntryTemplateId::parse(s).expect("valid id")
}

fn mid(s: &str) -> ModuleId {
    ModuleId::parse(s).expect("valid id")
}

impl World {
    fn commit(
        &mut self,
        doc: &mut BookDocV3,
        device: usize,
        ts: i64,
        kind: Kind,
        f: impl FnOnce(&mut BookTxnV3<'_>) -> Result<()>,
    ) -> Result<()> {
        let (r, c) = doc.edit_at(Origin::User, Some(ts), f);
        r?;
        if let Some(c) = c {
            self.commits.push(Commit {
                ts,
                device: device as u8,
                kind,
                bytes: c.update.len() as u32,
            });
            self.stats.commits += 1;
        }
        Ok(())
    }

    fn new_id(&mut self, kind: &str, ts: i64) -> String {
        self.created += 1;
        Rng::stream(self.rng.next_u64(), kind, self.created as u64).uuid7((ts * 1000) as u64)
    }

    fn sentence(&mut self, words: usize) -> String {
        text::body(&mut self.rng, words + 40, text::BodyShape::default())
            .iter()
            .skip(1)
            .map(|p| p.text.as_str())
            .collect::<String>()
            .chars()
            .take(words)
            .collect()
    }

    /// Save a checkpoint of `entry` the way `entry_snapshot.capture` does:
    /// the manifest, then the thinning of that entry's automatic points.
    fn checkpoint(
        &mut self,
        doc: &mut BookDocV3,
        device: usize,
        ts: i64,
        entry: &EntryId,
        reason: &str,
    ) -> Result<()> {
        let id = self.new_id("checkpoint", ts);
        let title = doc
            .view()
            .entry_raw(entry)
            .map(|e| e.title)
            .unwrap_or_default();
        let version = dr_workspace::naming::frontiers_hex(&doc.frontiers());
        let hash = |rng: &mut Rng| dr_store::digest::sha256_hex(&rng.next_u64().to_le_bytes());
        let mut point = Point {
            id: id.clone(),
            format: 1,
            book: self.book.clone(),
            entry: entry.to_string(),
            ts: ts * 1000,
            title,
            reason: reason.to_string(),
            book_version: version.clone(),
            // The entry's body at the version it had then; a body's
            // frontiers encode like the book's.
            bodies: BTreeMap::from([(format!("body:{entry}/{MOD_PROSE}"), version)]),
            checksum: String::new(),
            content_hash: hash(&mut self.rng),
        };
        if self.plan.without_checkpoints {
            return Ok(());
        }
        point.checksum =
            checkpoint_manifest_checksum(&point).expect("a checkpoint manifest serializes");
        let manifest = serde_json::to_string(&point).expect("a checkpoint manifest serializes");
        let automatic = matches!(reason, "periodic" | "close");
        let mut removed = Vec::new();
        if automatic {
            let live = self.auto.entry(entry.clone()).or_default();
            live.push((id.clone(), ts * 1000));
            let rows: Vec<(i64, i64)> = live
                .iter()
                .enumerate()
                .map(|(i, (_, at))| (i as i64, *at))
                .collect();
            let mut drop = dr_store::history::thinning_plan(&rows, ts * 1000);
            drop.sort_unstable();
            for index in drop.into_iter().rev() {
                // A point another device saved and this one has not seen yet
                // stays for a later save to thin.
                let old = &live[index as usize].0;
                if *old != id && self.known[device].contains(old) {
                    removed.push(live.remove(index as usize).0);
                }
            }
        } else {
            self.stats.checkpoints_kept += 1;
        }
        self.known[device].insert(id.clone());
        self.stats.checkpoints_saved += 1;
        self.stats.checkpoints_thinned += removed.len();
        self.commit(doc, device, ts, Kind::Checkpoint, |t| {
            t.put_entry_checkpoint(&id, &manifest)?;
            for old in &removed {
                t.remove_entry_checkpoint(old)?;
            }
            Ok(())
        })
    }

    /// A writing session on calendar day `day`, the `n`th day of the aging.
    fn writing(
        &mut self,
        doc: &mut BookDocV3,
        device: usize,
        (day, n): (i64, usize),
        start: i64,
    ) -> Result<()> {
        let minutes = self.rng.range(25, 150) as i64;
        let fields = mid(MOD_FIELDS);
        // The author works through the book: today's chapter follows the day.
        let through = (n * self.chapters.len()) / self.stats.days.max(1) as usize;
        let chapter = self.chapters[(through + self.rng.range(0, 2)) % self.chapters.len()].clone();
        let mut dirty: Vec<EntryId> = Vec::new();
        // Entries changed only by a sibling's arrival.
        let mut siblings: Vec<EntryId> = Vec::new();
        let mut typed_since_checkpoint = false;
        let agent = self.rng.chance(2.0 / 5.0 / 1.3);
        if agent {
            // The checkpoint an Agent turn saves before it first writes.
            let reason = format!("agent:{}/1", self.new_id("conversation", start));
            self.checkpoint(doc, device, start, &chapter, &reason)?;
        }
        let key = (device, day);
        for minute in 0..minutes {
            let ts = start + minute * 60 + self.rng.range(0, 50) as i64;
            if self.rng.chance(0.7) {
                let words = self.words.entry(key).or_default();
                *words += self.rng.range(10, 45) as i64;
                let (words, device_key, date) =
                    (*words, self.devices[device].clone(), day_of_number(day));
                if !self.plan.without_writing_days {
                    self.stats.writing_day_writes += 1;
                    self.commit(doc, device, ts, Kind::WritingDay, |t| {
                        t.writing_day(&device_key, &date, words)
                    })?;
                }
                typed_since_checkpoint = true;
            }
            if self.rng.below(40) == 0 {
                let target = if self.rng.chance(0.6) || self.ideas.is_empty() {
                    chapter.clone()
                } else {
                    self.rng.pick(&self.ideas).clone()
                };
                let which = self.rng.below(3);
                let value = match which {
                    0 => (*self.rng.pick(&["draft", "revising", "done"])).to_string(),
                    1 => self.sentence(60),
                    _ => self.sentence(8),
                };
                self.stats.field_edits += 1;
                self.commit(doc, device, ts, Kind::Field, |t| {
                    let w = t.entries().entry(&target)?;
                    match which {
                        0 => w.set_field(&fields, "status", Some(&FieldValue::Text(value)))?,
                        1 => w.set_field(&fields, "summary", Some(&FieldValue::Text(value)))?,
                        _ => w.title(&value)?,
                    };
                    Ok(())
                })?;
                if !dirty.contains(&target) {
                    dirty.push(target);
                }
            }
            if self.rng.below(200) == 0 && !self.elements.is_empty() {
                let target = self.rng.pick(&self.elements).clone();
                let fact = KvEntry {
                    id: KvEntryId::parse(&self.new_id("fact", ts)).expect("valid id"),
                    key: self.sentence(4),
                    value: self.sentence(20),
                    pos: Some(PosKey::first()),
                };
                self.stats.field_edits += 1;
                self.commit(doc, device, ts, Kind::Field, |t| {
                    t.entries().entry(&target)?.put_kv(&mid(MOD_KV), &fact)?;
                    Ok(())
                })?;
                if !dirty.contains(&target) {
                    dirty.push(target);
                }
            }
            if self.rng.below(45) == 0 {
                let id = CommentId::parse(&self.new_id("comment", ts)).expect("valid id");
                let todo = self.rng.chance(0.4);
                let (quote, body, block) =
                    (self.sentence(24), self.sentence(40), self.sentence(150));
                let target = chapter.clone();
                self.stats.comments += 1;
                self.commit(doc, device, ts, Kind::Comment, |t| {
                    t.comment(&id)?
                        .kind(if todo {
                            &CommentKind::Todo
                        } else {
                            &CommentKind::Note
                        })?
                        .author_kind(&CommentAuthorKind::User)?
                        .status(&CommentStatus::Open)?
                        .source(&CommentSource::Manual)?
                        .target(Some(&EntityRef::new(EntityKind::Entry, target.as_str())))?
                        .module(Some(&mid(MOD_PROSE)))?
                        .quote(Some(&quote))?
                        .snapshots(&[BlockSnapshot {
                            block: None,
                            text: block,
                        }])?
                        .body(&body)?
                        .created_at(Some(Timestamp(ts)))?
                        .updated_at(Some(Timestamp(ts)))?;
                    Ok(())
                })?;
                self.open_comments.push(id);
            }
            if self.rng.below(80) == 0 && !self.open_comments.is_empty() {
                let at = self.rng.below(self.open_comments.len() as u64) as usize;
                let id = self.open_comments.swap_remove(at);
                self.commit(doc, device, ts, Kind::Comment, |t| {
                    t.comment(&id)?
                        .status(&CommentStatus::Resolved)?
                        .resolved_at(Some(Timestamp(ts)))?
                        .updated_at(Some(Timestamp(ts)))?;
                    Ok(())
                })?;
            }
            if self.rng.below(120) == 0
                && let Some(root) = self.ideas_root.clone()
            {
                // Filed in one of the book's idea groups when it has any.
                let parent = if self.idea_groups.is_empty() {
                    root
                } else {
                    self.rng.pick(&self.idea_groups).clone()
                };
                let id = EntryId::parse(&self.new_id("idea", ts)).expect("valid id");
                let title = self.sentence(8);
                let at = (self.rng.unit() * 4_000.0, self.rng.unit() * 3_000.0);
                self.stats.entries_created += 1;
                self.commit(doc, device, ts, Kind::Structure, |t| {
                    t.entries()
                        .create(&id, Some(&parent), &title, Some(&tid(TPL_IDEA)))?
                        .created_at(Some(Timestamp(ts)))?
                        .board_pos(Some(at))?;
                    Ok(())
                })?;
                self.ideas.push(id);
                // The new idea and every sibling it now stands among.
                for sibling in doc.view().children_of(Some(&parent)) {
                    if !dirty.contains(&sibling.id) && !siblings.contains(&sibling.id) {
                        siblings.push(sibling.id);
                    }
                }
            }
            if minute % 15 == 14 {
                if typed_since_checkpoint && !dirty.contains(&chapter) {
                    dirty.push(chapter.clone());
                }
                for entry in std::mem::take(&mut siblings) {
                    if !dirty.contains(&entry) {
                        self.stats.checkpoints_for_siblings +=
                            usize::from(!self.plan.without_checkpoints);
                        self.checkpoint(doc, device, ts + 5, &entry, "periodic")?;
                    }
                }
                for entry in std::mem::take(&mut dirty) {
                    self.checkpoint(doc, device, ts + 5, &entry, "periodic")?;
                }
                typed_since_checkpoint = false;
            }
        }
        let end = start + minutes * 60 + 30;
        if typed_since_checkpoint && !dirty.contains(&chapter) {
            dirty.push(chapter);
        }
        for entry in siblings {
            if !dirty.contains(&entry) {
                self.stats.checkpoints_for_siblings += usize::from(!self.plan.without_checkpoints);
                self.checkpoint(doc, device, end, &entry, "close")?;
            }
        }
        for entry in dirty {
            self.checkpoint(doc, device, end, &entry, "close")?;
        }
        Ok(())
    }

    fn planning(&mut self, doc: &mut BookDocV3, device: usize, start: i64) -> Result<()> {
        let drags = self.rng.range(30, 120);
        let minutes = self.rng.range(20, 90) as i64;
        let mut dirty: Vec<EntryId> = Vec::new();
        // Entries changed only by a sibling's move.
        let mut moved: Vec<EntryId> = Vec::new();
        let mut quarter = 0;
        for k in 0..drags {
            let ts = start + (k as i64 * minutes * 60) / drags as i64;
            let pick = self.rng.below(100);
            if pick < 50 && !self.ideas.is_empty() {
                let entry = self.rng.pick(&self.ideas).clone();
                let at = (self.rng.unit() * 4_000.0, self.rng.unit() * 3_000.0);
                self.stats.layout_moves += 1;
                self.commit(doc, device, ts, Kind::Layout, |t| {
                    t.entries().entry(&entry)?.board_pos(Some(at))?;
                    Ok(())
                })?;
                dirty.push(entry);
            } else if pick < 70 && self.view.is_some() {
                let entry = self.rng.pick(&self.chapters).clone();
                let view = self.view.clone().expect("checked");
                let at = self.rng.unit() * 1_000.0;
                self.stats.timeline_moves += 1;
                self.commit(doc, device, ts, Kind::Timeline, |t| {
                    t.timeline_view(&view)?.put_placement(&entry, at, None)?;
                    Ok(())
                })?;
            } else if pick < 85 && !self.elements.is_empty() {
                let entry = self.rng.pick(&self.elements).clone();
                let at = (self.rng.unit() * 2_000.0, self.rng.unit() * 2_000.0);
                self.stats.layout_moves += 1;
                self.commit(doc, device, ts, Kind::Layout, |t| {
                    t.entries().entry(&entry)?.relation_pin(Some(at))?;
                    Ok(())
                })?;
                dirty.push(entry);
            } else if pick < 95 {
                // The manuscript order: a chapter moved among its siblings.
                let entry = self.rng.pick(&self.chapters).clone();
                let index = self.rng.range(0, 3);
                self.stats.layout_moves += 1;
                let parent = doc.view().entry_raw(&entry).and_then(|e| e.parent);
                let siblings: Vec<EntryId> = doc
                    .view()
                    .children_of(parent.as_ref())
                    .into_iter()
                    .map(|e| e.id)
                    .collect();
                let commits = self.stats.commits;
                self.commit(doc, device, ts, Kind::Structure, |t| {
                    t.entries().move_to_at(
                        &entry,
                        parent.as_ref(),
                        index.min(siblings.len().saturating_sub(1)),
                    )
                })?;
                // The order changed (not when the chapter was already there):
                // every sibling's content did.
                if self.stats.commits > commits {
                    moved.extend(siblings);
                }
            } else if let Some(view) = self.view.clone() {
                let pin = TimelinePin {
                    id: TimePinId::parse(&self.new_id("pin", ts)).expect("valid id"),
                    at: self.rng.unit() * 1_000.0,
                    label: self.sentence(6),
                    color: None,
                    entry: None,
                };
                self.stats.timeline_moves += 1;
                self.commit(doc, device, ts, Kind::Timeline, |t| {
                    t.timeline_view(&view)?.put_pin(&pin)?;
                    Ok(())
                })?;
            }
            // Dragged entries earn a checkpoint at the next quarter hour.
            let now_quarter = (ts - start) / 900;
            if now_quarter > quarter {
                quarter = now_quarter;
                self.checkpoint_all(doc, device, ts, &mut dirty, &mut moved, "periodic")?;
            }
        }
        let end = start + minutes * 60 + 30;
        self.checkpoint_all(doc, device, end, &mut dirty, &mut moved, "close")
    }

    /// A checkpoint for every entry in `dirty`, then for every entry in
    /// `siblings` that is not also dirty itself; both lists are emptied.
    fn checkpoint_all(
        &mut self,
        doc: &mut BookDocV3,
        device: usize,
        ts: i64,
        dirty: &mut Vec<EntryId>,
        siblings: &mut Vec<EntryId>,
        reason: &str,
    ) -> Result<()> {
        dirty.sort();
        dirty.dedup();
        siblings.sort();
        siblings.dedup();
        for entry in std::mem::take(siblings) {
            if dirty.binary_search(&entry).is_err() {
                self.stats.checkpoints_for_siblings += usize::from(!self.plan.without_checkpoints);
                self.checkpoint(doc, device, ts, &entry, reason)?;
            }
        }
        for entry in std::mem::take(dirty) {
            self.checkpoint(doc, device, ts, &entry, reason)?;
        }
        Ok(())
    }
}

fn sync(from: &BookDocV3, to: &mut BookDocV3) -> Result<()> {
    let bytes = from.export_updates_since(&to.version())?;
    to.import(&bytes, Origin::Sync)?;
    Ok(())
}

/// Age `base` (a seeded v3 book document) by `plan`. `base` is not changed.
pub fn age(base: &BookDocV3, plan: &BookAging) -> Result<AgedBook> {
    assert!((1..=2).contains(&plan.devices), "one or two devices");
    let book = base.book_id().clone();
    let id = base.doc_id().to_string();
    let history = base.export_updates_since(&Default::default())?;
    let mut replicas = Vec::with_capacity(plan.devices);
    for device in 0..plan.devices {
        let mut doc = BookDocV3::create(book.clone(), device_peer(&id, device))?;
        doc.import(&history, Origin::Import)?;
        replicas.push(doc);
    }
    let view = base.view();
    let by_template = |template: &str| -> Vec<EntryId> {
        view.entries()
            .into_iter()
            .filter(|e| e.template.as_ref().is_some_and(|t| t.as_str() == template))
            .map(|e| e.id)
            .collect()
    };
    // The seed's roots by template (it keeps its own categories, so dr-doc's
    // `novel_roots` does not recognise the book as a stock novel).
    let ideas_root = view.root_entry_by_template(&tid(TPL_IDEAS)).map(|e| e.id);
    let timeline = view.timeline_views().into_iter().next().map(|v| v.id);
    let mut world = World {
        plan: *plan,
        rng: Rng::stream(
            plan.seed,
            "aging-book",
            dr_doc::peer::fnv1a64(id.as_bytes()),
        ),
        book: book.to_string(),
        devices: (0..plan.devices)
            .map(|d| DeviceKey::from_installation_id(&format!("dr-testkit-aging-device-{d}")))
            .collect(),
        chapters: by_template(TPL_CHAPTER),
        ideas: by_template(TPL_IDEA),
        elements: by_template(TPL_CHARACTER),
        ideas_root,
        idea_groups: by_template(TPL_IDEA_GROUP),
        view: timeline,
        open_comments: Vec::new(),
        words: BTreeMap::new(),
        auto: BTreeMap::new(),
        known: vec![Default::default(); plan.devices],
        created: 0,
        stats: BookStats {
            days: plan.days,
            ..BookStats::default()
        },
        commits: Vec::new(),
    };
    assert!(!world.chapters.is_empty(), "the seeded book has chapters");
    let first_day = T0 / DAY_S + 1;
    for n in 0..plan.days as i64 {
        let day = first_day + n;
        if !world.rng.chance(0.7) {
            continue;
        }
        world.stats.working_days += 1;
        let both = plan.devices > 1 && world.rng.below(7) == 0;
        let first = if plan.devices == 1 || world.rng.chance(0.75) {
            0
        } else {
            1
        };
        let mut sessions = vec![first];
        if both {
            sessions.push(1 - first);
        }
        for (k, &device) in sessions.iter().enumerate() {
            // The second device of the day sometimes starts before the first
            // one's work has reached it.
            let concurrent = k == 1 && world.rng.chance(0.3);
            if plan.devices > 1 && !concurrent {
                let (a, b) = pair(&mut replicas, 1 - device, device);
                sync(a, b)?;
                let theirs = world.known[1 - device].clone();
                world.known[device].extend(theirs);
            }
            world.stats.concurrent_sessions += u32::from(concurrent);
            let start = day * DAY_S
                + if k == 0 {
                    world.rng.range(7 * 3_600, 12 * 3_600)
                } else {
                    world.rng.range(15 * 3_600, 20 * 3_600)
                } as i64;
            world.stats.sessions += 1;
            if world.rng.below(8) == 0 {
                world.stats.planning_sessions += 1;
                world.planning(&mut replicas[device], device, start)?;
            } else {
                world.writing(&mut replicas[device], device, (day, n as usize), start)?;
            }
        }
    }
    if plan.devices > 1 {
        let (a, b) = pair(&mut replicas, 1, 0);
        sync(a, b)?;
    }
    let doc = replicas.swap_remove(0);
    let mut stats = world.stats;
    stats.ops = ops(&doc.version());
    let mut commits = world.commits;
    commits.sort_by_key(|c| (c.ts, c.device));
    Ok(AgedBook {
        doc,
        stats,
        commits,
    })
}

fn pair(v: &mut [BookDocV3], from: usize, to: usize) -> (&BookDocV3, &mut BookDocV3) {
    assert_ne!(from, to);
    if from < to {
        let (a, b) = v.split_at_mut(to);
        (&a[from], &mut b[0])
    } else {
        let (a, b) = v.split_at_mut(from);
        (&b[0], &mut a[to])
    }
}

/// What a sync that uploads a device's pending book changes every
/// `cadence_s` seconds would send.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Uploads {
    pub cadence_s: i64,
    /// Upload batches of the book document, all devices, whole period.
    pub batches: usize,
    /// Of those, batches holding nothing but writing-day writes.
    pub writing_day_only: usize,
    /// Batches per working day (a day with at least one commit).
    pub per_working_day: f64,
    pub writing_day_only_per_working_day: f64,
    /// Sum of the commits' update bytes, and the writing-day share.
    pub bytes: u64,
    pub writing_day_bytes: u64,
}

/// Group `commits` into the batches a sync cycle of `cadence_s` seconds
/// would upload: one per device per cycle in which that device committed.
/// `cadence_s` 0 uploads every commit by itself.
pub fn uploads(commits: &[Commit], cadence_s: i64) -> Uploads {
    let mut batches: BTreeMap<(u8, i64, usize), bool> = BTreeMap::new();
    let mut days = std::collections::BTreeSet::new();
    let mut out = Uploads {
        cadence_s,
        ..Uploads::default()
    };
    for (i, c) in commits.iter().enumerate() {
        days.insert(c.ts.div_euclid(DAY_S));
        let key = if cadence_s == 0 {
            (c.device, c.ts, i)
        } else {
            (c.device, c.ts.div_euclid(cadence_s), 0)
        };
        let only = batches.entry(key).or_insert(true);
        *only &= c.kind == Kind::WritingDay;
        out.bytes += c.bytes as u64;
        if c.kind == Kind::WritingDay {
            out.writing_day_bytes += c.bytes as u64;
        }
    }
    out.batches = batches.len();
    out.writing_day_only = batches.values().filter(|only| **only).count();
    let working = days.len().max(1) as f64;
    out.per_working_day = out.batches as f64 / working;
    out.writing_day_only_per_working_day = out.writing_day_only as f64 / working;
    out
}
