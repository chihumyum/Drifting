//! Isolated original-operation envelope verifier. This proves immutable byte and
//! declaration binding, NOT source visibility, writer authority or capability.
mod canonical;
#[cfg(test)]
mod tests;
use canonical::{Node, MAX_SAFE};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_ORIGINAL_ENVELOPE_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const MAX_RANGES: usize = 100_000;
pub(crate) const MAX_SNAPSHOT_BYTES: usize = 1024 * 1024;
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MutationTarget {
    pub family: String,
    pub kind: String,
    pub id: String,
    pub incarnation: u64,
}
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OriginalOperationRef {
    pub project_id: String,
    pub project_sync_id: String,
    pub sync_generation_id: String,
    pub change_set_id: String,
    pub mutation_index: u64,
    pub target: MutationTarget,
    pub payload_sha256: String,
    pub original_envelope_sha256: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceId {
    pub client: u64,
    pub clock: u32,
}
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceRange {
    pub client: u64,
    pub clock: u32,
    pub length: u32,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeclaredTextDelete {
    pub target_text: SourceId,
    pub offset_utf16: u64,
    pub length_utf16: u64,
    pub selected_source_ranges: Vec<SourceRange>,
}
#[derive(Debug)]
pub struct VerifiedMutation {
    index: u64,
    target: MutationTarget,
    action: String,
    payload_version: u64,
    payload_sha256: String,
    canonical_payload_bytes: Vec<u8>,
}
impl VerifiedMutation {
    pub fn index(&self) -> u64 {
        self.index
    }
    pub fn target(&self) -> &MutationTarget {
        &self.target
    }
    pub fn action(&self) -> &str {
        &self.action
    }
    pub fn payload_version(&self) -> u64 {
        self.payload_version
    }
    pub fn payload_sha256(&self) -> &str {
        &self.payload_sha256
    }
    pub fn canonical_payload_bytes(&self) -> &[u8] {
        &self.canonical_payload_bytes
    }
    /// Decode the already verified canonical payload for scalar domain reducers.
    /// Binary values deliberately have no JSON representation here.
    pub(crate) fn payload_json(&self) -> Result<serde_json::Value, String> {
        fn json(node: canonical::Node) -> Result<serde_json::Value, String> {
            use canonical::Value;
            Ok(match node.kind {
                Value::Null => serde_json::Value::Null,
                Value::Bool(value) => value.into(),
                Value::Number(value) => serde_json::Number::from_f64(value)
                    .ok_or("Metadata number is not finite")?
                    .into(),
                Value::Text(value) => value.into(),
                Value::Array(values) => serde_json::Value::Array(
                    values.into_iter().map(json).collect::<Result<_, _>>()?,
                ),
                Value::Map(values) => serde_json::Value::Object(
                    values
                        .into_iter()
                        .map(|(key, value)| Ok((key, json(value)?)))
                        .collect::<Result<_, String>>()?,
                ),
                Value::Bytes(_) => return Err("Metadata payload contains binary data".into()),
            })
        }
        json(canonical::decode(&self.canonical_payload_bytes)?)
    }
    /// Extract original known Yjs bytes from the immutable canonical payload.
    /// This does not decode CRDT bodies or establish reconstructible history.
    pub fn original_yjs_update(&self) -> Result<Vec<u8>, String> {
        require(self.action == "yjs.update", "mutation is not a Yjs update")?;
        let payload = canonical::decode(&self.canonical_payload_bytes)?;
        let bytes = payload.field("update")?.bytes()?;
        require(!bytes.is_empty(), "empty original Yjs update")?;
        Ok(bytes.to_vec())
    }
}
/// Identity expected for one complete immutable envelope; no selected action.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeSetRef {
    pub project_id: String,
    pub project_sync_id: String,
    pub sync_generation_id: String,
    pub change_set_id: String,
    pub original_envelope_sha256: String,
}
impl From<&OriginalOperationRef> for ChangeSetRef {
    fn from(value: &OriginalOperationRef) -> Self {
        Self {
            project_id: value.project_id.clone(),
            project_sync_id: value.project_sync_id.clone(),
            sync_generation_id: value.sync_generation_id.clone(),
            change_set_id: value.change_set_id.clone(),
            original_envelope_sha256: value.original_envelope_sha256.clone(),
        }
    }
}
/// Canonical immutable bytes and all declared mutations have been checked.
/// This is not a source-view, command, applied-receipt or writer authorization.
#[derive(Debug)]
pub struct VerifiedChangeSet {
    source: ChangeSetRef,
    writer_id: String,
    writer_epoch: String,
    device_seq: u64,
    hlc_wall_ms: u64,
    hlc_counter: u64,
    mutations: Vec<VerifiedMutation>,
}
impl VerifiedChangeSet {
    pub fn source(&self) -> &ChangeSetRef {
        &self.source
    }
    pub fn writer_id(&self) -> &str {
        &self.writer_id
    }
    pub fn writer_epoch(&self) -> &str {
        &self.writer_epoch
    }
    pub fn device_seq(&self) -> u64 {
        self.device_seq
    }
    pub fn hlc_wall_ms(&self) -> u64 {
        self.hlc_wall_ms
    }
    pub fn hlc_counter(&self) -> u64 {
        self.hlc_counter
    }
    pub fn protocol_version(&self) -> u64 {
        1
    }
    pub fn payload_version(&self) -> u64 {
        1
    }
    pub fn mutations(&self) -> &[VerifiedMutation] {
        &self.mutations
    }
}
/// No Deserialize, public fields, or caller-supplied "verified" boolean.
#[derive(Debug)]
pub struct VerifiedOriginalOperation {
    source: OriginalOperationRef,
    change_set: VerifiedChangeSet,
    exact_update: Vec<u8>,
    before_snapshot: Vec<u8>,
    intent: DeclaredTextDelete,
}
impl VerifiedOriginalOperation {
    pub fn writer_id(&self) -> &str {
        self.change_set.writer_id()
    }
    pub fn writer_epoch(&self) -> &str {
        self.change_set.writer_epoch()
    }
    pub fn device_seq(&self) -> u64 {
        self.change_set.device_seq()
    }
    pub fn hlc_wall_ms(&self) -> u64 {
        self.change_set.hlc_wall_ms()
    }
    pub fn hlc_counter(&self) -> u64 {
        self.change_set.hlc_counter()
    }
    pub fn protocol_version(&self) -> u64 {
        self.change_set.protocol_version()
    }
    pub fn payload_version(&self) -> u64 {
        self.change_set.payload_version()
    }
    pub fn source(&self) -> &OriginalOperationRef {
        &self.source
    }
    pub fn mutations(&self) -> &[VerifiedMutation] {
        self.change_set.mutations()
    }
    pub fn selected(&self) -> &VerifiedMutation {
        &self.change_set.mutations[self.source.mutation_index as usize]
    }
    pub fn exact_update(&self) -> &[u8] {
        &self.exact_update
    }
    pub fn before_snapshot(&self) -> &[u8] {
        &self.before_snapshot
    }
    pub fn intent(&self) -> &DeclaredTextDelete {
        &self.intent
    }
}
fn reject(s: &str) -> String {
    format!("ORIGINAL_OPERATION_UNVERIFIED: {s}")
}
fn require(ok: bool, message: &str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(reject(message))
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn hash_shape(s: &str, prefix: bool) -> bool {
    let s = if prefix {
        let Some(s) = s.strip_prefix("sha256:") else {
            return false;
        };
        s
    } else {
        s
    };
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn opaque(s: &str) -> bool {
    !s.is_empty()
        && s.encode_utf16().count() <= 255
        && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}
fn token(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}
fn domain(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.as_bytes()[0].is_ascii_lowercase()
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(&c))
}
fn target(n: &Node) -> Result<MutationTarget, String> {
    n.keys(&["family", "kind", "id", "incarnation"])?;
    let t = MutationTarget {
        family: n.field("family")?.text()?.into(),
        kind: n.field("kind")?.text()?.into(),
        id: n.field("id")?.text()?.into(),
        incarnation: n.field("incarnation")?.uint(MAX_SAFE)?,
    };
    require(
        ["entity", "set", "order", "yjs", "asset", "sync-generation"].contains(&t.family.as_str())
            && domain(&t.kind)
            && opaque(&t.id),
        "invalid mutation target",
    )?;
    Ok(t)
}
fn family(action: &str) -> Option<&'static str> {
    match action {
        "entity.create" | "field.set" | "tuple.set" | "entity.trash" | "entity.restore"
        | "entity.purge" => Some("entity"),
        "set.add" | "set.remove" => Some("set"),
        "order.move" | "order.rebalance" => Some("order"),
        "yjs.update" => Some("yjs"),
        "asset.bind" | "asset.unbind" => Some("asset"),
        "sync-generation.purge" => Some("sync-generation"),
        _ => None,
    }
}
fn ranges(n: &Node) -> Result<Vec<SourceRange>, String> {
    let list = n.array()?;
    require(list.len() <= MAX_RANGES, "too many delete ranges")?;
    let mut out: Vec<SourceRange> = Vec::new();
    for item in list {
        item.keys(&["client", "clock", "length"])?;
        let r = SourceRange {
            client: item.field("client")?.uint(MAX_SAFE)?,
            clock: item.field("clock")?.uint(u32::MAX as u64)? as u32,
            length: item.field("length")?.uint(u32::MAX as u64)? as u32,
        };
        require(
            r.length > 0 && r.clock.checked_add(r.length).is_some(),
            "invalid delete range length",
        )?;
        if let Some(p) = out.last() {
            require(
                r.client > p.client || (r.client == p.client && r.clock >= p.clock + p.length),
                "unordered or overlapping ranges",
            )?;
        }
        out.push(r);
    }
    Ok(out)
}
// Bounded Yjs v1 unsigned-varint reader. CBOR decoding is delegated to ciborium;
// this only verifies the original zero-struct event and Snapshot(SV+DS) bodies.
struct YjsReader<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl<'a> YjsReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0 }
    }
    fn uint(&mut self) -> Result<u64, String> {
        let mut value = 0u64;
        for shift in (0..56).step_by(7) {
            let b = *self
                .bytes
                .get(self.at)
                .ok_or_else(|| reject("truncated Yjs varuint"))?;
            self.at += 1;
            value = value
                .checked_add(((b & 127) as u64) << shift)
                .ok_or_else(|| reject("Yjs varuint overflow"))?;
            if b < 128 {
                require(
                    value <= MAX_SAFE && (shift == 0 || b != 0),
                    "noncanonical or unsafe Yjs varuint",
                )?;
                return Ok(value);
            }
        }
        Err(reject("Yjs varuint overflow"))
    }
    fn count(&mut self) -> Result<usize, String> {
        let n = self.uint()?;
        require(
            n <= self.bytes.len().saturating_sub(self.at) as u64,
            "Yjs collection budget",
        )?;
        Ok(n as usize)
    }
    fn ds(&mut self) -> Result<Vec<(u64, u64, u64)>, String> {
        let count = self.count()?;
        let mut prev = None;
        let mut out = Vec::new();
        for _ in 0..count {
            let client = self.uint()?;
            require(
                prev.is_none_or(|p| client < p),
                "noncanonical Yjs delete clients",
            )?;
            prev = Some(client);
            let n = self.count()?;
            require(n > 0, "empty Yjs delete client")?;
            for _ in 0..n {
                out.push((client, self.uint()?, self.uint()?));
            }
        }
        Ok(out)
    }
    // Exact transaction events retain their author's bytes. Yrs writes client
    // groups ascending while Yjs writes them descending; neither order changes
    // the DeleteSet. Parse the entire event without canonicalizing its bytes.
    // Snapshot encoding keeps the separate, published canonical requirement.
    fn event_ds(&mut self) -> Result<Vec<(u64, u64, u64)>, String> {
        let count = self.count()?;
        let mut clients = std::collections::BTreeSet::new();
        let mut out = Vec::new();
        for _ in 0..count {
            let client = self.uint()?;
            require(clients.insert(client), "duplicate Yjs event delete client")?;
            let count = self.count()?;
            require(count > 0, "empty Yjs event delete client")?;
            require(
                count <= MAX_RANGES.saturating_sub(out.len()),
                "Yjs event delete range budget",
            )?;
            let mut previous_end = 0;
            for _ in 0..count {
                let clock = self.uint()?;
                let length = self.uint()?;
                require(
                    clock <= u32::MAX as u64
                        && length > 0
                        && length <= (u32::MAX as u64).saturating_sub(clock),
                    "invalid Yjs event delete range",
                )?;
                require(
                    clock >= previous_end,
                    "unordered or overlapping Yjs event ranges",
                )?;
                previous_end = clock + length;
                out.push((client, clock, length));
            }
        }
        Ok(out)
    }
    fn end(&self) -> Result<(), String> {
        require(self.at == self.bytes.len(), "trailing Yjs bytes")
    }
}
fn snapshot(bytes: &[u8]) -> Result<(), String> {
    require(
        !bytes.is_empty() && bytes.len() <= MAX_SNAPSHOT_BYTES,
        "snapshot byte budget",
    )?;
    let mut r = YjsReader::new(bytes);
    r.ds()?;
    let count = r.count()?;
    let mut previous = None;
    for _ in 0..count {
        let client = r.uint()?;
        require(
            previous.is_none_or(|p| client < p),
            "noncanonical snapshot state vector",
        )?;
        previous = Some(client);
        r.uint()?;
    }
    r.end()
}
fn event(bytes: &[u8], declared: &[SourceRange]) -> Result<(), String> {
    let mut r = YjsReader::new(bytes);
    require(r.uint()? == 0, "original event contains structs")?;
    let mut ds = r.event_ds()?;
    r.end()?;
    ds.sort();
    let expected: Vec<_> = declared
        .iter()
        .map(|r| (r.client, r.clock as u64, r.length as u64))
        .collect();
    require(
        ds == expected,
        "exact event DeleteSet differs from declared ranges",
    )
}
fn evidence(payload: &Node) -> Result<Option<(Vec<u8>, Vec<SourceRange>)>, String> {
    if !payload.has("sourceRetentionProvenance") {
        return Ok(None);
    }
    let update = payload.field("update")?.bytes()?;
    require(!update.is_empty(), "empty Yjs update")?;
    let p = payload.field("sourceRetentionProvenance")?;
    require(
        p.field("version")?.uint(MAX_SAFE)? == 1,
        "unsupported evidence version",
    )?;
    match p.field("kind")?.text()? {
        "state-transfer" => {
            p.keys(&["version", "kind"])?;
            Ok(None)
        }
        "transaction-event" => {
            p.keys(&["version", "kind", "beforeSnapshot", "transactionDeletes"])?;
            let b = p.field("beforeSnapshot")?.bytes()?;
            snapshot(b)?;
            Ok(Some((b.to_vec(), ranges(p.field("transactionDeletes")?)?)))
        }
        _ => Err(reject("unknown evidence kind")),
    }
}
pub fn verify_change_set(
    envelope: &[u8],
    expected: &ChangeSetRef,
) -> Result<VerifiedChangeSet, String> {
    require(
        !envelope.is_empty() && envelope.len() <= MAX_ORIGINAL_ENVELOPE_BYTES,
        "original envelope byte budget",
    )?;
    require(
        hash_shape(&expected.original_envelope_sha256, false)
            && digest(envelope) == expected.original_envelope_sha256,
        "original envelope hash mismatch",
    )?;
    let root = canonical::decode(envelope)?;
    root.keys(&[
        "protocol",
        "protocolVersion",
        "payloadVersion",
        "projectId",
        "projectSyncId",
        "syncGenerationId",
        "changeSetId",
        "writerId",
        "writerEpoch",
        "deviceSeq",
        "hlc",
        "mutations",
    ])?;
    require(
        root.field("protocol")?.text()? == "drifting.sync.changeset",
        "unexpected protocol",
    )?;
    require(
        root.field("protocolVersion")?.uint(MAX_SAFE)? == 1
            && root.field("payloadVersion")?.uint(MAX_SAFE)? == 1,
        "unsupported envelope version",
    )?;
    for (key, wanted) in [
        ("projectId", &expected.project_id),
        ("projectSyncId", &expected.project_sync_id),
        ("syncGenerationId", &expected.sync_generation_id),
    ] {
        let value = root.field(key)?.text()?;
        require(
            opaque(value) && value == wanted,
            "project/generation binding mismatch",
        )?;
    }
    let writer = root.field("writerId")?.text()?;
    let epoch = root.field("writerEpoch")?.text()?;
    let seq = root.field("deviceSeq")?.uint(MAX_SAFE)?;
    require(
        token(writer) && token(epoch) && seq > 0,
        "invalid writer identity",
    )?;
    let cs = root.field("changeSetId")?.text()?;
    require(
        (5..=300).contains(&cs.encode_utf16().count())
            && cs == format!("{writer}:{epoch}:{seq}")
            && cs == expected.change_set_id,
        "change-set binding mismatch",
    )?;
    let hlc = root.field("hlc")?;
    hlc.keys(&["wallMs", "counter"])?;
    hlc.field("wallMs")?.uint(MAX_SAFE)?;
    hlc.field("counter")?.uint(MAX_SAFE)?;
    let list = root.field("mutations")?.array()?;
    require(
        !list.is_empty() && list.len() <= MAX_RANGES,
        "invalid mutation count",
    )?;
    let mut verified = Vec::new();
    for (index, m) in list.iter().enumerate() {
        m.keys(&[
            "index",
            "target",
            "action",
            "payloadVersion",
            "payload",
            "payloadSha256",
        ])?;
        require(
            m.field("index")?.uint(MAX_SAFE)? == index as u64,
            "mutation index mismatch",
        )?;
        let t = target(m.field("target")?)?;
        let action = m.field("action")?.text()?;
        require(
            family(action) == Some(t.family.as_str()),
            "mutation action/family mismatch",
        )?;
        let version = m.field("payloadVersion")?.uint(MAX_SAFE)?;
        require(version == 1, "unsupported mutation version")?;
        let payload = m.field("payload")?;
        let payload_bytes = envelope[payload.span.clone()].to_vec();
        let hash = m.field("payloadSha256")?.text()?;
        require(
            hash_shape(hash, true) && hash == format!("sha256:{}", digest(&payload_bytes)),
            "mutation payload hash mismatch",
        )?;
        if action == "yjs.update" && payload.has("sourceRetentionProvenance") {
            evidence(payload)?;
        }
        verified.push(VerifiedMutation {
            index: index as u64,
            target: t,
            action: action.into(),
            payload_version: version,
            payload_sha256: hash.into(),
            canonical_payload_bytes: payload_bytes,
        });
    }
    Ok(VerifiedChangeSet {
        source: expected.clone(),
        writer_id: writer.into(),
        writer_epoch: epoch.into(),
        device_seq: seq,
        hlc_wall_ms: hlc.field("wallMs")?.uint(MAX_SAFE)?,
        hlc_counter: hlc.field("counter")?.uint(MAX_SAFE)?,
        mutations: verified,
    })
}
pub fn verify_original_operation(
    envelope: &[u8],
    expected: &OriginalOperationRef,
) -> Result<VerifiedOriginalOperation, String> {
    let verified = verify_change_set(envelope, &ChangeSetRef::from(expected))?;
    select_original_operation(verified, expected)
}
// A verified envelope can be narrowed, never constructed, by the SQLite reader.
pub(crate) fn select_original_operation(
    verified: VerifiedChangeSet,
    expected: &OriginalOperationRef,
) -> Result<VerifiedOriginalOperation, String> {
    require(
        verified.source == ChangeSetRef::from(expected),
        "original reference binding mismatch",
    )?;
    let index =
        usize::try_from(expected.mutation_index).map_err(|_| reject("selected mutation absent"))?;
    let selected = verified
        .mutations
        .get(index)
        .ok_or_else(|| reject("selected mutation absent"))?;
    require(
        selected.target == expected.target
            && selected.target.family == "yjs"
            && selected.target.kind == "prose-document"
            && selected.action == "yjs.update"
            && selected.payload_sha256 == expected.payload_sha256,
        "selected mutation binding mismatch",
    )?;
    let payload_root = canonical::decode(&selected.canonical_payload_bytes)?;
    let payload = &payload_root;
    let (before_snapshot, declared) =
        evidence(payload)?.ok_or_else(|| reject("original transaction evidence required"))?;
    let update = payload.field("update")?.bytes()?;
    require(!update.is_empty(), "empty event")?;
    let intent = payload.field("sourceOperationIntent")?;
    intent.keys(&[
        "version",
        "kind",
        "targetText",
        "offsetUTF16",
        "lengthUTF16",
        "selectedSourceRanges",
    ])?;
    require(
        intent.field("version")?.uint(MAX_SAFE)? == 1
            && intent.field("kind")?.text()? == "prose.text.delete",
        "unsupported operation intent",
    )?;
    let text = intent.field("targetText")?;
    text.keys(&["client", "clock"])?;
    let target_text = SourceId {
        client: text.field("client")?.uint(MAX_SAFE)?,
        clock: text.field("clock")?.uint(u32::MAX as u64 - 1)? as u32,
    };
    let offset = intent.field("offsetUTF16")?.uint(MAX_SAFE)?;
    let length = intent.field("lengthUTF16")?.uint(MAX_SAFE)?;
    let selected_ranges = ranges(intent.field("selectedSourceRanges")?)?;
    require(
        length > 0
            && offset
                .checked_add(length)
                .is_some_and(|end| end <= MAX_SAFE)
            && selected_ranges == declared
            && declared.iter().map(|r| r.length as u64).sum::<u64>() == length,
        "intent range/length mismatch",
    )?;
    event(update, &declared)?;
    let exact_update = update.to_vec();
    Ok(VerifiedOriginalOperation {
        source: expected.clone(),
        change_set: verified,
        exact_update,
        before_snapshot,
        intent: DeclaredTextDelete {
            target_text,
            offset_utf16: offset,
            length_utf16: length,
            selected_source_ranges: declared,
        },
    })
}
