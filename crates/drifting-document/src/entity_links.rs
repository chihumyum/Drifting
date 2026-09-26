//! Entity links inside prose, with the renderer's auto-detect semantics:
//! every registered name matched verbatim (case-sensitive, no word
//! boundaries), longest name first at each position, non-overlapping, per
//! uniform mark run. Links are written under the same overlapping-mark key
//! y-tiptap uses (`entityLink--<hash>`), in a transaction that is authored
//! (journaled) but not an undo step, like the renderer's `addToHistory:false`.
use super::*;
use serde::Serialize;
use sha2::{Digest, Sha256};

pub(crate) const ENTITY_LINK: &str = "native-entity-link";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntityLinkTarget {
    pub name: String,
    pub kind: String,
    pub id: String,
}

/// One link found in the current projection, for backlinks and navigation.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityLinkSpan {
    pub block_id: Option<String>,
    pub range: NativeRange,
    pub kind: String,
    pub id: String,
}

/// lib0 `encodeAny` for the strings and objects of `mark.toJSON()`.
fn write_uint(out: &mut Vec<u8>, mut value: usize) {
    while value > 0x7f {
        out.push(0x80 | (value & 0x7f) as u8);
        value >>= 7;
    }
    out.push(value as u8);
}
fn write_string(out: &mut Vec<u8>, value: &str) {
    write_uint(out, value.len());
    out.extend_from_slice(value.as_bytes());
}

/// y-tiptap's overlapping-mark key: base64 of the SHA-256 digest folded to 6
/// bytes, over lib0's encoding of `{type:"entityLink",attrs:{...}}`.
pub(crate) fn entity_link_key(kind: &str, id: &str) -> String {
    let mut bytes = vec![118];
    write_uint(&mut bytes, 2);
    write_string(&mut bytes, "type");
    bytes.push(119);
    write_string(&mut bytes, "entityLink");
    write_string(&mut bytes, "attrs");
    bytes.push(118);
    write_uint(&mut bytes, 3);
    for (key, value) in [
        ("targetKind", Some(kind)),
        ("targetId", Some(id)),
        ("targetBlockId", None),
    ] {
        write_string(&mut bytes, key);
        match value {
            Some(value) => {
                bytes.push(119);
                write_string(&mut bytes, value);
            }
            None => bytes.push(126),
        }
    }
    let mut digest: Vec<u8> = Sha256::digest(&bytes).to_vec();
    for i in 6..digest.len() {
        digest[i % 6] ^= digest[i];
    }
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut key = String::from("entityLink--");
    for chunk in digest[..6].chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(chunk[1]) << 8) | u32::from(chunk[2]);
        for shift in [18, 12, 6, 0] {
            key.push(TABLE[((n >> shift) & 63) as usize] as char);
        }
    }
    key
}

pub(crate) fn is_entity_link_key(name: &str) -> bool {
    name == "entityLink"
        || name
            .strip_prefix("entityLink--")
            .is_some_and(|hash| hash.len() == 8)
}

/// The renderer's `Map` semantics: first insertion fixes a name's position,
/// the last target set for it wins; empty names are ignored. Names are then
/// tried longest (UTF-16 length) first, stable within equal lengths.
pub(crate) fn matcher(targets: &[EntityLinkTarget]) -> Vec<(Vec<u16>, &EntityLinkTarget)> {
    let mut names: Vec<(Vec<u16>, &EntityLinkTarget)> = Vec::new();
    for target in targets.iter().filter(|target| !target.name.is_empty()) {
        let units: Vec<u16> = target.name.encode_utf16().collect();
        match names.iter_mut().find(|(name, _)| *name == units) {
            Some(existing) => existing.1 = target,
            None => names.push((units, target)),
        }
    }
    names.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    names
}

/// Leftmost-longest, non-overlapping matches over UTF-16 units, exactly as the
/// renderer's single alternation regex (no `u` flag) scans a text node.
pub(crate) fn detect(
    text: &[u16],
    names: &[(Vec<u16>, &EntityLinkTarget)],
) -> Vec<(u32, u32, usize)> {
    let mut found = Vec::new();
    let mut at = 0;
    while at < text.len() {
        match names
            .iter()
            .position(|(name, _)| text[at..].starts_with(name))
        {
            Some(index) => {
                let length = names[index].0.len();
                found.push((at as u32, length as u32, index));
                at += length;
            }
            None => at += 1,
        }
    }
    found
}

fn links_in(attributes: &Map<String, Value>) -> Vec<(String, String)> {
    attributes
        .iter()
        .filter(|(key, _)| is_entity_link_key(key))
        .filter_map(|(_, value)| {
            Some((
                value.get("targetKind")?.as_str()?.to_owned(),
                value.get("targetId")?.as_str()?.to_owned(),
            ))
        })
        .collect()
}

impl DocumentSession {
    /// Link every unlinked occurrence of a registered name. Runs already
    /// linked to the same target are skipped; links to other targets remain
    /// alongside. Returns how many spans were linked; zero writes nothing.
    /// Refused while a draft or composition is active (the host retries).
    pub fn link_entities(&mut self, targets: &[EntityLinkTarget]) -> Result<usize, String> {
        if self.active_drafts() > 0 || self.active_input_compositions() > 0 {
            return Ok(0);
        }
        let names = matcher(targets);
        if names.is_empty() {
            return Ok(0);
        }
        let view = self.native_projection()?;
        let units: Vec<u16> = view.text.encode_utf16().collect();
        let mut spans = Vec::new();
        for block in view.blocks.iter().filter(|block| block.editable) {
            let Some(id) = block.id.as_deref() else {
                continue;
            };
            // ProseMirror merges adjacent text with equal marks into one node.
            let mut runs: Vec<(u32, u32, &Map<String, Value>)> = Vec::new();
            for run in &block.runs {
                match runs.last_mut() {
                    Some(last)
                        if last.0 + last.1 == run.range.location && last.2 == &run.attributes =>
                    {
                        last.1 += run.range.length
                    }
                    _ => runs.push((run.range.location, run.range.length, &run.attributes)),
                }
            }
            for (location, length, attributes) in runs {
                let existing = links_in(attributes);
                let text = &units[location as usize..(location + length) as usize];
                for (offset, span, index) in detect(text, &names) {
                    let target = names[index].1;
                    if existing
                        .iter()
                        .any(|(kind, id)| *kind == target.kind && *id == target.id)
                    {
                        continue;
                    }
                    spans.push((
                        id.to_owned(),
                        location - block.range.location + offset,
                        span,
                        target.clone(),
                    ));
                }
            }
        }
        if spans.is_empty() {
            return Ok(0);
        }
        {
            let mut txn = self.doc.transact_mut_with(ENTITY_LINK);
            for (block, offset, length, target) in &spans {
                let text = self.editable_text(&txn, block)?;
                let value = Any::from_json(
                    &json!({"targetKind": target.kind, "targetId": target.id, "targetBlockId": null}).to_string(),
                )
                .map_err(|e| e.to_string())?;
                text.format(
                    &mut txn,
                    *offset,
                    *length,
                    Attrs::from([(entity_link_key(&target.kind, &target.id).into(), value)]),
                );
            }
        }
        self.revision += 1;
        Ok(spans.len())
    }

    /// Every entity link in the current projection, in document order.
    pub fn entity_link_spans(&self) -> Result<Vec<EntityLinkSpan>, String> {
        let view = self.native_projection()?;
        let mut spans = Vec::new();
        for block in &view.blocks {
            for run in &block.runs {
                for (kind, id) in links_in(&run.attributes) {
                    spans.push(EntityLinkSpan {
                        block_id: block.id.clone(),
                        range: run.range.clone(),
                        kind,
                        id,
                    });
                }
            }
        }
        Ok(spans)
    }
}
