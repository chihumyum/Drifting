//! Durable identity routing for an unformatted prefix copied by RightSurvivor.
//! Definitions/evidence survive undo. Activation and physical render ownership
//! are explicit; this module never clones an XML element or guesses by text.
use super::*;
mod gaps;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use yrs::block::{
    ClientID, ItemContent, BLOCK_GC_REF_NUMBER, BLOCK_SKIP_REF_NUMBER, HAS_ORIGIN, HAS_PARENT_SUB,
    HAS_RIGHT_ORIGIN,
};
use yrs::branch::BranchID;
use yrs::encoding::{read::Read, write::Write};
use yrs::updates::{
    decoder::{Decoder, DecoderV1},
    encoder::{Encoder, EncoderV1},
};
use yrs::{IdSet, Map as YMap, WriteTxn, ID};

pub(crate) const ROOT: &str = "drifting.native.relocation-alias.v1";
pub(crate) const ACTIVE_ROOT: &str = "drifting.native.relocation-active.v1";
const MAX_CLIENT: u64 = (1 << 53) - 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Id {
    pub client: u64,
    pub clock: u32,
}
impl Id {
    pub(crate) fn from_yrs(id: ID) -> Self {
        Self {
            client: id.client.get(),
            clock: id.clock,
        }
    }
    pub(crate) fn yrs(self) -> ID {
        ID::new(ClientID::new(self.client), self.clock)
    }
    fn key(self) -> String {
        format!("{}:{}", self.client, self.clock)
    }
    fn plus(self, offset: u32) -> Option<Self> {
        Some(Self {
            clock: self.clock.checked_add(offset)?,
            ..self
        })
    }
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Span {
    pub source: Id,
    pub target: Id,
    pub length: u32,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AliasRecord {
    pub id: String,
    pub incarnation: String,
    pub source_text: Id,
    pub target_text: Id,
    pub source_len: u32,
    pub retained_len: u32,
    pub namespace: u64,
    pub source_state: Vec<(u64, u32)>,
    pub spans: Vec<Span>,
    pub right_boundary: Option<Id>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SourceInsertion {
    pub source_text: Id,
    pub id: Id,
    pub text: String,
    pub origin: Option<Id>,
    pub right_origin: Option<Id>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RenderSpan {
    pub alias_id: String,
    pub incarnation: String,
    pub source: Id,
    pub target: Id,
    pub length: u32,
}
#[derive(Debug)]
pub(crate) struct Translation {
    pub combined_update: Vec<u8>,
    pub repair_update: Vec<u8>,
}

fn refused(message: &str) -> String {
    format!("{REMOTE_TEXT_RETENTION_REQUIRED}: {message}")
}
fn json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}
fn read_value<T: serde::de::DeserializeOwned>(value: Out) -> Result<T, String> {
    let Out::Any(Any::String(value)) = value else {
        return Err(refused("Invalid alias metadata type"));
    };
    serde_json::from_str(&value).map_err(|_| refused("Invalid alias metadata"))
}
fn read_prefix<T: ReadTxn, V: serde::de::DeserializeOwned>(
    txn: &T,
    prefix: &str,
) -> Result<Vec<V>, String> {
    let Some(map) = txn.get_map(ROOT) else {
        return Ok(Vec::new());
    };
    map.iter(txn)
        .filter(|(key, _)| key.starts_with(prefix))
        .map(|(_, value)| read_value(value))
        .collect()
}
fn immutable<T: Serialize>(
    txn: &mut yrs::TransactionMut,
    key: String,
    value: &T,
) -> Result<(), String> {
    let map = txn.get_or_insert_map(ROOT);
    let encoded = json(value)?;
    if let Some(existing) = map.get(txn, &key) {
        if existing != Out::Any(Any::String(encoded.clone().into())) {
            return Err(refused("Conflicting immutable alias evidence"));
        }
    } else {
        map.insert(txn, key, encoded);
    }
    Ok(())
}
pub(crate) fn defs<T: ReadTxn>(txn: &T) -> Result<Vec<AliasRecord>, String> {
    let records = read_prefix(txn, "definition/")?;
    for record in &records {
        validate_record(record)?;
    }
    Ok(records)
}
pub(crate) fn active_records<T: ReadTxn>(txn: &T) -> Result<Vec<AliasRecord>, String> {
    let Some(map) = txn.get_map(ACTIVE_ROOT) else {
        return Ok(Vec::new());
    };
    map.iter(txn)
        .map(|(key, value)| {
            let record: AliasRecord = read_value(value)?;
            validate_record(&record)?;
            if key != record.source_text.key() {
                return Err(refused("Alias activation key mismatch"));
            }
            Ok(record)
        })
        .collect()
}
pub(crate) fn set_active(
    txn: &mut yrs::TransactionMut,
    record: &AliasRecord,
) -> Result<(), String> {
    validate_record(record)?;
    let map = txn.get_or_insert_map(ACTIVE_ROOT);
    map.insert(txn, record.source_text.key(), json(record)?);
    Ok(())
}
pub(crate) fn record(txn: &mut yrs::TransactionMut, record: &AliasRecord) -> Result<(), String> {
    validate_record(record)?;
    immutable(txn, format!("definition/{}", record.id), record)?;
    set_active(txn, record)
}
pub(crate) fn evidence<T: ReadTxn>(
    txn: &T,
    source_text: Id,
) -> Result<Vec<SourceInsertion>, String> {
    let values: Vec<SourceInsertion> = read_prefix(txn, &format!("source/{}/", source_text.key()))?;
    for value in &values {
        let length = u32::try_from(value.text.encode_utf16().count())
            .map_err(|_| refused("Source evidence length overflow"))?;
        if value.source_text != source_text
            || value.id.client > MAX_CLIENT
            || value.origin.is_some_and(|id| id.client > MAX_CLIENT)
            || value.right_origin.is_some_and(|id| id.client > MAX_CLIENT)
            || length == 0
            || value.id.plus(length).is_none()
        {
            return Err(refused("Invalid source insertion evidence"));
        }
    }
    // Packet boundaries are not identities: A then AB and one AB checkpoint
    // can create overlapping receipts on different receivers. Normalize their
    // immutable source graph before rematerializing, and reject disagreement.
    let mut units: BTreeMap<Id, SourceInsertion> = BTreeMap::new();
    for value in values {
        let mut offset = 0;
        for scalar in value.text.chars() {
            let id = value.id.plus(offset).unwrap();
            let part = SourceInsertion {
                source_text: value.source_text,
                id,
                text: scalar.to_string(),
                origin: if offset == 0 {
                    value.origin
                } else {
                    Some(value.id.plus(offset - 1).unwrap())
                },
                right_origin: value.right_origin,
            };
            if units.get(&id).is_some_and(|old| old != &part) {
                return Err(refused("Conflicting source clock evidence"));
            }
            units.insert(id, part);
            offset += scalar.len_utf16() as u32;
        }
    }
    let mut normalized: Vec<SourceInsertion> = Vec::new();
    for part in units.into_values() {
        if let Some(previous) = normalized.last_mut() {
            let length = previous.text.encode_utf16().count() as u32;
            if previous.id.client == part.id.client {
                let end = previous.id.clock + length;
                if part.id.clock < end {
                    return Err(refused("Overlapping source Unicode evidence"));
                }
                if part.id.clock == end
                    && part.origin == previous.id.plus(length - 1)
                    && part.right_origin == previous.right_origin
                {
                    previous.text.push_str(&part.text);
                    continue;
                }
            }
        }
        normalized.push(part);
    }
    Ok(normalized)
}
pub(crate) fn rendered<T: ReadTxn>(txn: &T, incarnation: &str) -> Result<Vec<RenderSpan>, String> {
    let spans: Vec<RenderSpan> = read_prefix(txn, &format!("render/{incarnation}/"))?;
    if spans.iter().any(|span| span.incarnation != incarnation) {
        return Err(refused("Render incarnation key mismatch"));
    }
    normalize_rendered(spans)
}
pub(crate) fn all_rendered<T: ReadTxn>(txn: &T) -> Result<Vec<RenderSpan>, String> {
    normalize_rendered(read_prefix(txn, "render/")?)
}
fn normalize_rendered(mut spans: Vec<RenderSpan>) -> Result<Vec<RenderSpan>, String> {
    for span in &spans {
        if span.source.client > MAX_CLIENT
            || span.target.client > MAX_CLIENT
            || span.length == 0
            || span.source.plus(span.length).is_none()
            || span.target.plus(span.length).is_none()
        {
            return Err(refused("Invalid render ownership span"));
        }
    }
    spans.sort_by(|a, b| (&a.incarnation, a.source).cmp(&(&b.incarnation, b.source)));
    let mut normalized: Vec<RenderSpan> = Vec::new();
    for span in spans {
        if let Some(previous) = normalized.last_mut() {
            if previous.incarnation == span.incarnation
                && previous.source.client == span.source.client
                && span.source.clock <= previous.source.clock + previous.length
            {
                let offset = span.source.clock - previous.source.clock;
                if previous.alias_id != span.alias_id
                    || previous.target.plus(offset) != Some(span.target)
                {
                    if span.source.clock < previous.source.clock + previous.length {
                        return Err(refused("Conflicting render ownership"));
                    }
                } else {
                    previous.length = previous.length.max(offset + span.length);
                    continue;
                }
            }
        }
        normalized.push(span);
    }
    Ok(normalized)
}
pub(crate) fn write_rendered(
    txn: &mut yrs::TransactionMut,
    span: &RenderSpan,
) -> Result<(), String> {
    immutable(
        txn,
        format!(
            "render/{}/{}/{}",
            span.incarnation,
            span.source.key(),
            span.length
        ),
        span,
    )
}
fn validate_record(record: &AliasRecord) -> Result<(), String> {
    if record.id.is_empty()
        || record.incarnation.is_empty()
        || record.namespace == 0
        || record.namespace > MAX_CLIENT
        || record.retained_len == 0
        || record.retained_len > record.source_len
        || record.source_text == record.target_text
        || record.source_text.client > MAX_CLIENT
        || record.target_text.client > MAX_CLIENT
        || record
            .right_boundary
            .is_some_and(|id| id.client > MAX_CLIENT)
        || record
            .source_state
            .iter()
            .any(|(client, _)| *client > MAX_CLIENT)
        || record
            .source_state
            .windows(2)
            .any(|pair| pair[0].0 >= pair[1].0)
    {
        return Err(refused("Invalid relocation alias"));
    }
    let mut length = 0u32;
    for span in &record.spans {
        if span.length == 0
            || span.source.client > MAX_CLIENT
            || span.target.client > MAX_CLIENT
            || span.source.plus(span.length).is_none()
            || span.target.plus(span.length).is_none()
        {
            return Err(refused("Invalid alias clock span"));
        }
        length = length
            .checked_add(span.length)
            .ok_or_else(|| refused("Alias length overflow"))?;
    }
    if length != record.retained_len {
        return Err(refused("Incomplete retained prefix mapping"));
    }
    for (index, span) in record.spans.iter().enumerate() {
        for other in &record.spans[..index] {
            let overlaps = |a: Id, an: u32, b: Id, bn: u32| {
                a.client == b.client && a.clock < b.clock + bn && b.clock < a.clock + an
            };
            if overlaps(span.source, span.length, other.source, other.length)
                || overlaps(span.target, span.length, other.target, other.length)
            {
                return Err(refused("Overlapping alias clock spans"));
            }
        }
    }
    Ok(())
}

struct Tape {
    id: Id,
    text: String,
    length: u32,
    plain: bool,
}
fn tape(txn: &mut yrs::TransactionMut, text: &XmlTextRef) -> Result<Vec<Tape>, String> {
    let current = txn.snapshot();
    let empty = yrs::Snapshot::default();
    text.diff_range(txn, Some(&current), Some(&empty), YChange::identity)
        .into_iter()
        .map(|run| {
            let Out::Any(Any::String(value)) = run.insert else {
                return Err(refused("Unsupported alias text item"));
            };
            let id = run
                .ychange
                .ok_or_else(|| refused("Missing alias item identity"))?
                .id;
            Ok(Tape {
                id: Id::from_yrs(id),
                length: value.encode_utf16().count() as u32,
                text: value.to_string(),
                plain: run
                    .attributes
                    .is_none_or(|attrs| attrs.values().all(|value| *value == Any::Null)),
            })
        })
        .collect()
}
fn type_id(text: &XmlTextRef) -> Result<Id, String> {
    match <XmlTextRef as AsRef<yrs::branch::Branch>>::as_ref(text).id() {
        BranchID::Nested(id) => Ok(Id::from_yrs(id)),
        _ => Err(refused("Alias requires nested XML text")),
    }
}
fn slice(value: &str, start: u32, length: u32) -> Result<String, String> {
    let units: Vec<_> = value.encode_utf16().collect();
    let end = start
        .checked_add(length)
        .ok_or_else(|| refused("Alias text length overflow"))?;
    String::from_utf16(
        units
            .get(start as usize..end as usize)
            .ok_or_else(|| refused("Alias text slice outside item"))?,
    )
    .map_err(|_| refused("Alias slice divides a surrogate pair"))
}
/// Call after copying the prefix and before deleting its source wrapper.
pub(crate) fn can_capture<T: ReadTxn>(txn: &T, source: &XmlTextRef, retained_len: u32) -> bool {
    if retained_len == 0 || retained_len > source.len(txn) {
        return false;
    }
    let mut remaining = retained_len;
    for run in source.diff(txn, YChange::identity) {
        let Out::Any(Any::String(value)) = run.insert else {
            return false;
        };
        let length = (value.encode_utf16().count() as u32).min(remaining);
        if run
            .attributes
            .is_some_and(|attrs| attrs.values().any(|value| *value != Any::Null))
            || slice(&value, 0, length).is_err()
        {
            return false;
        }
        remaining -= length;
        if remaining == 0 {
            return true;
        }
    }
    false
}

/// Call after copying the prefix and before deleting its source wrapper.
pub(crate) fn capture_plan(
    txn: &mut yrs::TransactionMut,
    source: &XmlTextRef,
    target: &XmlTextRef,
    retained_len: u32,
    namespace: u64,
) -> Result<AliasRecord, String> {
    let source_tape = tape(txn, source)?;
    let target_tape = tape(txn, target)?;
    let mut spans = Vec::new();
    let (mut si, mut ti, mut so, mut to, mut count) = (0, 0, 0, 0, 0);
    while count < retained_len {
        let a = source_tape
            .get(si)
            .ok_or_else(|| refused("Missing source prefix"))?;
        let b = target_tape
            .get(ti)
            .ok_or_else(|| refused("Missing copied prefix"))?;
        let length = (a.length - so).min(b.length - to).min(retained_len - count);
        if !a.plain || !b.plain || slice(&a.text, so, length)? != slice(&b.text, to, length)? {
            return Err(refused(
                "Alias requires the exact unformatted copied prefix",
            ));
        }
        spans.push(Span {
            source: a.id.plus(so).unwrap(),
            target: b.id.plus(to).unwrap(),
            length,
        });
        count += length;
        so += length;
        to += length;
        if so == a.length {
            si += 1;
            so = 0;
        }
        if to == b.length {
            ti += 1;
            to = 0;
        }
    }
    let source_text = type_id(source)?;
    let target_text = type_id(target)?;
    let id = format!(
        "{}>{}:{}",
        source_text.key(),
        target_text.key(),
        spans.first().map(|s| s.target.key()).unwrap_or_default()
    );
    let mut source_state: Vec<_> = txn
        .state_vector()
        .iter()
        .map(|(client, clock)| (client.get(), *clock))
        .collect();
    source_state.sort_unstable();
    let record = AliasRecord {
        id: id.clone(),
        incarnation: id,
        source_text,
        target_text,
        source_len: source.len(txn),
        retained_len,
        namespace,
        source_state,
        spans,
        right_boundary: target_tape.get(ti).and_then(|run| run.id.plus(to)),
    };
    validate_record(&record)?;
    Ok(record)
}

#[derive(Clone)]
struct WireString {
    id: Id,
    text: String,
    origin: Option<Id>,
    right: Option<Id>,
    parent: Option<Id>,
}
struct Parsed {
    strings: Vec<WireString>,
    other: IdSet,
}
fn parse(bytes: &[u8]) -> Result<Parsed, String> {
    let mut decoder = DecoderV1::from(bytes);
    let work = |decoder: &mut DecoderV1| -> Result<Parsed, yrs::encoding::read::Error> {
        let clients: u32 = decoder.read_var()?;
        let mut parsed = Parsed {
            strings: Vec::new(),
            other: IdSet::new(),
        };
        for _ in 0..clients {
            let blocks: u32 = decoder.read_var()?;
            let client = decoder.read_client()?;
            let mut clock: u32 = decoder.read_var()?;
            for _ in 0..blocks {
                let info = decoder.read_info()?;
                let mut string = None;
                let length = match info {
                    BLOCK_SKIP_REF_NUMBER => decoder.read_var()?,
                    BLOCK_GC_REF_NUMBER => decoder.read_len()?,
                    _ => {
                        let origin = if info & HAS_ORIGIN != 0 {
                            Some(Id::from_yrs(decoder.read_left_id()?))
                        } else {
                            None
                        };
                        let right = if info & HAS_RIGHT_ORIGIN != 0 {
                            Some(Id::from_yrs(decoder.read_right_id()?))
                        } else {
                            None
                        };
                        let explicit = info & (HAS_ORIGIN | HAS_RIGHT_ORIGIN) == 0;
                        let parent = if explicit {
                            if decoder.read_parent_info()? {
                                decoder.read_string()?;
                                None
                            } else {
                                Some(Id::from_yrs(decoder.read_left_id()?))
                            }
                        } else {
                            None
                        };
                        if explicit && info & HAS_PARENT_SUB != 0 {
                            decoder.read_string()?;
                        }
                        let content = ItemContent::decode(decoder, info)?;
                        let length = content.len(OffsetKind::Utf16);
                        if let ItemContent::String(value) = content {
                            if info & HAS_PARENT_SUB == 0 {
                                string = Some(WireString {
                                    id: Id {
                                        client: client.get(),
                                        clock,
                                    },
                                    text: value.as_str().to_string(),
                                    origin,
                                    right,
                                    parent,
                                });
                            }
                        }
                        length
                    }
                };
                let end = clock.checked_add(length).ok_or_else(|| {
                    yrs::encoding::read::Error::Custom("Alias clock overflow".into())
                })?;
                if let Some(value) = string {
                    parsed.strings.push(value);
                } else if info != BLOCK_SKIP_REF_NUMBER {
                    parsed.other.insert(ID::new(client, clock), length);
                }
                clock = end;
            }
        }
        Ok(parsed)
    };
    work(&mut decoder).map_err(|e| refused(&format!("Cannot inspect alias insertion: {e}")))
}

fn mapped(spans: &[Span], id: Id) -> Option<Id> {
    spans.iter().find_map(|span| {
        (span.source.client == id.client
            && span.source.clock <= id.clock
            && id.clock < span.source.clock + span.length)
            .then(|| span.target.plus(id.clock - span.source.clock))
            .flatten()
    })
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Allocation {
    incarnation: String,
    source_client: u64,
}

pub(crate) fn plan(
    session: &DocumentSession,
    incoming: &Update,
    loss: &IdSet,
) -> Result<Option<Translation>, String> {
    plan_inner(session, incoming, None, Some(loss))
}

/// Reuse the immutable source graph when history changes the physical target.
/// A new activation must supply a fresh, persisted namespace and exact mapping
/// of the original retained prefix to its current render item identities.
pub(crate) fn rematerialize(
    session: &DocumentSession,
    record: &AliasRecord,
) -> Result<Option<Translation>, String> {
    let values = evidence(&session.doc.transact(), record.source_text)?;
    if values.is_empty() {
        return Ok(None);
    }
    let strings: Vec<_> = values
        .into_iter()
        .map(|value| WireString {
            id: value.id,
            text: value.text,
            origin: value.origin,
            right: value.right_origin,
            parent: Some(value.source_text),
        })
        .collect();
    let update = Update::decode_v1(&gaps::encode(&strings, &IdSet::new(), &IdSet::new(), true)?)
        .map_err(|e| e.to_string())?;
    plan_inner(session, &update, Some(record), None)
}

fn plan_inner(
    session: &DocumentSession,
    incoming: &Update,
    reactivation: Option<&AliasRecord>,
    loss: Option<&IdSet>,
) -> Result<Option<Translation>, String> {
    let txn = session.doc.transact();
    if txn.store().pending_ds().is_some() || (reactivation.is_some() && txn.has_missing_updates()) {
        return Ok(None);
    }
    let merged;
    let incoming = if let Some(pending) = txn.store().pending_update() {
        merged = Update::merge_updates([
            Update::decode_v1(&pending.update.encode_v1()).map_err(|e| e.to_string())?,
            Update::decode_v1(&incoming.encode_v1()).map_err(|e| e.to_string())?,
        ]);
        &merged
    } else {
        incoming
    };
    let records = match reactivation {
        Some(record) => vec![record.clone()],
        None => active_records(&txn)?,
    };
    if records.is_empty() {
        return Ok(None);
    }
    let state = txn.state_vector();
    let known = IdSet::from_iter(state.iter().map(|(client, clock)| (*client, [0..*clock])));
    if !incoming
        .delete_set()
        .diff(&txn.snapshot().delete_set)
        .is_empty()
    {
        return Ok(None);
    }
    let raw = incoming.encode_v1();
    let parsed = parse(&raw)?;
    if !parsed.other.diff(&known).is_empty() {
        return Ok(None);
    }
    // History reactivation deliberately replays already-covered source IDs.
    // Ordinary reception translates only raw strings that would be lost;
    // unrelated live-parent strings remain untouched in the original update.
    let mut novel = Vec::new();
    for mut value in parsed.strings {
        let length = value.text.encode_utf16().count() as u32;
        let known_clock = state.get(&ClientID::new(
            value.id.client ^ reactivation.map(|record| record.namespace).unwrap_or(0),
        ));
        let offset = known_clock.saturating_sub(value.id.clock).min(length);
        if offset == length {
            continue;
        }
        if offset > 0 {
            value.text = slice(&value.text, offset, length - offset)?;
            value.id = value.id.plus(offset).unwrap();
            value.origin = Some(Id {
                clock: value.id.clock - 1,
                ..value.id
            });
        }
        if let Some(loss) = loss {
            let mut span = IdSet::new();
            span.insert(value.id.yrs(), value.text.encode_utf16().count() as u32);
            if span.intersect(loss).is_empty() {
                continue;
            }
            // Never classify a partly-lost span as safe or split it by guessed
            // offsets. The combined retention check also covers unmapped loss.
            if !span.diff(loss).is_empty() {
                return Ok(None);
            }
        }
        novel.push(value);
    }
    if novel.is_empty() {
        return Ok(None);
    }
    let mut maps = Vec::new();
    for record in &records {
        validate_record(record)?;
        let mut spans = record.spans.clone();
        spans.extend(
            rendered(&txn, &record.incarnation)?
                .into_iter()
                .map(|span| Span {
                    source: span.source,
                    target: span.target,
                    length: span.length,
                }),
        );
        let Some(branch) = BranchID::Nested(record.target_text.yrs()).get_branch(&txn) else {
            return Ok(None);
        };
        if branch.is_deleted() || !matches!(XmlOut::try_from(branch), Ok(XmlOut::Text(_))) {
            return Ok(None);
        }
        maps.push(spans);
    }
    let mut assignments = vec![None; novel.len()];
    for _ in 0..=novel.len() {
        let mut progress = false;
        for (i, value) in novel.iter().enumerate() {
            if assignments[i].is_some() {
                continue;
            }
            let candidates: Vec<_> = records
                .iter()
                .enumerate()
                .filter(|(n, record)| {
                    value.parent == Some(record.source_text)
                        || value
                            .origin
                            .is_some_and(|id| mapped(&maps[*n], id).is_some())
                        || value
                            .right
                            .is_some_and(|id| mapped(&maps[*n], id).is_some())
                })
                .map(|(n, _)| n)
                .collect();
            if candidates.len() > 1 {
                return Ok(None);
            }
            if candidates.len() != 1 {
                continue;
            }
            let n = candidates[0];
            let target = Id {
                client: value.id.client ^ records[n].namespace,
                clock: value.id.clock,
            };
            maps[n].push(Span {
                source: value.id,
                target,
                length: value.text.encode_utf16().count() as u32,
            });
            assignments[i] = Some(n);
            progress = true;
        }
        if assignments.iter().all(Option::is_some) {
            break;
        }
        if !progress {
            return Ok(None);
        }
    }
    // Prove safe gaps only in the complete raw candidate. This still rejects
    // an integrated lost b string mixed with unrelated unresolved pending text.
    let mut options = Options::with_client_id(session.doc.client_id());
    options.offset_kind = OffsetKind::Utf16;
    let candidate = Doc::with_options(options);
    candidate
        .transact_mut()
        .apply_update(Update::decode_v1(&session.update(None, 1)?).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    candidate
        .transact_mut()
        .apply_update(Update::decode_v1(&raw).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if candidate.transact().has_missing_updates() {
        return Ok(None);
    }
    let metadata = txn.get_map(ROOT);
    let mut allocations: BTreeMap<u64, Allocation> = BTreeMap::new();
    let mut coverage = IdSet::new();
    let mut skip_receipts = Vec::new();
    let mut next_clock = BTreeMap::new();
    let mut translated = Vec::new();
    let mut sources = Vec::new();
    let mut renders = Vec::new();
    let mut deleted = IdSet::new();
    let mut order: Vec<_> = (0..novel.len()).collect();
    order.sort_by_key(|i| novel[*i].id);
    for i in order {
        let value = &novel[i];
        let n = assignments[i].unwrap();
        let record = &records[n];
        let client = value.id.client ^ record.namespace;
        let allocation = Allocation {
            incarnation: record.incarnation.clone(),
            source_client: value.id.client,
        };
        let key = format!("allocation/{client}");
        let persisted = metadata
            .as_ref()
            .and_then(|map| map.get(&txn, &key))
            .map(read_value::<Allocation>)
            .transpose()?;
        if persisted.as_ref().is_some_and(|old| old != &allocation)
            || allocations
                .get(&client)
                .is_some_and(|old| old != &allocation)
            || client == session.doc.client_id().get()
            || incoming.state_vector().get(&ClientID::new(client)) > 0
            || (state.get(&ClientID::new(client)) > 0 && persisted.is_none())
        {
            return Err(refused("Canonical alias client collision"));
        }
        allocations.insert(client, allocation);
        let start = *next_clock.entry(client).or_insert_with(|| {
            let integrated = state.get(&ClientID::new(client));
            if integrated > 0 {
                integrated
            } else {
                let clock = record
                    .source_state
                    .iter()
                    .find(|(id, _)| *id == value.id.client)
                    .map(|(_, clock)| *clock)
                    .unwrap_or(0);
                if clock > 0 {
                    coverage.insert(ID::new(ClientID::new(client), 0), clock);
                }
                clock
            }
        });
        if value.id.clock < start {
            return Ok(None);
        }
        if value.id.clock > start {
            let Some(proved) = gaps::prove(
                &candidate,
                record,
                &maps[n],
                Id {
                    client: value.id.client,
                    clock: start,
                },
                value.id.clock - start,
            )?
            else {
                return Ok(None);
            };
            skip_receipts.extend(proved);
            coverage.insert(
                ID::new(ClientID::new(client), start),
                value.id.clock - start,
            );
        }
        let length = value.text.encode_utf16().count() as u32;
        next_clock.insert(
            client,
            value
                .id
                .clock
                .checked_add(length)
                .ok_or_else(|| refused("Alias clock overflow"))?,
        );
        let origin = match value.origin {
            Some(id) => match mapped(&maps[n], id) {
                Some(id) => Some(id),
                None => return Ok(None),
            },
            None => None,
        };
        let right = match value.right {
            Some(id) => match mapped(&maps[n], id) {
                Some(id) => Some(id),
                None => return Ok(None),
            },
            None => {
                if record.retained_len == record.source_len {
                    record.right_boundary
                } else {
                    return Ok(None);
                }
            }
        };
        let target = Id {
            client,
            clock: value.id.clock,
        };
        translated.push(WireString {
            id: target,
            text: value.text.clone(),
            origin,
            right,
            parent: Some(record.target_text),
        });
        sources.push(SourceInsertion {
            source_text: record.source_text,
            id: value.id,
            text: value.text.clone(),
            origin: value.origin,
            right_origin: value.right,
        });
        renders.push(RenderSpan {
            alias_id: record.id.clone(),
            incarnation: record.incarnation.clone(),
            source: value.id,
            target,
            length,
        });
        deleted.insert(value.id.yrs(), length);
    }
    drop(txn);
    let canonical = gaps::encode(&translated, &coverage, &deleted, false)?;
    candidate
        .transact_mut()
        .apply_update(Update::decode_v1(&canonical).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let metadata_update = {
        let mut txn = candidate.transact_mut();
        if txn.has_missing_updates() {
            return Ok(None);
        }
        for (n, record) in records.iter().enumerate() {
            if !assignments.contains(&Some(n)) {
                continue;
            }
            let branch = BranchID::Nested(record.target_text.yrs())
                .get_branch(&txn)
                .ok_or_else(|| refused("Alias target disappeared"))?;
            let live = tape(&mut txn, &XmlTextRef::from(branch))?;
            for (i, value) in translated
                .iter()
                .enumerate()
                .filter(|(i, _)| renders[*i].incarnation == record.incarnation)
            {
                let span = &renders[i];
                let mut found = 0;
                for run in &live {
                    if run.id.client != span.target.client {
                        continue;
                    }
                    let start = run.id.clock.max(span.target.clock);
                    let end = (run.id.clock + run.length).min(span.target.clock + span.length);
                    if start < end {
                        if !run.plain
                            || slice(&run.text, start - run.id.clock, end - start)?
                                != slice(&value.text, start - span.target.clock, end - start)?
                        {
                            return Ok(None);
                        }
                        found += end - start;
                    }
                }
                if found != span.length {
                    return Ok(None);
                }
            }
        }
        if let Some(record) = reactivation {
            set_active(&mut txn, record)?;
        }
        for (client, allocation) in allocations {
            immutable(&mut txn, format!("allocation/{client}"), &allocation)?;
        }
        for source in &sources {
            immutable(
                &mut txn,
                format!(
                    "source/{}/{}/{}",
                    source.source_text.key(),
                    source.id.key(),
                    source.text.encode_utf16().count()
                ),
                source,
            )?;
        }
        for render in &renders {
            write_rendered(&mut txn, render)?;
        }
        for span in &skip_receipts {
            gaps::write(&mut txn, span)?;
        }
        txn.encode_update_v1()
    };
    let repair = Update::merge_updates([
        Update::decode_v1(&canonical).unwrap(),
        Update::decode_v1(&metadata_update).unwrap(),
    ]);
    let combined = Update::merge_updates([
        Update::decode_v1(&raw).unwrap(),
        Update::decode_v1(&repair.encode_v1()).unwrap(),
    ]);
    Ok(Some(Translation {
        combined_update: combined.encode_v1(),
        repair_update: repair.encode_v1(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(session: &DocumentSession, incoming: &Update) -> Result<Option<Translation>, String> {
        let loss = retention::loss_spans(session, incoming)?;
        super::plan(session, incoming, &loss)
    }

    fn open(bytes: &[u8], client: u64) -> DocumentSession {
        let mut doc = DocumentSession::with_test_client_id(client).unwrap();
        doc.apply_remote(bytes, 1).unwrap();
        doc
    }
    fn text(doc: &DocumentSession, id: &str) -> XmlTextRef {
        let txn = doc.doc.transact();
        let block = doc.find_block(&txn, id).unwrap();
        let Some(XmlOut::Text(text)) = block.get(&txn, 0) else {
            panic!("text")
        };
        text
    }
    fn fixture(partial: bool) -> (DocumentSession, Vec<u8>, AliasRecord) {
        let seed = DocumentSession::with_test_client_id(7701).unwrap();
        {
            let mut txn = seed.doc.transact_mut();
            for (id, entries) in [
                ("left", vec![("b", "潮汐")]),
                ("right", vec![("c", "夜航"), ("d", "尾声")]),
            ] {
                let quote = seed
                    .root
                    .push_back(&mut txn, XmlElementPrelim::empty("blockquote"));
                quote.insert_attribute(&mut txn, "id", id);
                for (id, value) in entries {
                    let block = quote.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
                    block.insert_attribute(&mut txn, "id", id);
                    block.push_back(&mut txn, XmlTextPrelim::new(value));
                }
            }
        }
        let old = seed.update(None, 1).unwrap();
        let doc = open(&old, 7702);
        let source = text(&doc, "b");
        let target = text(&doc, "c");
        let record;
        {
            let mut txn = doc.doc.transact_mut_with(LOCAL);
            if partial {
                target.remove_range(&mut txn, 0, 1);
            }
            target.insert(&mut txn, 0, if partial { "潮" } else { "潮汐" });
            record = capture_plan(
                &mut txn,
                &source,
                &target,
                if partial { 1 } else { 2 },
                1 << 49,
            )
            .unwrap();
            super::record(&mut txn, &record).unwrap();
            doc.find_block(&txn, "c")
                .unwrap()
                .insert_attribute(&mut txn, "id", "b");
            doc.find_block(&txn, "right")
                .unwrap()
                .insert_attribute(&mut txn, "id", "left");
            doc.root.remove_range(&mut txn, 0, 1);
        }
        (doc, old, record)
    }
    fn insertion(doc: &DocumentSession, at: u32, value: &str) -> Vec<u8> {
        let text = text(doc, "b");
        let mut txn = doc.doc.transact_mut();
        text.insert(&mut txn, at, value);
        txn.encode_update_v1()
    }
    fn translated(doc: &mut DocumentSession, update: &[u8]) -> Translation {
        let old = doc.update(None, 1).unwrap();
        let result = plan(doc, &Update::decode_v1(update).unwrap())
            .unwrap()
            .expect("supported alias insertion");
        assert_eq!(old, doc.update(None, 1).unwrap(), "plan mutated live");
        doc.apply_remote(&result.combined_update, 1).unwrap();
        result
    }
    fn visible(doc: &DocumentSession) -> String {
        doc.native_projection().unwrap().text
    }
    fn unique_ids(doc: &DocumentSession) {
        let view = doc.native_projection().unwrap();
        let ids: std::collections::HashSet<_> = view.blocks.iter().map(|b| b.id.clone()).collect();
        assert_eq!(view.blocks.len(), ids.len());
    }

    #[test]
    fn relocation_alias_two_receivers_translate_same_source_without_duplicate_characters() {
        for partial in [false, true] {
            let (joined, old, record) = fixture(partial);
            let late = open(&old, 7711);
            let update = insertion(&late, 0, "保🙂e\u{301}");
            let base = joined.update(None, 1).unwrap();
            let mut a = open(&base, 7712);
            let mut b = open(&base, 7713);
            let ta = translated(&mut a, &update);
            let tb = translated(&mut b, &update);
            a.apply_remote(&tb.combined_update, 1).unwrap();
            b.apply_remote(&ta.combined_update, 1).unwrap();
            let expected = if partial {
                "保🙂e\u{301}潮航\n尾声"
            } else {
                "保🙂e\u{301}潮汐夜航\n尾声"
            };
            assert_eq!(visible(&a), expected);
            assert_eq!(visible(&b), expected);
            unique_ids(&a);
            unique_ids(&b);
            assert_eq!(
                rendered(&a.doc.transact(), &record.incarnation).unwrap(),
                rendered(&b.doc.transact(), &record.incarnation).unwrap()
            );
            assert_eq!(
                evidence(&a.doc.transact(), record.source_text)
                    .unwrap()
                    .len(),
                1
            );
            assert!(plan(&a, &Update::decode_v1(&update).unwrap())
                .unwrap()
                .is_none());
            a.apply_remote(&update, 1).unwrap();
            assert_eq!(visible(&a), expected);
            let reopened = open(&a.update(None, 1).unwrap(), 7714);
            assert_eq!(visible(&reopened), expected);
            assert_eq!(
                active_records(&reopened.doc.transact()).unwrap(),
                vec![record]
            );
            assert!(plan(
                &reopened,
                &Update::decode_v1(&late.update(None, 1).unwrap()).unwrap()
            )
            .unwrap()
            .is_none());
        }
    }

    #[test]
    fn relocation_alias_full_state_coalescing_and_v2_keep_original_clock_coverage() {
        let (mut joined, old, record) = fixture(true);
        let late = open(&old, 7721);
        let first = insertion(&late, 0, "甲");
        translated(&mut joined, &first);
        insertion(&late, 1, "🙂乙");
        let full = late.update(None, 1).unwrap();
        let v2 = Update::decode_v1(&full).unwrap().encode_v2();
        let normalized = DocumentSession::normalize_update(&v2, 2).unwrap();
        translated(&mut joined, &normalized);
        assert_eq!(visible(&joined), "甲🙂乙潮航\n尾声");
        assert_eq!(
            evidence(&joined.doc.transact(), record.source_text)
                .unwrap()
                .len(),
            1
        );
        let mut reopened = open(&joined.update(None, 1).unwrap(), 7722);
        reopened.apply_remote(&full, 1).unwrap();
        assert_eq!(visible(&reopened), visible(&joined));
    }

    #[test]
    fn relocation_alias_maps_immutable_origins_for_opposite_arrival_orders() {
        let (joined, old, _) = fixture(false);
        let left = open(&old, 7731);
        let right = open(&old, 7732);
        let updates = [insertion(&left, 0, "甲"), insertion(&right, 0, "乙")];
        let base = joined.update(None, 1).unwrap();
        let mut results = Vec::new();
        for order in [[0, 1], [1, 0]] {
            let mut doc = open(&base, 7733 + order[0] as u64);
            for i in order {
                translated(&mut doc, &updates[i]);
            }
            results.push(visible(&doc));
        }
        assert_eq!(results[0], results[1]);
        assert!(results[0].contains('甲') && results[0].contains('乙'));
    }

    #[test]
    fn relocation_alias_known_source_clock_prefix_is_gc_covered_but_unknown_holes_are_not() {
        let (mut joined, old, record) = fixture(false);
        // The original seed writer has a complete, registered pre-join prefix.
        let writer = open(&old, 7701);
        let update = insertion(&writer, 0, "源");
        translated(&mut joined, &update);
        assert!(visible(&joined).starts_with("源潮汐"));
        let allocation = ClientID::new(7701 ^ record.namespace);
        assert!(
            joined.doc.transact().state_vector().get(&allocation)
                > record
                    .source_state
                    .iter()
                    .find(|(id, _)| *id == 7701)
                    .unwrap()
                    .1
        );
        // A new writer used an unrelated root before the event we received.
        let unknown = open(&old, 7741);
        unknown.doc.get_or_insert_text("other").insert(
            &mut unknown.doc.transact_mut(),
            0,
            "missing",
        );
        let packet = insertion(&unknown, 0, "晚");
        let before = joined.update(None, 1).unwrap();
        assert!(plan(&joined, &Update::decode_v1(&packet).unwrap())
            .unwrap()
            .is_none());
        assert_eq!(before, joined.update(None, 1).unwrap());
    }

    #[test]
    fn relocation_alias_collision_and_nonplain_insertions_remain_unapplied() {
        let (joined, old, record) = fixture(false);
        let late = open(&old, 7751);
        let update = insertion(&late, 0, "保");
        let collision = 7751 ^ record.namespace;
        let collider = Doc::with_client_id(collision);
        let root = collider.get_or_insert_text("collision");
        root.insert(&mut collider.transact_mut(), 0, "x");
        let mut target = open(&joined.update(None, 1).unwrap(), 7752);
        target
            .apply_remote(
                &collider
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default()),
                1,
            )
            .unwrap();
        let before = target.update(None, 1).unwrap();
        assert!(plan(&target, &Update::decode_v1(&update).unwrap())
            .unwrap_err()
            .contains("collision"));
        assert_eq!(before, target.update(None, 1).unwrap());
        let styled = open(&old, 7753);
        let t = text(&styled, "b");
        let raw = {
            let mut txn = styled.doc.transact_mut();
            t.insert_with_attributes(
                &mut txn,
                0,
                "粗",
                Attrs::from([("bold".into(), Any::Bool(true))]),
            );
            txn.encode_update_v1()
        };
        assert!(plan(&joined, &Update::decode_v1(&raw).unwrap())
            .unwrap()
            .is_none());
        assert!(defs(&joined.doc.transact()).unwrap().len() == 1);
    }

    #[test]
    fn relocation_alias_reactivation_reuses_source_graph_and_commits_activation_with_render() {
        let (mut joined, old, record) = fixture(false);
        let late = open(&old, 7761);
        translated(&mut joined, &insertion(&late, 0, "甲"));
        translated(&mut joined, &insertion(&late, 1, "🙂乙"));
        let mut next = record.clone();
        {
            let target = text(&joined, "b");
            let mut txn = joined.doc.transact_mut();
            target.remove_range(&mut txn, 0, 4);
            let block = joined
                .root
                .push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            block.insert_attribute(&mut txn, "id", "restored");
            let restored = block.push_back(&mut txn, XmlTextPrelim::new("潮汐"));
            let restored_tape = tape(&mut txn, &restored).unwrap();
            let mut offset = 0;
            for span in &mut next.spans {
                span.target = restored_tape[0].id.plus(offset).unwrap();
                offset += span.length;
            }
            next.target_text = type_id(&restored).unwrap();
            next.right_boundary = None;
            next.namespace = 1 << 48;
            next.incarnation.push_str(".restored");
        }
        let before = joined.update(None, 1).unwrap();
        let planned = rematerialize(&joined, &next).unwrap().unwrap();
        assert_eq!(before, joined.update(None, 1).unwrap());
        joined.apply_remote(&planned.combined_update, 1).unwrap();
        assert_eq!(
            plain_text(&text(&joined, "restored"), &joined.doc.transact()).unwrap(),
            "甲🙂乙潮汐"
        );
        assert_eq!(
            active_records(&joined.doc.transact()).unwrap(),
            vec![next.clone()]
        );
        assert_eq!(
            rendered(&joined.doc.transact(), &next.incarnation)
                .unwrap()
                .len(),
            1
        );
        assert!(rematerialize(&joined, &next).unwrap().is_none());
        let reopened = open(&joined.update(None, 1).unwrap(), 7762);
        assert_eq!(
            evidence(&reopened.doc.transact(), record.source_text)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            active_records(&reopened.doc.transact()).unwrap(),
            vec![next]
        );
    }

    #[test]
    fn relocation_alias_overlapping_receipt_segmentations_converge_after_exchange() {
        let (joined, old, record) = fixture(true);
        let late = open(&old, 7771);
        let first = insertion(&late, 0, "甲");
        let base = joined.update(None, 1).unwrap();
        let mut a = open(&base, 7772);
        let first_repair = translated(&mut a, &first);
        insertion(&late, 1, "🙂乙");
        let full = late.update(None, 1).unwrap();
        let second_repair = translated(&mut a, &full);
        let mut b = open(&base, 7773);
        let full_repair = translated(&mut b, &full);
        a.apply_remote(&full_repair.combined_update, 1).unwrap();
        b.apply_remote(&first_repair.combined_update, 1).unwrap();
        b.apply_remote(&second_repair.combined_update, 1).unwrap();
        assert_eq!(visible(&a), "甲🙂乙潮航\n尾声");
        assert_eq!(visible(&a), visible(&b));
        for doc in [a, b] {
            let reopened = open(&doc.update(None, 1).unwrap(), 7774);
            let source = evidence(&reopened.doc.transact(), record.source_text).unwrap();
            assert_eq!(source.len(), 1);
            assert_eq!(source[0].text, "甲🙂乙");
            let owned = rendered(&reopened.doc.transact(), &record.incarnation).unwrap();
            assert_eq!(owned.len(), 1);
            assert_eq!(owned[0].length, 4);
            assert_eq!(all_rendered(&reopened.doc.transact()).unwrap(), owned);
        }
    }

    #[test]
    fn relocation_alias_malformed_metadata_leaves_live_unchanged() {
        let (joined, old, record) = fixture(false);
        let late = open(&old, 7781);
        let raw = insertion(&late, 0, "保");
        for variant in 0..4 {
            let doc = open(&joined.update(None, 1).unwrap(), 7782 + variant);
            let mut value = serde_json::to_value(&record).unwrap();
            match variant {
                0 => value["namespace"] = json!(0),
                1 => value["source_text"]["client"] = json!(MAX_CLIENT + 1),
                2 => {
                    value["spans"][0]["source"]["clock"] = json!(u32::MAX);
                }
                _ => value["futureField"] = json!(true),
            }
            doc.doc.get_or_insert_map(ACTIVE_ROOT).insert(
                &mut doc.doc.transact_mut(),
                record.source_text.key(),
                value.to_string(),
            );
            let before = doc.update(None, 1).unwrap();
            assert!(plan(&doc, &Update::decode_v1(&raw).unwrap())
                .unwrap_err()
                .starts_with(REMOTE_TEXT_RETENTION_REQUIRED));
            assert_eq!(before, doc.update(None, 1).unwrap());
        }
    }

    fn mixed_fixture(partial: bool) -> (DocumentSession, Vec<u8>, AliasRecord) {
        let (_, old, _) = fixture(false);
        let seed = open(&old, 7800);
        let suffix = text(&seed, "d");
        {
            let mut txn = seed.doc.transact_mut();
            suffix.format(
                &mut txn,
                0,
                2,
                Attrs::from([("bold".into(), Any::Bool(true))]),
            );
            suffix.insert_attribute(&mut txn, "future-text", Any::Bool(true));
        }
        let old = seed.update(None, 1).unwrap();
        let mut live = open(&old, 7801);
        live.replace_native(NativeReplacement {
            revision: live.revision,
            range: NativeRange {
                location: if partial { 1 } else { 2 },
                length: if partial { 3 } else { 1 },
            },
            text: String::new(),
        })
        .unwrap();
        let record = active_records(&live.doc.transact()).unwrap().pop().unwrap();
        (live, old, record)
    }

    fn insert_suffix(doc: &DocumentSession, value: &str) -> Vec<u8> {
        let target = text(doc, "d");
        let mut txn = doc.doc.transact_mut();
        target.insert(&mut txn, 1, value);
        txn.encode_update_v1()
    }

    type ExactSuffix = (
        Id,
        Id,
        Vec<(Id, String, Option<Box<Attrs>>)>,
        BTreeMap<String, Any>,
    );
    fn exact_suffix(doc: &DocumentSession) -> ExactSuffix {
        let target = text(doc, "d");
        let mut txn = doc.doc.transact_mut();
        let block = doc.find_block(&txn, "d").unwrap();
        let branch: &yrs::branch::Branch = block.as_ref();
        let BranchID::Nested(block_id) = branch.id() else {
            panic!("nested block");
        };
        let current = txn.snapshot();
        let empty = yrs::Snapshot::default();
        let runs = target
            .diff_range(&mut txn, Some(&current), Some(&empty), YChange::identity)
            .into_iter()
            .map(|run| {
                let Out::Any(Any::String(value)) = run.insert else {
                    panic!("text");
                };
                (
                    Id::from_yrs(run.ychange.unwrap().id),
                    value.to_string(),
                    run.attributes,
                )
            })
            .collect();
        let attrs = target
            .attributes(&txn)
            .map(|(key, value)| {
                let Out::Any(value) = value else {
                    panic!("typed attribute");
                };
                (key.to_string(), value)
            })
            .collect();
        (
            Id::from_yrs(block_id),
            type_id(&target).unwrap(),
            runs,
            attrs,
        )
    }

    fn track_mixed_suffix(doc: &mut DocumentSession, quote: &str) {
        let view = doc.native_projection().unwrap();
        let suffix = view
            .blocks
            .iter()
            .find(|b| b.id.as_deref() == Some("d"))
            .unwrap();
        let length = quote.encode_utf16().count() as u32;
        doc.set_selection(NativeSelectionRequest {
            view_id: "mixed-suffix".into(),
            epoch: 1,
            revision: doc.revision,
            range: NativeRange {
                location: suffix.range.location + 1,
                length,
            },
        })
        .unwrap();
        doc.set_comment_anchors(vec![CommentAnchorRecord {
            id: "mixed-suffix".into(),
            target_block_id: Some("d".into()),
            target_block_ids_json: json!(["d"]).to_string(),
            anchor_json: json!({"future":true,"selectedText":quote,"textAnchor":{
                "startBlockId":"d","startOffset":1,"endBlockId":"d",
                "endOffset":1+length,"text":quote
            }})
            .to_string(),
        }])
        .unwrap();
    }

    fn assert_mixed_suffix(doc: &DocumentSession, expected: &ExactSuffix, quote: &str) {
        assert_eq!(
            &exact_suffix(doc),
            expected,
            "safe suffix IDs, marks and attributes changed"
        );
        let view = doc.native_projection().unwrap();
        let units: Vec<_> = view.text.encode_utf16().collect();
        for comment in &view.comments {
            assert_eq!(comment.status, "anchored");
            let selected = comment
                .ranges
                .iter()
                .map(|range| {
                    String::from_utf16(
                        &units[range.location as usize..(range.location + range.length) as usize],
                    )
                    .unwrap()
                })
                .collect::<String>();
            assert_eq!(selected, quote);
        }
        for selection in &view.selections {
            let range = selection.range.as_ref().unwrap();
            assert_eq!(
                String::from_utf16(
                    &units[range.location as usize..(range.location + range.length) as usize]
                )
                .unwrap(),
                quote
            );
        }
        for record in doc.comment_anchor_records() {
            assert_eq!(
                serde_json::from_str::<Value>(&record.anchor_json).unwrap()["future"],
                true
            );
        }
        unique_ids(doc);
        assert!(!doc.has_pending());
    }

    fn assert_mixed_rejection(doc: &mut DocumentSession, raw: &[u8]) {
        let state = doc.update(None, 1).unwrap();
        let projection = serde_json::to_value(doc.native_projection().unwrap()).unwrap();
        let history = [doc.undo.undo_stack(), doc.undo.redo_stack()].map(|stack| {
            stack
                .iter()
                .map(|item| (item.deletions().clone(), item.insertions().clone()))
                .collect::<Vec<_>>()
        });
        let comments = doc.comment_anchor_records();
        let error = doc.apply_remote(raw, 1).unwrap_err();
        assert!(error.starts_with(REMOTE_TEXT_RETENTION_REQUIRED), "{error}");
        assert_eq!(doc.update(None, 1).unwrap(), state);
        assert_eq!(
            serde_json::to_value(doc.native_projection().unwrap()).unwrap(),
            projection
        );
        assert_eq!(doc.comment_anchor_records(), comments);
        assert_eq!(
            [doc.undo.undo_stack(), doc.undo.redo_stack()].map(|stack| {
                stack
                    .iter()
                    .map(|item| (item.deletions().clone(), item.insertions().clone()))
                    .collect::<Vec<_>>()
            }),
            history
        );
    }

    #[test]
    fn relocation_alias_mixed_different_writers_preserve_safe_identity_marks_and_history() {
        for partial in [false, true] {
            let (mut live, old, record) = mixed_fixture(partial);
            let prefix = open(&old, 7811);
            let suffix = open(&old, 7812);
            let b = insertion(&prefix, 0, "保🙂");
            let d = insert_suffix(&suffix, "远🙂e\u{301}");
            let expected_suffix = exact_suffix(&suffix);
            assert!(expected_suffix
                .2
                .iter()
                .any(|(id, value, attrs)| id.client == 7812
                    && value == "远🙂e\u{301}"
                    && attrs
                        .as_ref()
                        .is_some_and(|a| a.get("bold") == Some(&Any::Bool(true)))));
            let suffix_anchor = suffix.anchor("d", 1, false).unwrap();
            let raw = Update::merge_updates([
                Update::decode_v1(&b).unwrap(),
                Update::decode_v1(&d).unwrap(),
            ])
            .encode_v1();
            let loss = retention::loss_spans(&live, &Update::decode_v1(&raw).unwrap()).unwrap();
            assert!(loss.contains(&ID::new(ClientID::new(7811), 0)));
            assert!(!loss.contains(&ID::new(ClientID::new(7812), 0)));
            let base = live.update(None, 1).unwrap();
            let mut other = open(&base, 7813);
            let prepared = live.prepare_remote(&raw, 1).unwrap();
            let repair = Update::decode_v1(prepared.repair_update().unwrap()).unwrap();
            assert!(!repair
                .delete_set()
                .contains(&ID::new(ClientID::new(7812), 0)));
            live.apply_prepared_remote(&prepared).unwrap();
            other.apply_remote(&d, 1).unwrap();
            other
                .apply_remote(&Update::decode_v1(&b).unwrap().encode_v2(), 2)
                .unwrap();
            live.apply_remote(&other.update(None, 1).unwrap(), 1)
                .unwrap();
            other
                .apply_remote(&live.update(None, 1).unwrap(), 1)
                .unwrap();
            assert_eq!(live.semantic().unwrap(), other.semantic().unwrap());
            assert_eq!(
                evidence(&live.doc.transact(), record.source_text)
                    .unwrap()
                    .len(),
                1
            );
            track_mixed_suffix(&mut live, "远🙂e\u{301}");
            for action in 0..5 {
                if action > 0 {
                    assert!(if action % 2 == 1 {
                        live.try_undo()
                    } else {
                        live.try_redo()
                    }
                    .unwrap());
                }
                assert!(visible(&live).starts_with("保🙂潮"));
                assert_mixed_suffix(&live, &expected_suffix, "远🙂e\u{301}");
                assert_eq!(
                    live.resolve_anchor(&suffix_anchor).unwrap().unwrap(),
                    json!({"block":"d","offset":1})
                );
                let before = live.update(None, 1).unwrap();
                live.apply_remote(&raw, 1).unwrap();
                assert_eq!(live.update(None, 1).unwrap(), before);
                let mut reopened = open(&before, 7814);
                reopened
                    .set_comment_anchors(live.comment_anchor_records())
                    .unwrap();
                reopened
                    .apply_remote(&prefix.update(None, 1).unwrap(), 1)
                    .unwrap();
                reopened
                    .apply_remote(&suffix.update(None, 1).unwrap(), 1)
                    .unwrap();
                assert_mixed_suffix(&reopened, &expected_suffix, "远🙂e\u{301}");
                assert_eq!(reopened.semantic().unwrap(), live.semantic().unwrap());
            }
        }
    }

    #[test]
    fn relocation_alias_mixed_same_writer_prefix_then_suffix_preserves_safe_clocks() {
        let (mut live, old, record) = mixed_fixture(false);
        let peer = open(&old, 7821);
        let b = insertion(&peer, 0, "保");
        let d = insert_suffix(&peer, "远");
        let expected = exact_suffix(&peer);
        let packet = Update::merge_updates([
            Update::decode_v1(&b).unwrap(),
            Update::decode_v1(&d).unwrap(),
        ])
        .encode_v1();
        live.apply_remote(&packet, 1).unwrap();
        track_mixed_suffix(&mut live, "远");
        for action in 0..5 {
            if action > 0 {
                assert!(if action % 2 == 1 {
                    live.try_undo()
                } else {
                    live.try_redo()
                }
                .unwrap());
            }
            assert_mixed_suffix(&live, &expected, "远");
            let active = active_records(&live.doc.transact()).unwrap().pop().unwrap();
            assert_eq!(
                live.doc
                    .transact()
                    .state_vector()
                    .get(&ClientID::new(7821 ^ active.namespace)),
                1
            );
            let owned = rendered(&live.doc.transact(), &active.incarnation).unwrap();
            assert_eq!(owned.iter().map(|s| s.length).sum::<u32>(), 1);
            assert_eq!(
                evidence(&live.doc.transact(), record.source_text).unwrap()[0].text,
                "保"
            );
            let before = live.update(None, 1).unwrap();
            live.apply_remote(&peer.update(None, 1).unwrap(), 1)
                .unwrap();
            assert_eq!(before, live.update(None, 1).unwrap());
        }
        // Original clock 1 belongs to live d. It must never be silently filled
        // in the canonical client when the same writer later returns to b.
        let following = insertion(&peer, 1, "续");
        live.apply_remote(&following, 1).unwrap();
        assert!(!gaps::read(&live.doc.transact(), &record)
            .unwrap()
            .is_empty());
        assert_mixed_suffix(&live, &expected, "远");
        let mut reopened = open(&live.update(None, 1).unwrap(), 7822);
        reopened
            .apply_remote(&peer.update(None, 1).unwrap(), 1)
            .unwrap();
        assert_eq!(exact_suffix(&reopened), expected);
    }

    #[test]
    fn relocation_alias_mixed_same_writer_interleaved_safe_clocks_require_exact_proof() {
        for prefix_first in [false, true] {
            let (mut live, old, _) = mixed_fixture(false);
            let peer = open(&old, 7831);
            if prefix_first {
                insertion(&peer, 0, "保");
            }
            insert_suffix(&peer, "远");
            insertion(&peer, if prefix_first { 1 } else { 0 }, "续");
            live.apply_remote(&peer.update(None, 1).unwrap(), 1)
                .unwrap();
            assert_eq!(exact_suffix(&live), exact_suffix(&peer));
        }
    }

    #[test]
    fn relocation_alias_mixed_safe_text_does_not_hide_unmapped_loss_format_or_delete() {
        for unsupported in 0..3 {
            let (mut live, old, _) = mixed_fixture(true);
            let prefix = open(&old, 7841);
            let suffix = open(&old, 7842);
            let unsafe_peer = open(&old, 7843);
            let b = insertion(&prefix, 0, "保");
            let d = insert_suffix(&suffix, "远");
            let bad = match unsupported {
                0 => insertion(&unsafe_peer, 2, "缺"), // outside retained original-b prefix
                1 => {
                    let t = text(&unsafe_peer, "b");
                    let mut txn = unsafe_peer.doc.transact_mut();
                    t.insert_with_attributes(
                        &mut txn,
                        0,
                        "粗",
                        Attrs::from([("bold".into(), Any::Bool(true))]),
                    );
                    txn.encode_update_v1()
                }
                _ => {
                    let t = text(&unsafe_peer, "d");
                    let mut txn = unsafe_peer.doc.transact_mut();
                    t.remove_range(&mut txn, 0, 1);
                    txn.encode_update_v1()
                }
            };
            let packet =
                Update::merge_updates([b, d, bad].iter().map(|u| Update::decode_v1(u).unwrap()))
                    .encode_v1();
            let before = exact_suffix(&live);
            assert_mixed_rejection(&mut live, &packet);
            assert_eq!(exact_suffix(&live), before);
        }
    }

    #[test]
    fn safe_clock_gaps_same_writer_complete_split_reversed_and_history() {
        for partial in [false, true] {
            for pattern in ["db", "bdb"] {
                for schedule in 0..4 {
                    let (mut live, old, record) = mixed_fixture(partial);
                    let peer = open(&old, 7901);
                    let mut packets = Vec::new();
                    let mut count = 0;
                    for op in pattern.chars() {
                        packets.push(if op == 'd' {
                            insert_suffix(&peer, "远🙂e\u{301}")
                        } else {
                            count += 1;
                            insertion(&peer, 0, if count == 1 { "保" } else { "续" })
                        });
                    }
                    let expected = exact_suffix(&peer);
                    let suffix_anchor = peer.anchor("d", 1, false).unwrap();
                    let merged = Update::merge_updates(
                        packets.iter().map(|p| Update::decode_v1(p).unwrap()),
                    )
                    .encode_v1();
                    match schedule {
                        0 => live.apply_remote(&merged, 1).unwrap(),
                        1 => {
                            for packet in &packets {
                                live.apply_remote(packet, 1).unwrap();
                            }
                        }
                        _ => {
                            if pattern == "db" {
                                // Independent same-writer predecessors become
                                // Yrs Skip, not pending: retain then full retry.
                                assert_mixed_rejection(&mut live, packets.last().unwrap());
                                live.apply_remote(&merged, 1).unwrap();
                            } else if schedule == 3 {
                                for packet in packets.iter().rev() {
                                    live.apply_remote(packet, 1).unwrap();
                                }
                            } else {
                                live.apply_remote(packets.last().unwrap(), 1).unwrap();
                                assert!(live.has_pending());
                                let dependencies = Update::merge_updates(
                                    packets[..2].iter().map(|p| Update::decode_v1(p).unwrap()),
                                )
                                .encode_v1();
                                live.apply_remote(&dependencies, 1).unwrap();
                            }
                        }
                    }
                    let expected_prefix = if pattern == "db" {
                        "保潮"
                    } else {
                        "续保潮"
                    };
                    assert!(
                        visible(&live).starts_with(expected_prefix),
                        "{pattern}/{schedule}"
                    );
                    let receipt = gaps::read(&live.doc.transact(), &record).unwrap();
                    assert!(!receipt.is_empty());
                    track_mixed_suffix(&mut live, "远🙂e\u{301}");
                    for step in 0..5 {
                        if step > 0 {
                            assert!(if step % 2 == 1 {
                                live.try_undo()
                            } else {
                                live.try_redo()
                            }
                            .unwrap());
                        }
                        assert!(visible(&live).starts_with(expected_prefix));
                        assert_mixed_suffix(&live, &expected, "远🙂e\u{301}");
                        assert_eq!(
                            live.resolve_anchor(&suffix_anchor).unwrap().unwrap(),
                            json!({"block":"d","offset":1})
                        );
                        let before = live.update(None, 1).unwrap();
                        live.apply_remote(&merged, 1).unwrap();
                        live.apply_remote(&peer.update(None, 1).unwrap(), 1)
                            .unwrap();
                        assert_eq!(live.update(None, 1).unwrap(), before);
                        let mut reopened = open(&before, 7902);
                        reopened
                            .set_comment_anchors(live.comment_anchor_records())
                            .unwrap();
                        assert_eq!(
                            gaps::read(&reopened.doc.transact(), &record).unwrap(),
                            receipt
                        );
                        assert_mixed_suffix(&reopened, &expected, "远🙂e\u{301}");
                        assert_eq!(reopened.semantic().unwrap(), live.semantic().unwrap());
                    }
                }
            }
        }
    }

    #[test]
    fn safe_clock_gaps_two_receivers_exchange_repairs_and_later_return_to_b() {
        let (mut a, old, record) = mixed_fixture(false);
        let base = a.update(None, 1).unwrap();
        let mut b = open(&base, 7912);
        let peer = open(&old, 7911);
        let first = insertion(&peer, 0, "保");
        let safe = insert_suffix(&peer, "远🙂");
        let mixed = Update::merge_updates([
            Update::decode_v1(&first).unwrap(),
            Update::decode_v1(&safe).unwrap(),
        ])
        .encode_v1();
        a.apply_remote(&mixed, 1).unwrap();
        b.apply_remote(&first, 1).unwrap();
        b.apply_remote(&safe, 1).unwrap();
        assert!(gaps::read(&a.doc.transact(), &record).unwrap().is_empty());
        let following = insertion(&peer, 1, "续");
        let pa = a.prepare_remote(&following, 1).unwrap();
        let pb = b.prepare_remote(&peer.update(None, 1).unwrap(), 1).unwrap();
        a.apply_prepared_remote(&pa).unwrap();
        b.apply_prepared_remote(&pb).unwrap();
        a.apply_remote(pb.update(), 1).unwrap();
        b.apply_remote(pa.update(), 1).unwrap();
        assert_eq!(visible(&a), "保续潮汐夜航\n尾远🙂声");
        assert_eq!(a.semantic().unwrap(), b.semantic().unwrap());
        assert_eq!(
            gaps::read(&a.doc.transact(), &record).unwrap(),
            gaps::read(&b.doc.transact(), &record).unwrap()
        );
        assert_eq!(exact_suffix(&a), exact_suffix(&peer));
        assert_eq!(exact_suffix(&b), exact_suffix(&peer));
    }

    #[test]
    fn safe_clock_gaps_retained_proof_outlives_safe_delete_without_resurrection() {
        let (mut live, old, record) = mixed_fixture(false);
        let peer = open(&old, 7921);
        insert_suffix(&peer, "远🙂");
        insertion(&peer, 0, "保");
        live.apply_remote(&peer.update(None, 1).unwrap(), 1)
            .unwrap();
        let proof = gaps::read(&live.doc.transact(), &record).unwrap();
        assert!(!proof.is_empty());
        let suffix = text(&live, "d");
        suffix.remove_range(&mut live.doc.transact_mut_with(REMOTE), 1, 3);
        for step in 0..4 {
            assert!(if step % 2 == 0 {
                live.try_undo()
            } else {
                live.try_redo()
            }
            .unwrap());
            assert_eq!(
                plain_text(&text(&live, "d"), &live.doc.transact()).unwrap(),
                "尾声"
            );
            assert!(visible(&live).starts_with("保潮"));
        }
        let mut cold = open(&live.update(None, 1).unwrap(), 7922);
        assert_eq!(gaps::read(&cold.doc.transact(), &record).unwrap(), proof);
        assert_eq!(
            plain_text(&text(&cold, "d"), &cold.doc.transact()).unwrap(),
            "尾声"
        );
        // Cold checkpoints have no undo stack. Exercise the same private
        // rematerializer against an explicitly fresh incarnation/namespace.
        let mut next = active_records(&cold.doc.transact()).unwrap().pop().unwrap();
        let old_target = text(&cold, "b");
        let restored;
        {
            let mut txn = cold.doc.transact_mut();
            old_target.remove_range(&mut txn, 0, 1);
            let block = cold
                .root
                .push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            block.insert_attribute(&mut txn, "id", "cold-incarnation");
            restored = block.push_back(&mut txn, XmlTextPrelim::new("潮汐"));
            let restored_tape = tape(&mut txn, &restored).unwrap();
            let mut offset = 0;
            for span in &mut next.spans {
                span.target = restored_tape[0].id.plus(offset).unwrap();
                offset += span.length;
            }
        }
        next.target_text = type_id(&restored).unwrap();
        next.right_boundary = None;
        next.namespace ^= 1 << 46;
        if next.namespace == 0 {
            next.namespace = 1 << 45;
        }
        next.incarnation.push_str(".cold");
        let prepared = rematerialize(&cold, &next).unwrap().unwrap();
        cold.apply_remote(&prepared.combined_update, 1).unwrap();
        assert_eq!(
            plain_text(&restored, &cold.doc.transact()).unwrap(),
            "保潮汐"
        );
        assert_eq!(
            plain_text(&text(&cold, "d"), &cold.doc.transact()).unwrap(),
            "尾声"
        );
    }

    #[test]
    fn safe_clock_gaps_unproved_deleted_or_alias_branch_rejects_atomically() {
        // A d item deleted before any receipt was recorded is not proof.
        let (mut live, old, _) = mixed_fixture(false);
        let peer = open(&old, 7931);
        live.apply_remote(&insert_suffix(&peer, "远🙂"), 1).unwrap();
        text(&live, "d").remove_range(&mut live.doc.transact_mut_with(REMOTE), 1, 3);
        assert_mixed_rejection(&mut live, &insertion(&peer, 0, "保"));
        // A live restored b has a redone physical identity. Its new text is
        // still part of the alias graph, not a safe clock gap for a redo.
        let (mut live, old, _) = mixed_fixture(false);
        live.try_undo().unwrap();
        let aware = open(&live.update(None, 1).unwrap(), 7932);
        let safe_b = insertion(&aware, 0, "本");
        live.apply_remote(&safe_b, 1).unwrap();
        let old_peer = open(&old, 7932);
        // Copy the same immutable source clock 0 into a disjoint baseline; the
        // next old-parent string has clock1, which must not skip restored b0.
        old_peer.doc.get_or_insert_text("not-delivered").insert(
            &mut old_peer.doc.transact_mut(),
            0,
            "x",
        );
        let bad = insertion(&old_peer, 0, "旧");
        assert_mixed_rejection(&mut live, &bad);
    }

    #[test]
    fn safe_clock_gaps_lost_prefix_with_residual_pending_is_atomic() {
        let (mut live, old, _) = mixed_fixture(false);
        let prefix = open(&old, 7941);
        let suffix = open(&old, 7942);
        let bad = insertion(&prefix, 0, "保");
        insert_suffix(&suffix, "远");
        let missing_dependency = insert_suffix(&suffix, "续");
        let packet = Update::merge_updates([
            Update::decode_v1(&bad).unwrap(),
            Update::decode_v1(&missing_dependency).unwrap(),
        ])
        .encode_v1();
        assert_mixed_rejection(&mut live, &packet);
        assert!(!live.has_pending());
        assert_eq!(visible(&live), "潮汐夜航\n尾声");
    }
}
