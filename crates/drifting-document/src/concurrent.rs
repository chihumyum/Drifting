//! Structural drafts may merge with disjoint inline edits. Copied/deleted text
//! must still have the exact authored identities, marks and parent context.
use super::*;

const RETAINED: &str =
    "Concurrent structural context changed; explicit reconciliation required; draft retained";

fn attributes<T: ReadTxn>(element: &impl Xml, txn: &T) -> Result<Attrs, String> {
    element
        .attributes(txn)
        .map(|(key, value)| match value {
            Out::Any(value) => Ok((key.into(), value)),
            _ => Err(RETAINED.to_owned()),
        })
        .collect()
}

/// Entity links are derived marks that a background pass re-applies; a draft
/// that crossed such a pass still has the author's exact text and marks.
fn authored_marks(mut attributes: Attrs) -> Attrs {
    attributes.retain(|key, _| !crate::formatting::is_mark(key, "entityLink"));
    attributes
}

#[derive(PartialEq)]
struct Context {
    identity: String,
    parent: String,
    kind: String,
    attributes: Attrs,
}

fn topology(session: &DocumentSession) -> Result<Vec<Context>, String> {
    let txn = session.doc.transact();
    session
        .root
        .successors(&txn)
        .filter_map(|node| match node {
            XmlOut::Element(element) => Some(element),
            _ => None,
        })
        .map(|element| {
            // Container metadata participates in structural fitting. Compare raw
            // CRDT values: JSON would conflate binary buffers and number arrays.
            let attributes = if matches!(
                element.tag().as_ref(),
                "blockquote" | "bulletList" | "orderedList" | "listItem"
            ) {
                attributes(&element, &txn)?
            } else {
                Attrs::new()
            };
            Ok(Context {
                identity: format!("{:?}", XmlOut::Element(element.clone()).id()),
                parent: format!("{:?}", element.parent().map(|p| p.id())),
                kind: element.tag().to_string(),
                attributes,
            })
        })
        .collect()
}

#[derive(PartialEq)]
struct TextContext {
    attributes: Attrs,
    runs: Vec<(String, Attrs)>,
}

#[derive(PartialEq)]
struct BlockContext {
    attributes: Attrs,
    texts: Vec<TextContext>,
}

fn affected_context(
    session: &DocumentSession,
    blocks: &[NativeBlock],
) -> Result<Vec<BlockContext>, String> {
    let txn = session.doc.transact();
    blocks
        .iter()
        .map(|block| {
            let element = session.editable_block(&txn, block.id.as_deref().ok_or(RETAINED)?)?;
            let mut texts = Vec::new();
            for child in element.children(&txn) {
                let XmlOut::Text(text) = child else {
                    return Err(RETAINED.to_owned());
                };
                // Runs that differ only in derived marks read as one run.
                let mut runs: Vec<(String, Attrs)> = Vec::new();
                for run in text.diff(&txn, YChange::identity) {
                    let Out::Any(Any::String(value)) = run.insert else {
                        return Err(RETAINED.to_owned());
                    };
                    let marks = authored_marks(run.attributes.map(|a| *a).unwrap_or_default());
                    match runs.last_mut() {
                        Some((text, previous)) if *previous == marks => text.push_str(&value),
                        _ => runs.push((value.to_string(), marks)),
                    }
                }
                texts.push(TextContext {
                    attributes: attributes(&text, &txn)?,
                    runs,
                });
            }
            Ok(BlockContext {
                attributes: attributes(&element, &txn)?,
                texts,
            })
        })
        .collect()
}

struct ItemRun {
    id: yrs::ID,
    length: u32,
    attributes: Attrs,
}

struct TextTape {
    identity: Vec<u8>,
    attributes: Attrs,
    text_attributes: Attrs,
    runs: Vec<ItemRun>,
}

fn text_tape(session: &DocumentSession, id: &str) -> Result<TextTape, String> {
    let mut txn = session.doc.transact_mut_with("native-draft-index");
    let element = session.editable_block(&txn, id)?;
    let Some(XmlOut::Text(text)) = element.get(&txn, 0) else {
        return Err(RETAINED.to_owned());
    };
    if element.len(&txn) != 1 {
        return Err(RETAINED.to_owned());
    }
    let current = txn.snapshot();
    let empty = yrs::Snapshot::default();
    let runs = text
        .diff_range(&mut txn, Some(&current), Some(&empty), YChange::identity)
        .into_iter()
        .map(|run| {
            let Out::Any(Any::String(value)) = run.insert else {
                return Err(RETAINED.to_owned());
            };
            Ok(ItemRun {
                id: run.ychange.ok_or(RETAINED)?.id,
                length: value.encode_utf16().count() as u32,
                attributes: authored_marks(run.attributes.map(|attrs| *attrs).unwrap_or_default()),
            })
        })
        .collect::<Result<_, String>>()?;
    Ok(TextTape {
        identity: StickyIndex::from_type(&txn, &text, Assoc::Before).encode_v1(),
        attributes: attributes(&element, &txn)?,
        text_attributes: attributes(&text, &txn)?,
        runs,
    })
}

/// The existing split keeps the original prefix and reconstructs its tail.
/// Permit only additional prefix items: every old character and its raw marks
/// must survive, including the entire copied tail. No per-character tape is
/// needed; formatting/item splits are compared by continuous CRDT clocks.
fn prefix_insertions(old: &TextTape, live: &TextTape, cut: u32) -> Result<u32, String> {
    if old.identity != live.identity
        || old.attributes != live.attributes
        || old.text_attributes != live.text_attributes
    {
        return Err(RETAINED.to_owned());
    }
    let (mut index, mut consumed, mut old_offset, mut live_offset) = (0, 0, 0, 0);
    let mut live_cut = None;
    for run in &live.runs {
        let mut at = 0;
        while at < run.length {
            let original = old.runs.get(index).ok_or(RETAINED)?;
            if original.id.client == run.id.client
                && original.id.clock + consumed == run.id.clock + at
            {
                if original.attributes != run.attributes {
                    return Err(RETAINED.to_owned());
                }
                let length = (original.length - consumed).min(run.length - at);
                if old_offset < cut && cut <= old_offset + length {
                    live_cut = Some(live_offset + cut - old_offset);
                }
                old_offset += length;
                live_offset += length;
                consumed += length;
                at += length;
                if consumed == original.length {
                    index += 1;
                    consumed = 0;
                }
            } else {
                if old_offset >= cut {
                    return Err(RETAINED.to_owned());
                }
                // A removed or reordered original item cannot pass: it would
                // remain unmatched when the complete old tape is checked below.
                live_offset += run.length - at;
                at = run.length;
            }
        }
    }
    if index != old.runs.len() || consumed != 0 {
        return Err(RETAINED.to_owned());
    }
    live_cut.ok_or_else(|| RETAINED.to_owned())
}

/// A separate pure-deletion path keeps the insertion policy unchanged. Every
/// live span must be an ordered original span with its original marks; gaps
/// may only remove prefix items. The whole copied tail must remain intact.
/// Continuous clocks handle item/format-run splits without text matching or a
/// per-character index, including deletion of the entire original prefix.
fn prefix_deletions(old: &TextTape, live: &TextTape, cut: u32) -> Result<u32, String> {
    if old.identity != live.identity
        || old.attributes != live.attributes
        || old.text_attributes != live.text_attributes
    {
        return Err(RETAINED.to_owned());
    }
    let (mut index, mut old_base, mut previous, mut live_offset) = (0, 0, 0, 0);
    let mut live_cut = None;
    for run in &live.runs {
        let mut at = 0;
        while at < run.length {
            let source = loop {
                let original = old.runs.get(index).ok_or(RETAINED)?;
                let clock = run.id.clock + at;
                if original.id.client == run.id.client
                    && original.id.clock <= clock
                    && clock < original.id.clock + original.length
                {
                    break original;
                }
                old_base += original.length;
                index += 1;
            };
            let offset = run.id.clock + at - source.id.clock;
            let location = old_base + offset;
            if location < previous
                || (location > previous && location > cut)
                || source.attributes != run.attributes
            {
                return Err(RETAINED.to_owned());
            }
            let length = (source.length - offset).min(run.length - at);
            if location <= cut && cut <= location + length {
                live_cut = Some(live_offset + cut - location);
            }
            previous = location + length;
            live_offset += length;
            at += length;
            if offset + length == source.length {
                old_base += source.length;
                index += 1;
            }
        }
    }
    if previous != old.runs.iter().map(|run| run.length).sum::<u32>() {
        return Err(RETAINED.to_owned());
    }
    live_cut.ok_or_else(|| RETAINED.to_owned())
}

pub(crate) struct ConcurrentStructure {
    pub before: NativeProjection,
    pub range: NativeRange,
    pub first: usize,
    pub last: usize,
    pub lineage_before: crate::lineage::Layout,
}

impl DocumentSession {
    pub(crate) fn disjoint_structural_range(
        &self,
        author: &DocumentSession,
        range: &NativeRange,
        text: &str,
    ) -> Result<ConcurrentStructure, String> {
        let old = author.native_projection()?;
        let live = self.native_projection()?;
        let block_at = |at| {
            old.blocks.iter().position(|block| {
                block.range.location <= at && at <= block.range.location + block.range.length
            })
        };
        let first = block_at(range.location).ok_or(RETAINED)?;
        let last = block_at(range.location + range.length).ok_or(RETAINED)?;
        let affected = &old.blocks[first..=last];
        // Cross-container replacement can copy additional following subtrees.
        // Its separate reconciliation policy must account for those identities.
        if affected
            .iter()
            .any(|block| block.container != affected[0].container)
            || topology(self)? != topology(author)?
            || old.blocks.len() != live.blocks.len()
        {
            return Err(RETAINED.to_owned());
        }
        let current = &live.blocks[first..=last];
        let unchanged = !affected.iter().zip(current).any(|(old, live)| {
            old.id != live.id || !live.editable || old.range.length != live.range.length
        }) && affected_context(author, affected)?
            == affected_context(self, current)?
            && author
                .capture_lineage(affected)?
                .same_items(&self.capture_lineage(current)?);
        let (location, length) = if unchanged {
            let location = current[0].range.location + range.location - affected[0].range.location;
            let end = current.last().unwrap().range.location + range.location + range.length
                - affected.last().unwrap().range.location;
            (location, end - location)
        } else if first == last
            && text == "\n"
            && range.length == 0
            && affected[0].kind == "paragraph"
            && affected[0].id == current[0].id
            && current[0].editable
        {
            let cut = range.location - affected[0].range.location;
            if cut == 0 || cut >= affected[0].range.length {
                return Err(RETAINED.to_owned());
            }
            let id = affected[0].id.as_deref().ok_or(RETAINED)?;
            let anchor = author.anchor(id, cut, false)?;
            let old_tape = text_tape(author, id)?;
            let live_tape = text_tape(self, id)?;
            let live_cut = prefix_insertions(&old_tape, &live_tape, cut)
                .or_else(|_| prefix_deletions(&old_tape, &live_tape, cut))?;
            let resolved = self.resolve_anchor(&anchor)?.ok_or(RETAINED)?;
            if resolved["block"].as_str() != Some(id)
                || resolved["offset"].as_u64() != Some(u64::from(live_cut))
            {
                return Err(RETAINED.to_owned());
            }
            (current[0].range.location + live_cut, 0)
        } else {
            return Err(RETAINED.to_owned());
        };
        let lineage_before = self.capture_lineage(current)?;
        Ok(ConcurrentStructure {
            before: live,
            range: NativeRange { location, length },
            first,
            last,
            lineage_before,
        })
    }
}
