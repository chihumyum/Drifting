//! Fixed-shape RFC 8949 deterministic CBOR for the existing yjs.update wire.
//! This is intentionally not a general decoder or an alternative sync schema.
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodedProseChange {
    pub change_set_id: String,
    pub payload_cbor: Vec<u8>,
    /// Lowercase hex as stored in SQLite (wire hashes add `sha256:`).
    pub payload_sha256: String,
    pub encoded_bytes: Vec<u8>,
    pub encoded_sha256: String,
}

pub struct ChangeIdentity<'a> {
    pub project_id: &'a str,
    pub project_sync_id: &'a str,
    pub sync_generation_id: &'a str,
    pub writer_id: &'a str,
    pub writer_epoch: &'a str,
    pub device_seq: u64,
    pub wall_ms: u64,
    pub counter: u64,
    pub doc_id: &'a str,
    pub incarnation: u64,
}

enum Cbor<'a> {
    Uint(u64),
    Text(&'a str),
    Bytes(&'a [u8]),
    Map(Vec<(&'a str, Cbor<'a>)>),
    Array(Vec<Cbor<'a>>),
}
fn head(bytes: &mut Vec<u8>, major: u8, value: u64) {
    let tag = major << 5;
    if value < 24 {
        bytes.push(tag | value as u8);
    } else if let Ok(value) = u8::try_from(value) {
        bytes.extend([tag | 24, value]);
    } else if let Ok(value) = u16::try_from(value) {
        bytes.push(tag | 25);
        bytes.extend(value.to_be_bytes());
    } else if let Ok(value) = u32::try_from(value) {
        bytes.push(tag | 26);
        bytes.extend(value.to_be_bytes());
    } else {
        bytes.push(tag | 27);
        bytes.extend(value.to_be_bytes());
    }
}
impl Cbor<'_> {
    fn encode(&self, bytes: &mut Vec<u8>) {
        match self {
            Self::Uint(value) => head(bytes, 0, *value),
            Self::Text(value) => {
                head(bytes, 3, value.len() as u64);
                bytes.extend(value.as_bytes());
            }
            Self::Bytes(value) => {
                head(bytes, 2, value.len() as u64);
                bytes.extend(*value);
            }
            Self::Array(values) => {
                head(bytes, 4, values.len() as u64);
                for value in values {
                    value.encode(bytes);
                }
            }
            Self::Map(values) => {
                let mut entries: Vec<_> = values
                    .iter()
                    .map(|(key, value)| {
                        let mut key_bytes = Vec::new();
                        Cbor::Text(key).encode(&mut key_bytes);
                        (key_bytes, value)
                    })
                    .collect();
                entries.sort_by(|a, b| a.0.cmp(&b.0));
                head(bytes, 5, entries.len() as u64);
                for (key, value) in entries {
                    bytes.extend(key);
                    value.encode(bytes);
                }
            }
        }
    }
    fn bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        self.encode(&mut bytes);
        bytes
    }
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn encode(identity: &ChangeIdentity<'_>, update: &[u8]) -> EncodedProseChange {
    encode_optional(identity, update, None)
}

pub(super) fn encode_optional(
    identity: &ChangeIdentity<'_>,
    update: &[u8],
    evidence: Option<&super::ProseSourceOperationEvidence>,
) -> EncodedProseChange {
    use Cbor::*;
    let payload = || {
        let mut values = vec![("update", Bytes(update))];
        if let Some(evidence) = evidence {
            let ranges = |ranges: &[crate::original_operation::SourceRange]| {
                Array(
                    ranges
                        .iter()
                        .map(|r| {
                            Map(vec![
                                ("client", Uint(r.client)),
                                ("clock", Uint(r.clock.into())),
                                ("length", Uint(r.length.into())),
                            ])
                        })
                        .collect(),
                )
            };
            values.push((
                "sourceRetentionProvenance",
                Map(vec![
                    ("version", Uint(1)),
                    ("kind", Text("transaction-event")),
                    ("beforeSnapshot", Bytes(&evidence.before_snapshot)),
                    ("transactionDeletes", ranges(&evidence.transaction_deletes)),
                ]),
            ));
            let intent = &evidence.intent;
            values.push((
                "sourceOperationIntent",
                Map(vec![
                    ("version", Uint(1)),
                    ("kind", Text("prose.text.delete")),
                    (
                        "targetText",
                        Map(vec![
                            ("client", Uint(intent.target_text.client)),
                            ("clock", Uint(intent.target_text.clock.into())),
                        ]),
                    ),
                    ("offsetUTF16", Uint(intent.offset_utf16)),
                    ("lengthUTF16", Uint(intent.length_utf16)),
                    (
                        "selectedSourceRanges",
                        ranges(&intent.selected_source_ranges),
                    ),
                ]),
            ));
        }
        Map(values)
    };
    let payload_cbor = payload().bytes();
    let payload_sha256 = hash(&payload_cbor);
    let wire_hash = format!("sha256:{payload_sha256}");
    let change_set_id = format!(
        "{}:{}:{}",
        identity.writer_id, identity.writer_epoch, identity.device_seq
    );
    let target = Map(vec![
        ("family", Text("yjs")),
        ("kind", Text("prose-document")),
        ("id", Text(identity.doc_id)),
        ("incarnation", Uint(identity.incarnation)),
    ]);
    let mutation = Map(vec![
        ("index", Uint(0)),
        ("target", target),
        ("action", Text("yjs.update")),
        ("payloadVersion", Uint(1)),
        ("payload", payload()),
        ("payloadSha256", Text(&wire_hash)),
    ]);
    let bytes = Map(vec![
        ("protocol", Text("drifting.sync.changeset")),
        ("protocolVersion", Uint(1)),
        ("payloadVersion", Uint(1)),
        ("projectId", Text(identity.project_id)),
        ("projectSyncId", Text(identity.project_sync_id)),
        ("syncGenerationId", Text(identity.sync_generation_id)),
        ("changeSetId", Text(&change_set_id)),
        ("writerId", Text(identity.writer_id)),
        ("writerEpoch", Text(identity.writer_epoch)),
        ("deviceSeq", Uint(identity.device_seq)),
        (
            "hlc",
            Map(vec![
                ("wallMs", Uint(identity.wall_ms)),
                ("counter", Uint(identity.counter)),
            ]),
        ),
        ("mutations", Array(vec![mutation])),
    ])
    .bytes();
    EncodedProseChange {
        change_set_id,
        payload_cbor,
        payload_sha256,
        encoded_sha256: hash(&bytes),
        encoded_bytes: bytes,
    }
}
