//! History activation for the narrow, unformatted RightSurvivor prefix alias.
//! Only receipt-owned render items are removed. Immutable source evidence is
//! never undone, and handles contain portable identities rather than Doc refs.
use super::*;
use crate::relocation_alias::{self as alias, AliasRecord, Id, Span};
use std::sync::{Arc, Mutex};
use yrs::branch::BranchID;

#[derive(Clone)]
struct ItemSpan {
    id: Id,
    offset: u32,
    length: u32,
    plain: bool,
}

struct State {
    original: AliasRecord,
    source: Vec<u8>,
    joined: Vec<u8>,
    is_joined: bool,
    // The restored source must not acquire unrelated text before redo. Such
    // text would protect the source wrapper from UndoManager's deletion filter.
    source_base: Vec<ItemSpan>,
}

#[derive(Clone)]
pub(crate) struct HistoryHandle(Arc<Mutex<State>>);

pub(crate) struct PreparedHistory {
    handle: HistoryHandle,
    redo: bool,
    outgoing: Vec<u8>,
    ranges: Vec<(u32, u32)>,
    snapshot: yrs::Snapshot,
    incarnation: String,
    namespace: u64,
}

fn refused(message: &str) -> String {
    format!("{REMOTE_TEXT_RETENTION_REQUIRED}: {message}")
}

fn plus(id: Id, offset: u32) -> Result<Id, String> {
    Ok(Id {
        clock: id
            .clock
            .checked_add(offset)
            .ok_or_else(|| refused("History alias clock overflow"))?,
        ..id
    })
}

fn type_id(text: &XmlTextRef) -> Result<Id, String> {
    match <XmlTextRef as AsRef<yrs::branch::Branch>>::as_ref(text).id() {
        BranchID::Nested(id) => Ok(Id::from_yrs(id)),
        _ => Err(refused("History alias requires nested text")),
    }
}

fn text_by_id<T: ReadTxn>(txn: &T, id: Id) -> Result<XmlTextRef, String> {
    let branch = BranchID::Nested(id.yrs())
        .get_branch(txn)
        .ok_or_else(|| refused("Missing history alias text"))?;
    match XmlOut::try_from(branch) {
        Ok(XmlOut::Text(text)) if !branch.is_deleted() => Ok(text),
        _ => Err(refused("History alias text is not live")),
    }
}

fn resolve<T: ReadTxn>(txn: &T, encoded: &[u8]) -> Result<XmlTextRef, String> {
    let anchor = StickyIndex::decode_v1(encoded).map_err(|e| e.to_string())?;
    let at = anchor
        .get_offset(txn)
        .ok_or_else(|| refused("Missing history alias activation"))?;
    match XmlOut::try_from(at.branch) {
        Ok(XmlOut::Text(text)) if !at.branch.is_deleted() => Ok(text),
        _ => Err(refused("History alias activation is not live")),
    }
}

fn tape(txn: &mut yrs::TransactionMut, text: &XmlTextRef) -> Result<Vec<ItemSpan>, String> {
    let current = txn.snapshot();
    let empty = yrs::Snapshot::default();
    let mut offset = 0;
    text.diff_range(txn, Some(&current), Some(&empty), YChange::identity)
        .into_iter()
        .map(|run| {
            let Out::Any(Any::String(value)) = run.insert else {
                return Err(refused("Unsupported history alias content"));
            };
            let length = value.encode_utf16().count() as u32;
            let span = ItemSpan {
                id: Id::from_yrs(
                    run.ychange
                        .ok_or_else(|| refused("Missing history item identity"))?
                        .id,
                ),
                offset,
                length,
                plain: run
                    .attributes
                    .is_none_or(|attrs| attrs.values().all(|value| *value == Any::Null)),
            };
            offset += length;
            Ok(span)
        })
        .collect()
}

fn id_at(tape: &[ItemSpan], index: u32) -> Result<Id, String> {
    let run = tape
        .iter()
        .find(|run| run.offset <= index && index < run.offset + run.length)
        .ok_or_else(|| refused("History prefix no longer has a visible item"))?;
    plus(run.id, index - run.offset)
}

// Both affinities are required: a deleted original item can still resolve to
// a position, but it has no width and must never borrow a neighbour's identity.
fn live_item<T: ReadTxn>(
    txn: &T,
    text: &XmlTextRef,
    tape: &[ItemSpan],
    id: Id,
) -> Result<Id, String> {
    let left = StickyIndex::from_id(id.yrs(), Assoc::After)
        .get_offset(txn)
        .ok_or_else(|| refused("History prefix item is unavailable"))?;
    let right = StickyIndex::from_id(id.yrs(), Assoc::Before)
        .get_offset(txn)
        .ok_or_else(|| refused("History prefix item is unavailable"))?;
    let expected = <XmlTextRef as AsRef<yrs::branch::Branch>>::as_ref(text).id();
    if left.branch.id() != expected || right.branch != left.branch || right.index != left.index + 1
    {
        return Err(refused("History prefix item was removed or relocated"));
    }
    id_at(tape, left.index)
}

pub(crate) fn capture(
    txn: &mut yrs::TransactionMut,
    record: &AliasRecord,
) -> Result<HistoryHandle, String> {
    let source = text_by_id(txn, record.source_text)?;
    let target = text_by_id(txn, record.target_text)?;
    Ok(HistoryHandle(Arc::new(Mutex::new(State {
        original: record.clone(),
        source: StickyIndex::from_type(txn, &source, Assoc::Before).encode_v1(),
        joined: StickyIndex::from_type(txn, &target, Assoc::Before).encode_v1(),
        is_joined: true,
        source_base: tape(txn, &source)?,
    }))))
}

pub(crate) fn prepare(
    session: &DocumentSession,
    handle: &HistoryHandle,
    redo: bool,
) -> Result<PreparedHistory, String> {
    let state = handle.0.lock().unwrap();
    if state.is_joined == redo {
        return Err(refused(
            "History alias side does not match the requested action",
        ));
    }
    let outgoing = if redo { &state.source } else { &state.joined };
    let mut txn = session.doc.transact_mut_with(HISTORY_REPAIR);
    // Rematerialization requires a complete source graph. Refuse before the
    // owned render is removed, even when the missing update is unrelated prose.
    if txn.has_missing_updates() {
        return Err(refused("History alias is waiting for remote dependencies"));
    }
    let target = resolve(&txn, outgoing)?;
    let active = alias::active_records(&txn)?
        .into_iter()
        .find(|record| record.id == state.original.id)
        .ok_or_else(|| refused("Missing active history alias"))?;
    if active.target_text != type_id(&target)? {
        return Err(refused("History alias changed physical owner"));
    }
    let current = tape(&mut txn, &target)?;
    let renders = alias::rendered(&txn, &active.incarnation)?;
    // Activation is not permission to abandon a previous copy. An incomplete
    // remote activation packet may be retained, but history cannot silently
    // treat its old owned renders as unrelated aware-peer text.
    let live_types: std::collections::BTreeSet<_> = session
        .root
        .successors(&txn)
        .filter_map(|node| match node {
            XmlOut::Text(text) => type_id(&text).ok(),
            _ => None,
        })
        .collect();
    for old in alias::all_rendered(&txn)?
        .into_iter()
        .filter(|render| render.alias_id == active.id && render.incarnation != active.incarnation)
    {
        for offset in 0..old.length {
            let id = plus(old.target, offset)?.yrs();
            if let (Some(left), Some(right)) = (
                StickyIndex::from_id(id, Assoc::After).get_offset(&txn),
                StickyIndex::from_id(id, Assoc::Before).get_offset(&txn),
            ) {
                if left.branch == right.branch && right.index == left.index + 1 {
                    if let BranchID::Nested(id) = left.branch.id() {
                        if live_types.contains(&Id::from_yrs(id)) {
                            return Err(refused(
                                "Previous alias activation still has visible owned text",
                            ));
                        }
                    }
                }
            }
        }
    }
    let evidence = alias::evidence(&txn, active.source_text)?;
    let mut expected_source = yrs::IdSet::new();
    for source in &evidence {
        expected_source.insert(source.id.yrs(), source.text.encode_utf16().count() as u32);
    }
    let mut rendered_source = yrs::IdSet::new();
    for render in &renders {
        rendered_source.insert(render.source.yrs(), render.length);
    }
    if !expected_source.diff(&rendered_source).is_empty()
        || !rendered_source.diff(&expected_source).is_empty()
    {
        return Err(refused(
            "Active alias does not cover its retained source evidence",
        ));
    }
    let mut owned = yrs::IdSet::new();
    let mut ranges = Vec::new();
    for render in &renders {
        if render.alias_id != active.id {
            return Err(refused(
                "History render receipt belongs to a different alias",
            ));
        }
        let mut found = 0;
        for run in &current {
            if run.id.client != render.target.client {
                continue;
            }
            let start = run.id.clock.max(render.target.clock);
            let end = (run.id.clock + run.length).min(render.target.clock + render.length);
            if start < end {
                if !run.plain {
                    return Err(refused(
                        "A peer formatted an alias render; history must retain it",
                    ));
                }
                ranges.push((run.offset + start - run.id.clock, end - start));
                found += end - start;
            }
        }
        if found != render.length {
            return Err(refused(
                "A peer changed an alias render; history must retain it",
            ));
        }
        owned.insert(render.target.yrs(), render.length);
    }
    // Prove that the retained base prefix still consists of its own items.
    // Aware edits to other c/d items remain untouched by this history repair.
    for span in &active.spans {
        for offset in 0..span.length {
            live_item(&txn, &target, &current, plus(span.target, offset)?)?;
        }
    }
    if redo {
        let mut allowed = owned;
        for span in &state.source_base {
            for offset in 0..span.length {
                let id = live_item(&txn, &target, &current, plus(span.id, offset)?)?;
                allowed.insert(id.yrs(), 1);
            }
        }
        let visible = yrs::IdSet::from_iter(current.iter().map(|span| {
            (
                span.id.yrs().client,
                [span.id.clock..span.id.clock + span.length],
            )
        }));
        if !visible.diff(&allowed).is_empty() {
            return Err(refused(
                "Restored source contains non-alias peer text; redo must retain it",
            ));
        }
    }
    ranges.sort_unstable();
    if ranges
        .windows(2)
        .any(|pair| pair[0].0 + pair[0].1 > pair[1].0)
    {
        return Err(refused("Overlapping history render receipts"));
    }
    // Reserve an unused canonical client namespace before touching history.
    // The planner's collision guard must not first fail after UndoManager has
    // already moved the XML. No other writer can run inside this owner action.
    let source_clients: std::collections::BTreeSet<_> =
        evidence.iter().map(|item| item.id.client).collect();
    let vector = txn.state_vector();
    let (incarnation, namespace) = (0..64)
        .find_map(|_| {
            let uuid = uuid::Uuid::now_v7();
            let namespace = (u64::from_be_bytes(uuid.as_bytes()[8..16].try_into().unwrap())
                & ((1u64 << 53) - 1))
                .max(1);
            source_clients
                .iter()
                .all(|client| {
                    let mapped = *client ^ namespace;
                    mapped != session.doc.client_id().get()
                        && !source_clients.contains(&mapped)
                        && vector.get(&yrs::ClientID::new(mapped)) == 0
                })
                .then(|| (uuid.to_string(), namespace))
        })
        .ok_or_else(|| refused("No unused history alias namespace"))?;
    let snapshot = txn.snapshot();
    drop(txn);
    if !evidence.is_empty() {
        // A new namespace must replay every retained source interval. Prove
        // its gaps and immutable receipts before removing the outgoing render
        // or moving the UndoManager stack. Reuse the real pure planner against
        // the current live target; history will only replace its physical
        // destination and retained-prefix mapping after the structural action.
        let mut preflight = active;
        preflight.incarnation = incarnation.clone();
        preflight.namespace = namespace;
        alias::rematerialize(session, &preflight)?
            .ok_or_else(|| refused("History alias evidence cannot be rendered safely"))?;
    }
    Ok(PreparedHistory {
        handle: handle.clone(),
        redo,
        outgoing: outgoing.clone(),
        ranges,
        snapshot,
        incarnation,
        namespace,
    })
}

pub(crate) fn dematerialize(
    session: &DocumentSession,
    prepared: &PreparedHistory,
) -> Result<(), String> {
    let mut txn = session.doc.transact_mut_with(HISTORY_REPAIR);
    if txn.snapshot() != prepared.snapshot {
        return Err(refused("History alias preparation is stale"));
    }
    let text = resolve(&txn, &prepared.outgoing)?;
    for &(offset, length) in prepared.ranges.iter().rev() {
        text.remove_range(&mut txn, offset, length);
    }
    Ok(())
}

fn fresh_record(
    txn: &mut yrs::TransactionMut,
    state: &State,
    text: &XmlTextRef,
    joined: bool,
    incarnation: String,
    namespace: u64,
) -> Result<(AliasRecord, Vec<ItemSpan>), String> {
    let current = tape(txn, text)?;
    let mut spans: Vec<Span> = Vec::new();
    for span in &state.original.spans {
        for offset in 0..span.length {
            let source = plus(span.source, offset)?;
            let original = plus(if joined { span.target } else { span.source }, offset)?;
            let target = live_item(txn, text, &current, original)?;
            if let Some(last) = spans.last_mut() {
                if plus(last.source, last.length)? == source
                    && plus(last.target, last.length)? == target
                {
                    last.length += 1;
                    continue;
                }
            }
            spans.push(Span {
                source,
                target,
                length: 1,
            });
        }
    }
    // The original right boundary follows redone items. On the restored source
    // it is the original next character after the retained prefix, if any.
    let right_boundary = if joined {
        // Unselected c tail items keep their physical parent, even when an
        // aware peer deletes them. Their tombstones remain valid wire bounds.
        state.original.right_boundary
    } else {
        // For partial joins the source tail is deliberately not an alias range;
        // it is only the insertion boundary after the retained source prefix.
        let last = spans
            .last()
            .ok_or_else(|| refused("Empty history alias prefix"))?;
        let end = StickyIndex::from_id(plus(last.target, last.length - 1)?.yrs(), Assoc::Before)
            .get_offset(txn)
            .ok_or_else(|| refused("Missing history alias boundary"))?
            .index;
        if end < text.len(txn) {
            Some(id_at(&current, end)?)
        } else {
            None
        }
    };
    let mut record = state.original.clone();
    record.incarnation = incarnation;
    record.namespace = namespace;
    record.target_text = type_id(text)?;
    record.spans = spans;
    record.right_boundary = right_boundary;
    Ok((record, current))
}

pub(crate) fn finish(
    session: &DocumentSession,
    prepared: PreparedHistory,
    changed: bool,
) -> Result<(), String> {
    let mut state = prepared.handle.0.lock().unwrap();
    let joined = if changed {
        prepared.redo
    } else {
        state.is_joined
    };
    let anchor = if joined { &state.joined } else { &state.source };
    let (record, base) = {
        let mut txn = session.doc.transact_mut_with(HISTORY_REPAIR);
        let target = resolve(&txn, anchor)?;
        fresh_record(
            &mut txn,
            &state,
            &target,
            joined,
            prepared.incarnation,
            prepared.namespace,
        )?
    };
    // A namespace collision is fail-closed in the alias planner. Planning is
    // pure; activation and all derived render receipts publish in one txn.
    let has_evidence = !alias::evidence(&session.doc.transact(), record.source_text)?.is_empty();
    if has_evidence {
        let translation = alias::rematerialize(session, &record)?
            .ok_or_else(|| refused("History alias evidence cannot be rendered safely"))?;
        session
            .doc
            .transact_mut_with(HISTORY_REPAIR)
            .apply_update(
                Update::decode_v1(&translation.combined_update).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
    } else {
        // No source evidence means no render update; still persist the active
        // physical destination for an original-writer update arriving later.
        alias::set_active(&mut session.doc.transact_mut_with(HISTORY_REPAIR), &record)?;
    }
    state.is_joined = joined;
    if !joined {
        state.source_base = base;
    }
    // Retain the original source graph and copied-prefix anchors for all cycles.
    // Neither current activation nor a fresh namespace replaces that evidence.
    Ok(())
}

/// A relative position in a rendered late insertion follows its immutable
/// source item into the currently active copy. Ordinary text anchors retain
/// Yrs' standard behaviour, including awareness of remote c/d changes.
pub(crate) fn route_anchor<T: ReadTxn>(
    txn: &T,
    anchor: &StickyIndex,
) -> Result<Option<StickyIndex>, String> {
    let Some(id) = anchor.id().copied().map(Id::from_yrs) else {
        return Ok(None);
    };
    let rendered = alias::all_rendered(txn)?;
    let Some(old) = rendered.iter().find(|span| {
        span.target.client == id.client
            && span.target.clock <= id.clock
            && id.clock < span.target.clock + span.length
    }) else {
        return Ok(None);
    };
    let source = plus(old.source, id.clock - old.target.clock)?;
    let active = alias::active_records(txn)?
        .into_iter()
        .find(|record| record.id == old.alias_id)
        .ok_or_else(|| refused("Missing active alias for relative position"))?;
    let next = rendered
        .iter()
        .find(|span| {
            span.incarnation == active.incarnation
                && span.source.client == source.client
                && span.source.clock <= source.clock
                && source.clock < span.source.clock + span.length
        })
        .ok_or_else(|| refused("Missing active render for relative position"))?;
    Ok(Some(StickyIndex::from_id(
        plus(next.target, source.clock - next.source.clock)?.yrs(),
        anchor.assoc,
    )))
}
