//! Experimental command evidence, produced only by the public native command.
//! This is a command observation, not permission to route remote deletions.
use super::*;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use yrs::{branch::BranchID, IdSet, Origin, Snapshot, TransactionMut, ID};

const MAX_SAFE: u64 = 9_007_199_254_740_991;
const MAX_SNAPSHOT_BYTES: usize = 1024 * 1024;
const MAX_RANGES: usize = 100_000;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct NativeSourceId {
    client: u64,
    clock: u32,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct NativeSourceRange {
    client: u64,
    clock: u32,
    length: u32,
}

/// Exact version-1 public declaration shape; fields are not externally constructible.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTextDeleteIntent {
    version: u8,
    kind: &'static str,
    target_text: NativeSourceId,
    #[serde(rename = "offsetUTF16")]
    offset_utf16: u32,
    #[serde(rename = "lengthUTF16")]
    length_utf16: u32,
    selected_source_ranges: Vec<NativeSourceRange>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTransactionEvidence {
    version: u8,
    kind: &'static str,
    before_snapshot: Vec<u8>,
    transaction_deletes: Vec<NativeSourceRange>,
}

#[derive(Clone, Debug)]
pub struct NativeDeletionEvidence {
    transaction: NativeTransactionEvidence,
    intent: NativeTextDeleteIntent,
}

impl NativeDeletionEvidence {
    pub fn transaction(&self) -> &NativeTransactionEvidence {
        &self.transaction
    }
    pub fn intent(&self) -> &NativeTextDeleteIntent {
        &self.intent
    }
}

impl NativeTransactionEvidence {
    pub fn before_snapshot(&self) -> &[u8] {
        &self.before_snapshot
    }
    pub fn transaction_deletes(&self) -> &[NativeSourceRange] {
        &self.transaction_deletes
    }
}

impl NativeTextDeleteIntent {
    pub fn target_text(&self) -> &NativeSourceId {
        &self.target_text
    }
    pub fn offset_utf16(&self) -> u32 {
        self.offset_utf16
    }
    pub fn length_utf16(&self) -> u32 {
        self.length_utf16
    }
    pub fn selected_source_ranges(&self) -> &[NativeSourceRange] {
        &self.selected_source_ranges
    }
}

impl NativeSourceId {
    pub fn client(&self) -> u64 {
        self.client
    }
    pub fn clock(&self) -> u32 {
        self.clock
    }
}
impl NativeSourceRange {
    pub fn client(&self) -> u64 {
        self.client
    }
    pub fn clock(&self) -> u32 {
        self.clock
    }
    pub fn length(&self) -> u32 {
        self.length
    }
}

#[derive(Clone, Debug)]
pub struct CapturedAuthoredUpdate {
    pub(crate) update: Vec<u8>,
    pub(crate) deletion: Option<NativeDeletionEvidence>,
}
impl CapturedAuthoredUpdate {
    pub fn update(&self) -> &[u8] {
        &self.update
    }
    pub fn deletion(&self) -> Option<&NativeDeletionEvidence> {
        self.deletion.as_ref()
    }
    pub(crate) fn raw(update: Vec<u8>) -> Self {
        Self {
            update,
            deletion: None,
        }
    }
}

struct Candidate {
    before: Snapshot,
    selected: IdSet,
    evidence: NativeDeletionEvidence,
}

/// Private mapping input from the original command, never wire evidence.
pub(crate) struct DraftDeletionSelection {
    target: yrs::ID,
    selected: IdSet,
}

pub(crate) struct CommandState {
    pub(crate) origin: Origin,
    pub(crate) observed_events: usize,
    pub(crate) records: Vec<CapturedAuthoredUpdate>,
    candidate: Option<Candidate>,
}

/// Owns the pending publication. Drop always removes it and retains raw bytes.
/// A result cannot become classified until the entire public command succeeds.
pub(crate) struct NativeCommandScope {
    capture: Arc<Mutex<crate::capture::CaptureState>>,
    origin: Origin,
    finished: bool,
}

impl NativeCommandScope {
    pub(crate) fn begin(
        capture: &Arc<Mutex<crate::capture::CaptureState>>,
    ) -> Result<Self, String> {
        let origin: Origin = format!("native-command-delete:{}", uuid::Uuid::now_v7()).into();
        let mut state = capture.lock().unwrap();
        if state.command.is_some() || state.group.is_some() {
            return Err("Nested native command capture is not supported".into());
        }
        state.command = Some(CommandState {
            origin: origin.clone(),
            observed_events: 0,
            records: Vec::new(),
            candidate: None,
        });
        Ok(Self {
            capture: capture.clone(),
            origin,
            finished: false,
        })
    }

    pub(crate) fn origin(&self) -> Origin {
        self.origin.clone()
    }

    /// Called before remove_range in the same unique-origin transaction. Any
    /// unsupported representation remains an ordinary, unclassified edit.
    pub(crate) fn prepare(
        &self,
        txn: &mut TransactionMut,
        text: &XmlTextRef,
        offset: u32,
        length: u32,
    ) {
        let candidate = candidate(txn, text, offset, length).ok();
        let mut state = self.capture.lock().unwrap();
        if let Some(command) = &mut state.command {
            if command.origin == self.origin && command.observed_events == 0 {
                command.candidate = candidate;
            }
        }
    }

    /// Capture the explicit original command before the author branch mutates.
    /// The draft snapshot and offset are NOT copied into the live declaration.
    pub(crate) fn select_draft(
        &self,
        author: &DocumentSession,
        range: &NativeRange,
        replacement: &str,
    ) -> Option<DraftDeletionSelection> {
        if range.length == 0 || !replacement.is_empty() {
            return None;
        }
        let view = author.native_projection().ok()?;
        validate_range(&view.text, range.location, range.length).ok()?;
        let end = range.location.checked_add(range.length)?;
        let block = view.blocks.iter().find(|block| {
            block.editable
                && block.range.location <= range.location
                && end <= block.range.location + block.range.length
        })?;
        let mut txn = author
            .doc
            .transact_mut_with("native-draft-command-selection");
        let element = author.editable_block(&txn, block.id.as_deref()?).ok()?;
        let Some(XmlOut::Text(text)) = element.get(&txn, 0) else {
            return None;
        };
        if element.len(&txn) != 1 {
            return None;
        }
        let BranchID::Nested(target) =
            <XmlTextRef as AsRef<yrs::branch::Branch>>::as_ref(&text).id()
        else {
            return None;
        };
        let original = candidate(
            &mut txn,
            &text,
            range.location - block.range.location,
            range.length,
        )
        .ok()?;
        Some(DraftDeletionSelection {
            target,
            selected: original.selected,
        })
    }

    /// Classify the transformed effect only when the original still-visible
    /// IDs form one contiguous, plain range in the same live physical XmlText.
    /// Remote middle insertions are not swallowed to make a range contiguous.
    pub(crate) fn prepare_draft(
        &self,
        txn: &mut TransactionMut,
        original: &DraftDeletionSelection,
    ) {
        let prepared = translated_candidate(txn, original).ok();
        let mut state = self.capture.lock().unwrap();
        if let Some(command) = &mut state.command {
            if command.origin == self.origin && command.observed_events == 0 {
                command.candidate = prepared;
            }
        }
    }

    pub(crate) fn complete(mut self) {
        self.publish(true);
    }

    fn publish(&mut self, succeeded: bool) {
        if self.finished {
            return;
        }
        let mut state = self.capture.lock().unwrap();
        let mut command = state
            .command
            .take()
            .expect("native command scope owns its capture slot");
        assert_eq!(command.origin, self.origin);
        if !succeeded || command.observed_events != 1 || command.records.len() != 1 {
            for record in &mut command.records {
                record.deletion = None;
            }
        }
        state.ready.extend(command.records);
        self.finished = true;
    }
}
impl Drop for NativeCommandScope {
    fn drop(&mut self) {
        self.publish(false);
    }
}

/// Temporary undo ownership; the origin is excluded even during unwinding.
pub(crate) struct TrackedCommandOrigin<'a> {
    undo: &'a mut yrs::undo::UndoManager<crate::history::HistoryMeta>,
    origin: Origin,
}
impl<'a> TrackedCommandOrigin<'a> {
    pub(crate) fn new(
        undo: &'a mut yrs::undo::UndoManager<crate::history::HistoryMeta>,
        origin: Origin,
    ) -> Self {
        undo.include_origin(origin.clone());
        Self { undo, origin }
    }
}
impl Drop for TrackedCommandOrigin<'_> {
    fn drop(&mut self) {
        self.undo.exclude_origin(self.origin.clone());
    }
}

fn ranges(set: &IdSet) -> Vec<NativeSourceRange> {
    set.iter()
        .flat_map(|(client, ranges)| {
            ranges.iter().map(move |r| NativeSourceRange {
                client: client.get(),
                clock: r.start,
                length: r.end - r.start,
            })
        })
        .collect()
}

/// Yjs encodeSnapshot canonicalizes both client lists in descending order.
/// Yrs' generic Snapshot encoder uses its map iteration order instead. Reuse
/// its v1 primitive encoder while matching the published Yjs payload contract.
fn yjs_snapshot_v1(snapshot: &Snapshot) -> Vec<u8> {
    use yrs::encoding::write::Write;
    use yrs::updates::encoder::{Encoder, EncoderV1};
    let mut encoder = EncoderV1::new();
    let mut deletes: Vec<_> = snapshot.delete_set.iter().collect();
    deletes.sort_by_key(|(client, _)| std::cmp::Reverse(**client));
    encoder.write_var(deletes.len() as u32);
    for (client, ranges) in deletes {
        encoder.reset_ds_cur_val();
        encoder.write_var(client.get());
        let ranges: Vec<_> = ranges.iter().collect();
        encoder.write_var(ranges.len() as u32);
        for range in ranges {
            encoder.write_ds_clock(range.start);
            encoder.write_ds_len(range.end - range.start);
        }
    }
    let mut states: Vec<_> = snapshot.state_map.iter().collect();
    states.sort_by_key(|(client, _)| std::cmp::Reverse(**client));
    encoder.write_var(states.len() as u32);
    for (client, clock) in states {
        encoder.write_var(client.get());
        encoder.write_var(*clock);
    }
    encoder.to_vec()
}

fn candidate(
    txn: &mut TransactionMut,
    text: &XmlTextRef,
    offset: u32,
    length: u32,
) -> Result<Candidate, String> {
    if length == 0
        || !txn.insert_set().is_empty()
        || !txn.delete_set().is_empty()
        || txn.has_missing_updates()
    {
        return Err("Deletion requires an unchanged, complete source basis".into());
    }
    let BranchID::Nested(target) = <XmlTextRef as AsRef<yrs::branch::Branch>>::as_ref(text).id()
    else {
        return Err("Deletion requires an integrated XmlText identity".into());
    };
    let before = txn.snapshot();
    let bytes = yjs_snapshot_v1(&before);
    if bytes.len() > MAX_SNAPSHOT_BYTES || target.client.get() > MAX_SAFE {
        return Err("Evidence budget exceeded".into());
    }
    let end = offset.checked_add(length).ok_or("Selection overflow")?;
    let empty = Snapshot::default();
    let mut at: u32 = 0;
    let mut selected = IdSet::new();
    // Snapshot diff exposes the real source IDs, including discontiguous item
    // clocks. It does not identify intent; the explicit command already did.
    for run in text.diff_range(txn, Some(&before), Some(&empty), YChange::identity) {
        let Out::Any(Any::String(value)) = run.insert else {
            return Err("Non-plain source".into());
        };
        let width = u32::try_from(value.encode_utf16().count()).map_err(|_| "Text too long")?;
        let next = at.checked_add(width).ok_or("Text overflow")?;
        let start = at.max(offset);
        let stop = next.min(end);
        if start < stop {
            if run
                .attributes
                .is_some_and(|attrs| attrs.values().any(|value| *value != Any::Null))
            {
                return Err("Formatted source is not standalone plain deletion".into());
            }
            let id = run.ychange.ok_or("Missing source identity")?.id;
            if id.client.get() > MAX_SAFE {
                return Err("Unsafe source client".into());
            }
            let clock = id.clock.checked_add(start - at).ok_or("Clock overflow")?;
            clock.checked_add(stop - start).ok_or("Clock overflow")?;
            selected.insert(ID::new(id.client, clock), stop - start);
        }
        at = next;
    }
    let selected_ranges = ranges(&selected);
    if at < end
        || selected_ranges.len() > MAX_RANGES
        || selected_ranges
            .iter()
            .map(|r| u64::from(r.length))
            .sum::<u64>()
            != u64::from(length)
    {
        return Err("Selection is not exactly represented by source IDs".into());
    }
    Ok(Candidate {
        before,
        selected,
        evidence: NativeDeletionEvidence {
            transaction: NativeTransactionEvidence {
                version: 1,
                kind: "transaction-event",
                before_snapshot: bytes,
                transaction_deletes: selected_ranges.clone(),
            },
            intent: NativeTextDeleteIntent {
                version: 1,
                kind: "prose.text.delete",
                target_text: NativeSourceId {
                    client: target.client.get(),
                    clock: target.clock,
                },
                offset_utf16: offset,
                length_utf16: length,
                selected_source_ranges: selected_ranges,
            },
        },
    })
}

pub(crate) fn validate_event(
    command: &CommandState,
    txn: &TransactionMut,
    bytes: &[u8],
) -> Option<NativeDeletionEvidence> {
    let candidate = command.candidate.as_ref()?;
    if txn.origin() != Some(&command.origin)
        || txn.before_state() != &candidate.before.state_map
        || !txn.insert_set().is_empty()
        || txn.delete_set() != &candidate.selected
    {
        return None;
    }
    let update = Update::decode_v1(bytes).ok()?;
    // The first v1 varuint is the number of struct clients. Exact event bytes
    // are generated by Yrs; requiring zero also excludes Skip/GC structs.
    if bytes.first() != Some(&0) || update.delete_set() != &candidate.selected {
        return None;
    }
    let after = txn.snapshot();
    if after.state_map != candidate.before.state_map
        || after.delete_set != candidate.before.delete_set.merge(&candidate.selected)
    {
        return None;
    }
    Some(candidate.evidence.clone())
}

fn translated_candidate(
    txn: &mut TransactionMut,
    original: &DraftDeletionSelection,
) -> Result<Candidate, String> {
    let branch = BranchID::Nested(original.target)
        .get_branch(txn)
        .ok_or("Original draft text is missing")?;
    if branch.is_deleted() {
        return Err("Original draft text was retired".into());
    }
    let Ok(XmlOut::Text(text)) = XmlOut::try_from(branch) else {
        return Err("Draft target is not XmlText".into());
    };
    let before = txn.snapshot();
    let survivors = original.selected.diff(&before.delete_set);
    if survivors.is_empty() {
        return Err("Remote already removed all selected items".into());
    }
    let empty = Snapshot::default();
    let mut offset = 0u32;
    let mut start = None;
    let mut end = 0;
    let mut mapped = IdSet::new();
    let mut plain = String::new();
    for run in text.diff_range(txn, Some(&before), Some(&empty), YChange::identity) {
        let Out::Any(Any::String(value)) = run.insert else {
            return Err("Unsupported live content".into());
        };
        let width =
            u32::try_from(value.encode_utf16().count()).map_err(|_| "Live text too long")?;
        let id = run.ychange.ok_or("Missing live source identity")?.id;
        let mut span = IdSet::new();
        span.insert(id, width);
        let shared = span.intersect(&survivors);
        for (_, ranges) in shared.iter() {
            for range in ranges.iter() {
                let at = offset
                    .checked_add(range.start - id.clock)
                    .ok_or("Live range overflow")?;
                if start.is_some() && at != end {
                    return Err("Selected items are no longer contiguous in the live text".into());
                }
                start.get_or_insert(at);
                end = at
                    .checked_add(range.end - range.start)
                    .ok_or("Live range overflow")?;
            }
        }
        mapped.merge_with(shared);
        plain.push_str(&value);
        offset = offset.checked_add(width).ok_or("Live text overflow")?;
    }
    if mapped != survivors {
        return Err("Original selected items moved or are missing".into());
    }
    let start = start.ok_or("Empty transformed deletion")?;
    validate_range(&plain, start, end - start)?;
    let prepared = candidate(txn, &text, start, end - start)?;
    if prepared.selected != survivors {
        return Err("Transformed range includes unselected items".into());
    }
    Ok(prepared)
}
