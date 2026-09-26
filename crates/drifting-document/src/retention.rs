//! Preflight unseen remote text before Yrs can delete it under a deleted parent.
//! This does not invent a new destination for that text. The caller must retain
//! the original update for recovery when the preflight refuses integration.
use super::*;
use yrs::block::{
    ItemContent, BLOCK_GC_REF_NUMBER, BLOCK_SKIP_REF_NUMBER, HAS_ORIGIN, HAS_PARENT_SUB,
    HAS_RIGHT_ORIGIN,
};
use yrs::encoding::read::Read;
use yrs::updates::decoder::{Decoder, DecoderV1};
use yrs::{IdSet, ID};

/// Stable error prefix for durable receivers that retain the original payload.
pub const REMOTE_TEXT_RETENTION_REQUIRED: &str = "REMOTE_TEXT_RETENTION_REQUIRED";

pub(super) fn validate(session: &DocumentSession, incoming: &Update) -> Result<(), String> {
    if loss_spans(session, incoming)?.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{REMOTE_TEXT_RETENTION_REQUIRED}: unseen remote text would be deleted during integration"
        ))
    }
}

/// Original incoming string identities lost by raw integration, before any
/// alias repair. Safe strings must retain their original CRDT identities.
pub(super) fn loss_spans(session: &DocumentSession, incoming: &Update) -> Result<IdSet, String> {
    let bytes = incoming.encode_v1(); // wire::validate_update has already checked JSON values.
    let mut protected = string_spans(&bytes)?;
    {
        let txn = session.doc.transact();
        // A dependency-only packet may integrate text from an earlier packet.
        if let Some(pending) = txn.store().pending_update() {
            protected.merge_with(string_spans(&pending.update.encode_v1())?);
        }
        let known = IdSet::from_iter(
            txn.state_vector()
                .iter()
                .map(|(client, clock)| (*client, [0..*clock])),
        );
        protected.diff_with(&known);
        protected.diff_with(incoming.delete_set());
        // Explicit delete-before-insert remains valid even when its DeleteSet
        // arrived in a different packet and has not integrated yet.
        if let Some(deleted) = txn.store().pending_ds() {
            protected.diff_with(deleted);
        }
    }
    if protected.is_empty() {
        return Ok(protected);
    }

    let checkpoint = session.update(None, 1)?;
    let mut options = Options::default();
    options.offset_kind = OffsetKind::Utf16;
    // Keep undo-retained historical items while inspecting deletion status.
    // Already-GC'd input stays GC'd; no in-memory history/alias is required.
    options.skip_gc = true;
    let probe = Doc::with_options(options);
    for update in [&checkpoint, &bytes] {
        probe
            .transact_mut()
            .apply_update(Update::decode_v1(update).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    let txn = probe.transact();
    let mut deleted = protected.intersect(&txn.snapshot().delete_set);
    // Full encoding includes pending inserts. Missing dependencies alone are
    // not loss; their original ContentString must still be present verbatim.
    let retained = string_spans(&txn.encode_state_as_update_v1(&StateVector::default()))?;
    let missing = protected.diff(&retained);
    deleted.merge_with(missing);
    Ok(deleted)
}

/// Read only the v1 struct envelopes; Yrs decodes every content body. The
/// envelope follows pinned Yrs Update::decode_block, including Skip and GC.
/// Calling this on normalized, already-validated updates avoids a second wire
/// implementation for Any, formats, nested XML, subdocuments, or v2 values.
fn string_spans(bytes: &[u8]) -> Result<IdSet, String> {
    let mut decoder = DecoderV1::from(bytes);
    let decode = |decoder: &mut DecoderV1| -> Result<IdSet, yrs::encoding::read::Error> {
        let clients: u32 = decoder.read_var()?;
        let mut strings = IdSet::new();
        for _ in 0..clients {
            let blocks: u32 = decoder.read_var()?;
            let client = decoder.read_client()?;
            let mut clock: u32 = decoder.read_var()?;
            for _ in 0..blocks {
                let info = decoder.read_info()?;
                let (len, is_string) = match info {
                    BLOCK_SKIP_REF_NUMBER => (decoder.read_var()?, false),
                    BLOCK_GC_REF_NUMBER => (decoder.read_len()?, false),
                    info => {
                        let parent = info & (HAS_ORIGIN | HAS_RIGHT_ORIGIN) == 0;
                        if info & HAS_ORIGIN != 0 {
                            decoder.read_left_id()?;
                        }
                        if info & HAS_RIGHT_ORIGIN != 0 {
                            decoder.read_right_id()?;
                        }
                        if parent {
                            if decoder.read_parent_info()? {
                                decoder.read_string()?;
                            } else {
                                decoder.read_left_id()?;
                            }
                            if info & HAS_PARENT_SUB != 0 {
                                decoder.read_string()?;
                            }
                        }
                        let content = ItemContent::decode(decoder, info)?;
                        let len = content.len(OffsetKind::Utf16);
                        (len, matches!(content, ItemContent::String(_)))
                    }
                };
                let end = clock.checked_add(len).ok_or_else(|| {
                    yrs::encoding::read::Error::Custom("CRDT clock range overflow".into())
                })?;
                if is_string {
                    strings.insert(ID::new(client, clock), len);
                }
                clock = end;
            }
        }
        Ok(strings)
    };
    decode(&mut decoder).map_err(|e| format!("Cannot inspect CRDT text retention: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::encoding::write::Write;
    use yrs::updates::encoder::{Encoder, EncoderV1};

    #[test]
    fn retention_scanner_rejects_clock_overflow_before_building_ranges() {
        let mut encoder = EncoderV1::new();
        encoder.write_var(1u32);
        encoder.write_var(1u32);
        encoder.write_client(yrs::block::ClientID::new(1));
        encoder.write_var(u32::MAX);
        encoder.write_info(yrs::block::BLOCK_ITEM_STRING_REF_NUMBER);
        encoder.write_parent_info(true);
        encoder.write_string("root");
        encoder.write_string("x");
        encoder.write_var(0u32);
        assert!(string_spans(&encoder.to_vec())
            .unwrap_err()
            .contains("clock range overflow"));
    }
}
