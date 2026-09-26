use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
fn fixture() -> Value {
    serde_json::from_str(include_str!("../../tests/fixtures/original-operation.json")).unwrap()
}
fn bytes(v: &Value) -> Vec<u8> {
    STANDARD.decode(v.as_str().unwrap()).unwrap()
}
fn reference(v: &Value) -> OriginalOperationRef {
    serde_json::from_value(v.clone()).unwrap()
}
#[test]
fn original_operation_accepts_real_ts_envelopes_and_returns_all_exact_materialized_rows() {
    let f = fixture();
    for c in f["positives"].as_array().unwrap() {
        let input = bytes(&c["envelope"]);
        let reference = reference(&c["expected"]);
        let verified = verify_original_operation(&input, &reference)
            .unwrap_or_else(|e| panic!("{}: {e}", c["name"]));
        assert_eq!(verified.source(), &reference);
        assert_eq!(verified.exact_update(), bytes(&c["exactUpdate"]));
        assert_eq!(verified.before_snapshot(), bytes(&c["beforeSnapshot"]));
        assert_eq!(
            verified.intent().offset_utf16,
            c["intent"]["offsetUTF16"].as_u64().unwrap()
        );
        assert_eq!(
            verified.intent().length_utf16,
            c["intent"]["lengthUTF16"].as_u64().unwrap()
        );
        assert_eq!(
            verified.intent().target_text,
            serde_json::from_value::<SourceId>(c["intent"]["targetText"].clone()).unwrap()
        );
        assert_eq!(
            verified.intent().selected_source_ranges,
            serde_json::from_value::<Vec<SourceRange>>(c["intent"]["selectedSourceRanges"].clone())
                .unwrap()
        );
        assert_eq!(
            verified.writer_id(),
            c["metadata"]["writerId"].as_str().unwrap()
        );
        assert_eq!(
            verified.writer_epoch(),
            c["metadata"]["writerEpoch"].as_str().unwrap()
        );
        assert_eq!(
            verified.device_seq(),
            c["metadata"]["deviceSeq"].as_u64().unwrap()
        );
        assert_eq!(
            verified.hlc_wall_ms(),
            c["metadata"]["hlc"]["wallMs"].as_u64().unwrap()
        );
        assert_eq!(
            verified.hlc_counter(),
            c["metadata"]["hlc"]["counter"].as_u64().unwrap()
        );
        assert_eq!(verified.protocol_version(), 1);
        assert_eq!(verified.payload_version(), 1);
        let mutations = c["mutations"].as_array().unwrap();
        assert_eq!(verified.mutations().len(), mutations.len());
        for (actual, expected) in verified.mutations().iter().zip(mutations) {
            assert_eq!(actual.index(), expected["index"].as_u64().unwrap());
            assert_eq!(
                actual.target(),
                &serde_json::from_value::<MutationTarget>(expected["target"].clone()).unwrap()
            );
            assert_eq!(actual.action(), expected["action"].as_str().unwrap());
            assert_eq!(
                actual.payload_version(),
                expected["payloadVersion"].as_u64().unwrap()
            );
            assert_eq!(
                actual.payload_sha256(),
                expected["payloadSha256"].as_str().unwrap()
            );
            assert_eq!(
                actual.canonical_payload_bytes(),
                bytes(&expected["canonicalPayloadBase64"])
            );
        }
    }
}
#[test]
fn original_operation_rejects_ts_binding_schema_hash_versions_and_unclassified_event_corpus() {
    let f = fixture();
    for c in f["negatives"].as_array().unwrap() {
        let result = verify_original_operation(&bytes(&c["envelope"]), &reference(&c["expected"]));
        assert!(result.is_err(), "unexpected acceptance: {}", c["name"]);
    }
}
#[test]
fn original_operation_complete_canonical_value_model_matches_production_cborg() {
    let f = fixture();
    for c in f["cbor"].as_array().unwrap() {
        let actual = canonical::decode(&bytes(&c["bytes"]));
        assert_eq!(
            actual.is_ok(),
            c["accepted"].as_bool().unwrap(),
            "{}: {actual:?}",
            c["name"]
        );
    }
}
#[test]
fn original_operation_bounds_envelope_before_decode_and_owns_selected_bytes() {
    let f = fixture();
    let c = &f["positives"][0];
    let mut input = bytes(&c["envelope"]);
    let mut reference = reference(&c["expected"]);
    let verified = verify_original_operation(&input, &reference).unwrap();
    let payload = verified.selected().canonical_payload_bytes().to_vec();
    input.fill(0);
    reference.target.id = "changed caller input".into();
    reference.payload_sha256.clear();
    assert_eq!(verified.selected().canonical_payload_bytes(), payload);
    assert_eq!(verified.exact_update(), bytes(&c["exactUpdate"]));
    assert_ne!(verified.source().target.id, reference.target.id);
    let mut giant = vec![0; MAX_ORIGINAL_ENVELOPE_BYTES + 1];
    giant[0] = 0xa0;
    let error = verify_original_operation(&giant, &reference).unwrap_err();
    assert!(error.contains("byte budget"));
}
#[test]
fn original_operation_yjs_snapshot_and_event_readers_fail_closed_without_allocating_claimed_collections(
) {
    for value in [
        &[255u8; 8][..],
        &[128, 0][..],
        &[0, 1, 1, 0, 0][..],
        &[0, 1, 1, 128][..],
    ] {
        assert!(snapshot(value).is_err());
    }
    assert!(snapshot(&[0, 0]).is_ok());
    let f = fixture();
    let c = &f["positives"][0];
    let ranges =
        serde_json::from_value::<Vec<SourceRange>>(c["intent"]["selectedSourceRanges"].clone())
            .unwrap();
    let mut trailing = bytes(&c["exactUpdate"]);
    trailing.push(0);
    assert!(event(&trailing, &ranges).is_err());
    assert!(event(&[1, 0], &ranges).is_err());
}

#[test]
fn original_operation_rejects_hashed_event_trailing_bytes_that_ts_update_decoder_ignores() {
    let f = fixture();
    for c in f["strictBoundaries"].as_array().unwrap() {
        assert!(c["tsEnvelopeAccepted"].as_bool().unwrap());
        assert!(c["tsOperationPrototypeAccepted"].as_bool().unwrap());
        let error = verify_original_operation(&bytes(&c["envelope"]), &reference(&c["expected"]))
            .unwrap_err();
        assert!(
            error.contains(c["reason"].as_str().unwrap()),
            "{}: {error}",
            c["name"]
        );
    }
}

#[test]
fn original_operation_preserves_actual_native_events_and_accepts_all_client_group_orders() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/event-order.json")).unwrap();
    let mut passed = 0;
    for case in fixtures["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["accepted"] == true)
    {
        let original =
            verify_original_operation(&bytes(&case["envelope"]), &reference(&case["expected"]))
                .unwrap_or_else(|error| panic!("{}: {error}", case["name"]));
        assert_eq!(
            original.exact_update(),
            bytes(&case["exactUpdate"]),
            "Original bytes must not be rewritten"
        );
        passed += 1;
    }
    assert_eq!(passed, 11);
}

#[test]
fn original_operation_exact_event_parser_still_rejects_malformed_complete_hashed_envelopes() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/event-order.json")).unwrap();
    let mut rejected = 0;
    for case in fixtures["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["accepted"] == false)
    {
        let error =
            verify_original_operation(&bytes(&case["envelope"]), &reference(&case["expected"]))
                .unwrap_err();
        assert!(
            error.contains(case["rustReason"].as_str().unwrap()),
            "{}: {error}",
            case["name"]
        );
        rejected += 1;
    }
    assert_eq!(rejected, 21);
}
