//! V1 encodes Format/Embed payloads as JSON, while ordinary map/array values
//! retain lib0's richer Any types. Reject lossy JSON conversion before applying
//! incoming structs, including those that are deleted, pending or off-screen.
use yrs::any::Number;
use yrs::encoding::write::Write;
use yrs::updates::encoder::{Encode, Encoder, EncoderV1};
use yrs::{Any, ClientID, Update, ID};

const NON_JSON: &str =
    "Update contains non-JSON Format or Embed data that cannot be preserved in v1";

fn json_compatible(value: &Any) -> bool {
    match value {
        Any::Undefined | Any::Buffer(_) => false,
        Any::Number(Number::Int(value)) => {
            (Number::I64_MIN_SAFE_INTEGER..=Number::I64_MAX_SAFE_INTEGER).contains(value)
        }
        Any::Number(Number::Float(value)) => value.is_finite(),
        Any::Array(values) => values.iter().all(json_compatible),
        Any::Map(values) => values.values().all(json_compatible),
        Any::Null | Any::Bool(_) | Any::String(_) => true,
    }
}

pub(crate) struct CheckedEncoder {
    inner: EncoderV1,
    non_json: bool,
}

impl CheckedEncoder {
    pub(crate) fn new() -> Self {
        Self {
            inner: EncoderV1::new(),
            non_json: false,
        }
    }

    pub(crate) fn finish(self) -> Result<Vec<u8>, String> {
        if self.non_json {
            Err(NON_JSON.into())
        } else {
            Ok(self.inner.to_vec())
        }
    }
}

impl Write for CheckedEncoder {
    fn write_all(&mut self, bytes: &[u8]) {
        self.inner.write_all(bytes);
    }

    fn write_u8(&mut self, value: u8) {
        self.inner.write_u8(value);
    }
}

impl Encoder for CheckedEncoder {
    fn to_vec(self) -> Vec<u8> {
        // Production callers use finish() so a validation error is returned.
        // Never let the trait's infallible convenience method return lossy data.
        self.finish()
            .expect("CheckedEncoder requires finish() for fallible v1 encoding")
    }

    fn reset_ds_cur_val(&mut self) {
        self.inner.reset_ds_cur_val();
    }
    fn write_ds_clock(&mut self, clock: u32) {
        self.inner.write_ds_clock(clock);
    }
    fn write_ds_len(&mut self, len: u32) {
        self.inner.write_ds_len(len);
    }
    fn write_left_id(&mut self, id: &ID) {
        self.inner.write_left_id(id);
    }
    fn write_right_id(&mut self, id: &ID) {
        self.inner.write_right_id(id);
    }
    fn write_client(&mut self, client: ClientID) {
        self.inner.write_client(client);
    }
    fn write_info(&mut self, info: u8) {
        self.inner.write_info(info);
    }
    fn write_parent_info(&mut self, is_y_key: bool) {
        self.inner.write_parent_info(is_y_key);
    }
    fn write_type_ref(&mut self, info: u8) {
        self.inner.write_type_ref(info);
    }
    fn write_len(&mut self, len: u32) {
        self.inner.write_len(len);
    }
    fn write_any(&mut self, value: &Any) {
        // Binary/undefined and large integers remain valid in ordinary lib0
        // values. Only the wire fields using JSON have a restricted domain.
        self.inner.write_any(value);
    }
    fn write_json(&mut self, value: &Any) {
        if json_compatible(value) {
            self.inner.write_json(value);
        } else {
            self.non_json = true;
            // Encoder is infallible. Keep traversing all structs safely without
            // invoking JSON serialization on a value that could fail or coerce.
            // finish() discards these placeholder bytes by returning the error.
            self.inner.write_json(&Any::Null);
        }
    }
    fn write_key(&mut self, key: &str) {
        self.inner.write_key(key);
    }
}

pub(crate) fn validate_update(update: &Update) -> Result<(), String> {
    let mut encoder = CheckedEncoder::new();
    update.encode(&mut encoder);
    encoder.finish().map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use yrs::types::Attrs;
    use yrs::updates::decoder::Decode;
    use yrs::{Array, Doc, Map, Options, Out, ReadTxn, StateVector, Text, Transact};

    fn unsafe_values() -> Vec<Any> {
        vec![
            Any::Buffer(vec![0, 1, 255].into()),
            Any::Undefined,
            Any::Number(Number::Float(f64::NAN)),
            Any::Number(Number::Float(f64::INFINITY)),
            Any::Number(Number::Float(f64::NEG_INFINITY)),
            // Odd values beyond 2^53 use lib0's BigInt code, so decoding keeps
            // Int rather than an exactly representable floating-point value.
            Any::Number(Number::Int(Number::I64_MAX_SAFE_INTEGER + 2)),
            Any::Number(Number::Int(Number::I64_MIN_SAFE_INTEGER - 2)),
            Any::from(HashMap::from([(
                "nested".to_owned(),
                Any::Array(vec![Any::Bool(true), Any::Buffer(vec![1, 2].into())].into()),
            )])),
        ]
    }

    #[test]
    fn v2_non_json_marks_and_embeds_are_rejected_before_v1_conversion() {
        for value in unsafe_values() {
            for embed in [false, true] {
                let source = Doc::with_client_id(35001);
                let text = source.get_or_insert_text("unknown-future-root");
                let bytes = {
                    let mut txn = source.transact_mut();
                    if embed {
                        text.insert_embed(&mut txn, 0, value.clone());
                    } else {
                        text.insert_with_attributes(
                            &mut txn,
                            0,
                            "Synthetic",
                            Attrs::from([("future".into(), value.clone())]),
                        );
                    }
                    txn.encode_update_v2()
                };
                let decoded = Update::decode_v2(&bytes).unwrap();
                let checked = validate_update(&decoded);
                assert!(
                    checked
                        .as_ref()
                        .is_err_and(|error| error.contains("non-JSON")),
                    "value {value:?}, embed {embed}: {checked:?}"
                );
            }
        }
    }

    #[test]
    fn pending_format_structs_are_checked_even_without_their_text_dependencies() {
        let source = Doc::with_client_id(35002);
        let text = source.get_or_insert_text("future-root");
        text.insert(&mut source.transact_mut(), 0, "Synthetic");
        let formatting_only = {
            let mut txn = source.transact_mut();
            text.format(
                &mut txn,
                1,
                2,
                Attrs::from([("future".into(), Any::Buffer(vec![0, 255].into()))]),
            );
            txn.encode_update_v2()
        };
        let update = Update::decode_v2(&formatting_only).unwrap();
        assert!(validate_update(&update).is_err());
        // Verify that this is truly a missing-dependency case, not just an
        // off-screen but integrated text that a visible-run scan could inspect.
        let unchecked = Doc::new();
        unchecked.transact_mut().apply_update(update).unwrap();
        let txn = unchecked.transact();
        assert!(txn.has_missing_updates());
        assert!(validate_update(&txn.store().pending_update().unwrap().update).is_err());
    }

    #[test]
    fn deleted_format_payloads_are_validated_before_integration_can_hide_them() {
        let mut options = Options::with_client_id(ClientID::new(35003));
        options.skip_gc = true;
        let source = Doc::with_options(options);
        let text = source.get_or_insert_text("future-root");
        let authored = {
            let mut txn = source.transact_mut();
            text.insert_with_attributes(
                &mut txn,
                0,
                "Synthetic",
                Attrs::from([("future".into(), Any::Undefined)]),
            );
            txn.encode_update_v2()
        };
        let deletion = {
            let mut txn = source.transact_mut();
            text.remove_range(&mut txn, 0, 9);
            txn.encode_update_v2()
        };
        let merged = Update::merge_updates([
            Update::decode_v2(&authored).unwrap(),
            Update::decode_v2(&deletion).unwrap(),
        ]);
        assert!(validate_update(&merged).is_err());
    }

    #[test]
    fn json_marks_and_raw_binary_map_array_values_keep_the_existing_v1_bytes() {
        let source = Doc::with_client_id(35004);
        let text = source.get_or_insert_text("future-root");
        let map = source.get_or_insert_map("future-map");
        let array = source.get_or_insert_array("future-array");
        let binary = Any::Buffer(vec![0, 128, 255].into());
        let nested = Any::from(HashMap::from([
            ("binary".to_owned(), binary.clone()),
            ("unset".to_owned(), Any::Undefined),
            (
                "integer".to_owned(),
                Any::Number(Number::Int(Number::I64_MAX_SAFE_INTEGER + 2)),
            ),
        ]));
        {
            let mut txn = source.transact_mut();
            text.insert_with_attributes(
                &mut txn,
                0,
                "Synthetic",
                Attrs::from([(
                    "future".into(),
                    Any::from_json(r#"{"nullable":null,"values":[true,"ok",1.25,9007199254740991,-9007199254740991]}"#).unwrap(),
                )]),
            );
            map.insert(&mut txn, "binary", binary.clone());
            array.insert(&mut txn, 0, nested.clone());
        }
        let txn = source.transact();
        let expected = txn.encode_state_as_update_v1(&StateVector::default());
        let mut encoder = CheckedEncoder::new();
        txn.encode_state_as_update(&StateVector::default(), &mut encoder);
        assert_eq!(encoder.finish().unwrap(), expected);
        validate_update(&Update::decode_v1(&expected).unwrap()).unwrap();
        let restored = Doc::new();
        restored
            .transact_mut()
            .apply_update(Update::decode_v1(&expected).unwrap())
            .unwrap();
        assert_eq!(
            restored
                .get_or_insert_map("future-map")
                .get(&restored.transact(), "binary"),
            Some(Out::Any(binary))
        );
        assert_eq!(
            restored
                .get_or_insert_array("future-array")
                .get(&restored.transact(), 0),
            Some(Out::Any(nested))
        );
    }

    #[test]
    fn ordinary_json_v2_format_update_passes_checked_v1_encoding() {
        let source = Doc::with_client_id(35005);
        let text = source.get_or_insert_text("future-root");
        let bytes = {
            let mut txn = source.transact_mut();
            text.insert_with_attributes(
                &mut txn,
                0,
                "Synthetic",
                Attrs::from([(
                    "future".into(),
                    Any::from_json(r#"{"bold":true,"link":{"id":"synthetic"}}"#).unwrap(),
                )]),
            );
            txn.encode_update_v2()
        };
        let decoded = Update::decode_v2(&bytes).unwrap();
        validate_update(&decoded).unwrap();
        let mut checked = CheckedEncoder::new();
        decoded.encode(&mut checked);
        let v1 = checked.finish().unwrap();
        assert_eq!(v1, decoded.encode_v1());
    }

    #[test]
    fn export_rejects_unsafe_raw_in_memory_and_pending_marks() {
        let session = crate::DocumentSession::new();
        let text = session.doc.get_or_insert_text("raw-future-root");
        text.insert_with_attributes(
            &mut session.doc.transact_mut(),
            0,
            "Synthetic",
            Attrs::from([("future".into(), Any::Buffer(vec![0, 255].into()))]),
        );
        assert!(session.update(None, 1).unwrap_err().contains("non-JSON"));

        let source = Doc::with_client_id(35006);
        let text = source.get_or_insert_text("raw-pending-root");
        text.insert(&mut source.transact_mut(), 0, "Synthetic");
        let bytes = {
            let mut txn = source.transact_mut();
            text.format(
                &mut txn,
                0,
                1,
                Attrs::from([("future".into(), Any::Undefined)]),
            );
            txn.encode_update_v2()
        };
        let pending = crate::DocumentSession::new();
        pending
            .doc
            .transact_mut()
            .apply_update(Update::decode_v2(&bytes).unwrap())
            .unwrap();
        assert!(pending.has_pending());
        assert!(pending.update(None, 1).unwrap_err().contains("non-JSON"));
    }
}
