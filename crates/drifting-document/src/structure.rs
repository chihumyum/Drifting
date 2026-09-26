//! Structural edits retain a physical survivor and unaffected CRDT items.
//! New blocks get UUIDv7 identities; reconstructed text carries exact marks.
use super::*;
use serde::Serialize;
use uuid::Uuid;
mod containers;

#[derive(Clone, Debug, Serialize)]
struct MappingBlock {
    id: Option<String>,
    range: NativeRange,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMappedPoint {
    pub block: String,
    pub offset: u32,
    pub deleted: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeEditMap {
    pub replaced: NativeRange,
    pub inserted_length: u32,
    before: Vec<MappingBlock>,
    after: Vec<MappingBlock>,
}

impl NativeEditMap {
    pub(crate) fn reversed(&self) -> Self {
        Self {
            replaced: NativeRange {
                location: self.replaced.location,
                length: self.inserted_length,
            },
            inserted_length: self.replaced.length,
            before: self.after.clone(),
            after: self.before.clone(),
        }
    }

    pub(crate) fn map_block_targets(&self, ids: &[String]) -> Vec<String> {
        let mut targets = Vec::new();
        for id in ids {
            let Some(source) = self
                .before
                .iter()
                .find(|block| block.id.as_ref() == Some(id))
            else {
                continue;
            };
            if let (Some(start), Some(end)) = (
                self.map_point(id, 0, false),
                self.map_point(id, source.range.length, true),
            ) {
                if let (Some(first), Some(last)) = (
                    self.after
                        .iter()
                        .position(|b| b.id.as_ref() == Some(&start.block)),
                    self.after
                        .iter()
                        .position(|b| b.id.as_ref() == Some(&end.block)),
                ) {
                    if first <= last {
                        for block in &self.after[first..=last] {
                            if let Some(id) = &block.id {
                                if !targets.contains(id) {
                                    targets.push(id.clone());
                                }
                            }
                        }
                    }
                }
            }
        }
        targets
    }

    pub(crate) fn new(
        before: &NativeProjection,
        after: &NativeProjection,
        edit: &NativeReplacement,
    ) -> Self {
        let blocks = |view: &NativeProjection| {
            view.blocks
                .iter()
                .map(|block| MappingBlock {
                    id: block.id.clone(),
                    range: block.range.clone(),
                })
                .collect()
        };
        Self {
            replaced: edit.range.clone(),
            inserted_length: edit.text.encode_utf16().count() as u32,
            before: blocks(before),
            after: blocks(after),
        }
    }

    /// Mapping is for the exact before/after pair, not future remote updates.
    /// Callers may create fresh CRDT relative positions from the mapped points.
    pub fn map_point(&self, block: &str, offset: u32, before: bool) -> Option<NativeMappedPoint> {
        let mut matches = self
            .before
            .iter()
            .filter(|entry| entry.id.as_deref() == Some(block));
        let source = matches.next()?;
        if matches.next().is_some() || offset > source.range.length {
            return None;
        }
        let point = source.range.location + offset;
        let start = self.replaced.location;
        let end = start + self.replaced.length;
        let (mapped, deleted) = if point < start {
            (point, false)
        } else if point > end {
            (point - self.replaced.length + self.inserted_length, false)
        } else if self.replaced.length > 0 && point == end {
            (start + self.inserted_length, false)
        } else {
            (
                start + if before { 0 } else { self.inserted_length },
                point > start && point < end,
            )
        };
        let target = self.after.iter().find(|entry| {
            entry.range.location <= mapped && mapped <= entry.range.location + entry.range.length
        })?;
        Some(NativeMappedPoint {
            block: target.id.clone()?,
            offset: mapped - target.range.location,
            deleted,
        })
    }

    /// Preserve the original quote and all unknown fields. Only live endpoints
    /// and target IDs change; original block snapshots belong to the caller.
    pub fn map_comment_anchor(&self, anchor: &Value) -> Option<Value> {
        let start = self.map_point(
            anchor["startBlockId"].as_str()?,
            u32::try_from(anchor["startOffset"].as_u64()?).ok()?,
            false,
        )?;
        let end = self.map_point(
            anchor["endBlockId"].as_str()?,
            u32::try_from(anchor["endOffset"].as_u64()?).ok()?,
            true,
        )?;
        let start_index = self
            .after
            .iter()
            .position(|block| block.id.as_deref() == Some(&start.block))?;
        let end_index = self
            .after
            .iter()
            .position(|block| block.id.as_deref() == Some(&end.block))?;
        let collapsed =
            start_index > end_index || (start_index == end_index && start.offset >= end.offset);
        let mut mapped = anchor.clone();
        mapped["startBlockId"] = json!(start.block);
        mapped["startOffset"] = json!(start.offset);
        mapped["endBlockId"] = json!(end.block);
        mapped["endOffset"] = json!(end.offset);
        let ids: Vec<_> = if collapsed {
            Vec::new()
        } else {
            self.after[start_index..=end_index]
                .iter()
                .filter_map(|block| block.id.clone())
                .collect()
        };
        Some(
            json!({"textAnchor": mapped, "targetBlockIds": ids, "collapsed": collapsed,
            "endpointDeleted": start.deleted || end.deleted}),
        )
    }
}

struct Parent(XmlOut);
impl AsRef<yrs::branch::Branch> for Parent {
    fn as_ref(&self) -> &yrs::branch::Branch {
        self.0.as_ref()
    }
}
impl XmlFragment for Parent {}

pub(crate) fn structural_attribute(key: &str) -> bool {
    !matches!(key, "id" | "level" | "indent" | "textAlign")
}

// NativeProjection is a display value. Its JSON attributes cannot round-trip
// Yjs values such as Uint8Array or undefined, so all prose mutations inherit
// marks directly from the authoritative XmlText.
struct SourceRun {
    range: NativeRange,
    text: std::sync::Arc<str>,
    attributes: Attrs,
}

fn source_runs<T: ReadTxn>(
    block: &NativeBlock,
    element: &XmlElementRef,
    txn: &T,
) -> Result<Vec<SourceRun>, String> {
    let Some(XmlOut::Text(text)) = element.get(txn, 0) else {
        return if block.range.length == 0 {
            Ok(Vec::new())
        } else {
            Err("Missing source text for native marks".into())
        };
    };
    let mut runs = Vec::new();
    let mut at = block.range.location;
    for part in text.diff(txn, YChange::identity) {
        let Out::Any(Any::String(text)) = part.insert else {
            return Err("Unsupported source text for native marks".into());
        };
        let length = text.encode_utf16().count() as u32;
        let mut attributes = part.attributes.map(|attrs| *attrs).unwrap_or_default();
        attributes.retain(|_, value| *value != Any::Null);
        runs.push(SourceRun {
            range: NativeRange {
                location: at,
                length,
            },
            text,
            attributes,
        });
        at += length;
    }
    if at != block.range.location + block.range.length {
        return Err("Source text changed while reading native marks".into());
    }
    Ok(runs)
}

fn inherited_marks(block: &NativeBlock, runs: &[SourceRun], at: u32) -> Attrs {
    let left = runs.iter().find(|run| {
        (run.range.location < at && at <= run.range.location + run.range.length)
            || (at == block.range.location && at == run.range.location)
    });
    let mut result = left.map(|run| run.attributes.clone()).unwrap_or_default();
    // Mark runs may split because of bold/italic inside one entity link. Link
    // affinity depends on adjacent link values, not on the run boundary alone.
    let links: Vec<_> = left
        .into_iter()
        .flat_map(|run| run.attributes.iter())
        .filter(|(name, _)| is_entity_link(name))
        .collect();
    for (name, link) in links {
        let inside_left = runs.iter().any(|run| {
            run.range.location < at
                && at <= run.range.location + run.range.length
                && run.attributes.get(name) == Some(link)
        });
        let inside_right = runs.iter().any(|run| {
            run.range.location <= at
                && at < run.range.location + run.range.length
                && run.attributes.get(name) == Some(link)
        });
        if !inside_left || !inside_right {
            result.remove(name.as_ref());
        }
    }
    result
}

fn is_entity_link(name: &str) -> bool {
    name == "entityLink"
        || name.strip_prefix("entityLink--").is_some_and(|suffix| {
            suffix.len() == 8
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"+/=".contains(&byte))
        })
}

pub(crate) fn replacement_marks<T: ReadTxn>(
    first: &NativeBlock,
    last: &NativeBlock,
    edit: &NativeReplacement,
    first_element: &XmlElementRef,
    last_element: &XmlElementRef,
    txn: &T,
) -> Result<Attrs, String> {
    let first_runs = source_runs(first, first_element, txn)?;
    let mut marks = inherited_marks(first, &first_runs, edit.range.location);
    if edit.range.length > 0 {
        let last_runs;
        let runs = if first_element == last_element {
            &first_runs
        } else {
            last_runs = source_runs(last, last_element, txn)?;
            &last_runs
        };
        let end = edit.range.location + edit.range.length;
        marks.retain(|name, value| {
            !is_entity_link(name)
                || runs.iter().any(|run| {
                    run.range.location <= end
                        && end < run.range.location + run.range.length
                        && run.attributes.get(name) == Some(value)
                })
        });
    }
    Ok(marks)
}

fn text_slice(text: &str, start: u32, end: u32) -> Result<String, String> {
    let units: Vec<_> = text.encode_utf16().collect();
    String::from_utf16(&units[start as usize..end as usize])
        .map_err(|_| "Invalid UTF-16 slice".into())
}

struct TailRun {
    text: String,
    marks: Attrs,
}
fn range_runs<T: ReadTxn>(
    block: &NativeBlock,
    element: &XmlElementRef,
    txn: &T,
    from: u32,
    to: u32,
) -> Result<Vec<TailRun>, String> {
    let mut runs = Vec::new();
    for run in source_runs(block, element, txn)? {
        let start = run.range.location.max(from);
        let end = (run.range.location + run.range.length).min(to);
        if start < end {
            runs.push(TailRun {
                text: text_slice(
                    &run.text,
                    start - run.range.location,
                    end - run.range.location,
                )?,
                marks: run.attributes,
            });
        }
    }
    Ok(runs)
}

fn tail_runs<T: ReadTxn>(
    block: &NativeBlock,
    element: &XmlElementRef,
    txn: &T,
    from: u32,
) -> Result<Vec<TailRun>, String> {
    range_runs(
        block,
        element,
        txn,
        from,
        block.range.location + block.range.length,
    )
}

fn insert_runs(text: &XmlTextRef, txn: &mut yrs::TransactionMut, mut at: u32, runs: Vec<TailRun>) {
    for run in runs {
        text.insert_with_attributes(txn, at, &run.text, run.marks);
        at += run.text.encode_utf16().count() as u32;
    }
}

// XmlText owns a separate attribute map that is not part of inline mark runs
// or NativeProjection. Preserve typed future metadata when splitting/copying
// text; conflicting values must be resolved before any LOCAL mutation.
fn text_attributes<T: ReadTxn>(elements: &[XmlElementRef], txn: &T) -> Result<Attrs, String> {
    let mut merged = Attrs::new();
    for element in elements {
        if let Some(XmlOut::Text(text)) = element.get(txn, 0) {
            for (key, value) in text.attributes(txn) {
                let Out::Any(value) = value else {
                    return Err("Cannot copy shared XML text metadata".into());
                };
                if merged.get(key).is_some_and(|old| old != &value) {
                    return Err("Cannot merge conflicting XML text metadata".into());
                }
                merged.insert(key.into(), value);
            }
        }
    }
    Ok(merged)
}

fn preserve_text_attributes(text: &XmlTextRef, txn: &mut yrs::TransactionMut, attrs: &Attrs) {
    for (key, value) in attrs {
        if !matches!(text.get_attribute(txn, key), Some(Out::Any(old)) if old == *value) {
            text.insert_attribute(txn, key.clone(), value.clone());
        }
    }
}

fn block_attributes<T: ReadTxn>(element: &XmlElementRef, txn: &T) -> Result<Attrs, String> {
    element
        .attributes(txn)
        .map(|(key, value)| match value {
            Out::Any(value) => Ok((key.into(), value)),
            _ => Err("Cannot copy shared XML block metadata".into()),
        })
        .collect()
}

fn replace_presentation_attributes(
    element: &XmlElementRef,
    txn: &mut yrs::TransactionMut,
    attrs: &Attrs,
) {
    for key in ["id", "level", "indent", "textAlign"] {
        if !attrs.contains_key(key) {
            element.remove_attribute(txn, &key);
        }
    }
    for (key, value) in attrs {
        if !matches!(element.get_attribute(txn, key), Some(Out::Any(old)) if old == *value) {
            element.insert_attribute(txn, key.clone(), value.clone());
        }
    }
}

fn create_block(
    parent: &Parent,
    txn: &mut yrs::TransactionMut,
    index: u32,
    tag: &str,
    attrs: &Attrs,
) -> XmlElementRef {
    let block = parent.insert(txn, index, XmlElementPrelim::empty(tag));
    for (key, value) in attrs {
        block.insert_attribute(txn, key.clone(), value.clone());
    }
    block.insert_attribute(txn, "id", Uuid::now_v7().to_string());
    block
}

impl DocumentSession {
    pub(crate) fn replace_structure(
        &mut self,
        view: &NativeProjection,
        edit: &NativeReplacement,
        first_index: usize,
        last_index: usize,
    ) -> Result<
        (
            crate::lineage::Layout,
            crate::lineage::Layout,
            Option<crate::relocation_history::HistoryHandle>,
        ),
        String,
    > {
        let blocks = &view.blocks[first_index..=last_index];
        if blocks
            .iter()
            .any(|block| !block.editable || !matches!(block.kind.as_str(), "paragraph" | "heading"))
        {
            return Err("Structural replacement requires supported text blocks".into());
        }
        if edit.text.contains(['\r', '\u{2029}']) {
            return Err("Structural input must use normalized newlines".into());
        }
        let first = &blocks[0];
        let last = blocks.last().unwrap();
        let offset = edit.range.location - first.range.location;
        let mut keep_last =
            blocks.len() > 1 && offset == 0 && (edit.text.is_empty() || edit.text == "\n");
        let txn = self.doc.transact();
        let elements: Vec<_> = blocks
            .iter()
            .map(|block| self.editable_block(&txn, block.id.as_deref().ok_or("Missing block ID")?))
            .collect::<Result<_, String>>()?;
        let mut parent = Parent(
            elements[0]
                .parent()
                .unwrap_or(XmlOut::Fragment(self.root.clone())),
        );
        let cross_container = elements.iter().any(|element| {
            element
                .parent()
                .unwrap_or(XmlOut::Fragment(self.root.clone()))
                .id()
                != parent.0.id()
        });
        let right_survivor =
            containers::RightSurvivor::new(&self.root, &txn, &elements, first, last, edit)?;
        if let Some(plan) = &right_survivor {
            parent = plan.parent();
            // Logical/public survivor is still the first block. Only the
            // physical target differs; no unselected subtree is reconstructed.
            keep_last = false;
        }
        let container_plan = if cross_container && right_survivor.is_none() {
            let plan = containers::Plan::new(&self.root, &txn, &elements, keep_last)?;
            keep_last = plan.keep_last;
            parent = plan.parent();
            Some(plan)
        } else {
            None
        };
        let survivor = if keep_last { last } else { first };
        let element = if keep_last || right_survivor.is_some() {
            elements.last().unwrap()
        } else {
            &elements[0]
        };
        let children: Vec<_> = parent.children(&txn).collect();
        let index = children
            .iter()
            .position(|node| matches!(node, XmlOut::Element(value) if value == element))
            .ok_or("Missing structural parent")?;
        if !cross_container
            && !children[index - if keep_last { elements.len() - 1 } else { 0 }..]
                .iter()
                .zip(&elements)
                .all(|(node, element)| matches!(node, XmlOut::Element(value) if value == element))
        {
            return Err("Structural replacement must cover consecutive sibling text blocks".into());
        }
        // Known presentation attrs follow the surviving block. Unknown
        // attrs are unioned; conflicting values fail atomically, never vanish.
        let raw_attrs = elements
            .iter()
            .map(|element| block_attributes(element, &txn))
            .collect::<Result<Vec<_>, _>>()?;
        let mut merged = raw_attrs[if keep_last { raw_attrs.len() - 1 } else { 0 }].clone();
        if let Some(plan) = &container_plan {
            plan.preserve_metadata(&mut merged)?;
        }
        for attrs in &raw_attrs {
            for (key, value) in attrs {
                if !structural_attribute(key) {
                    continue;
                }
                if merged.get(key).is_some_and(|existing| existing != value) {
                    return Err("Cannot merge conflicting unknown block metadata".into());
                }
                merged.insert(key.clone(), value.clone());
            }
        }
        let merged_attrs = merged.clone();
        let end = edit.range.location + edit.range.length;
        let tail = tail_runs(last, elements.last().unwrap(), &txn, end)?;
        let tail_length = last.range.location + last.range.length - end;
        let inherited = replacement_marks(
            first,
            last,
            edit,
            &elements[0],
            elements.last().unwrap(),
            &txn,
        )?;
        let lines: Vec<_> = edit.text.split('\n').collect();
        let enter = edit.text == "\n";
        let heading_start = enter && survivor.kind == "heading" && offset == 0 && tail_length > 0;
        let mut new_attrs = merged.clone();
        new_attrs.remove("id");
        let next_kind = if enter && survivor.kind == "heading" && tail_length > 0 {
            "heading"
        } else {
            "paragraph"
        };
        if next_kind != survivor.kind || !enter {
            new_attrs.remove("level");
            new_attrs.remove("indent");
            new_attrs.remove("textAlign");
        }
        let mut default_attrs = merged.clone();
        default_attrs.retain(|key, _| structural_attribute(key));
        let first_text = match element.get(&txn, 0) {
            Some(XmlOut::Text(text)) => Some(text),
            _ => None,
        };
        let text_attrs = text_attributes(&elements, &txn)?;
        let prefix = if right_survivor.is_some() {
            Some(range_runs(
                first,
                &elements[0],
                &txn,
                first.range.location,
                edit.range.location,
            )?)
        } else {
            None
        };
        let alias_source = if right_survivor.is_some() {
            match elements[0].get(&txn, 0) {
                Some(XmlOut::Text(text))
                    if crate::relocation_alias::can_capture(&txn, &text, offset) =>
                {
                    Some(text)
                }
                _ => None,
            }
        } else {
            None
        };
        drop(txn);
        let lineage_before = self.capture_lineage(blocks)?;
        let mut relocation = None;
        {
            let mut txn = self.doc.transact_mut_with(LOCAL);
            if right_survivor.is_some() {
                replace_presentation_attributes(element, &mut txn, &merged_attrs);
            } else {
                for (key, value) in merged_attrs {
                    element.insert_attribute(&mut txn, key, value);
                }
            }
            let target =
                first_text.unwrap_or_else(|| element.push_back(&mut txn, XmlTextPrelim::new("")));
            preserve_text_attributes(&target, &mut txn, &text_attrs);
            let preserve_tail = (heading_start && (blocks.len() == 1 || keep_last))
                || (keep_last && edit.text.is_empty());
            if let Some(prefix) = prefix {
                // Retain the right tail's original items. Only the selected
                // right prefix is deleted, before copying the kept left prefix.
                if end > last.range.location {
                    target.remove_range(&mut txn, 0, end - last.range.location);
                }
                insert_runs(&target, &mut txn, 0, prefix);
                if let Some(source) = &alias_source {
                    // Eligibility and UTF-16 boundaries were checked before
                    // mutating the document. The copied prefix is exact here.
                    let namespace = ((Uuid::now_v7().as_u128() as u64) & ((1u64 << 53) - 1)).max(1);
                    let alias = crate::relocation_alias::capture_plan(
                        &mut txn, source, &target, offset, namespace,
                    )
                    .expect("Preflighted plain prefix must have an exact alias");
                    crate::relocation_alias::record(&mut txn, &alias)
                        .expect("Validated alias serialization");
                    relocation = Some(
                        crate::relocation_history::capture(&mut txn, &alias)
                            .expect("New alias history must capture its live baseline"),
                    );
                }
            } else if preserve_tail && end > survivor.range.location {
                target.remove_range(&mut txn, 0, end - survivor.range.location);
            } else if !preserve_tail && survivor.range.length > offset {
                target.remove_range(&mut txn, offset, survivor.range.length - offset);
            }
            let index = if let Some(plan) = &right_survivor {
                plan.apply(&mut txn);
                index
            } else if let Some(plan) = &container_plan {
                plan.apply(&mut txn);
                parent
                    .children(&txn)
                    .position(|node| matches!(node, XmlOut::Element(value) if value == *element))
                    .expect("The survivor stays in its container")
            } else {
                // Sibling edits keep the survivor at the first covered position.
                let index = index - if keep_last { elements.len() - 1 } else { 0 };
                if blocks.len() > 1 {
                    parent.remove_range(
                        &mut txn,
                        index as u32 + u32::from(!keep_last),
                        blocks.len() as u32 - 1,
                    );
                }
                index
            };
            if right_survivor.is_some() {
                // The existing right tail, marks and item identities stay live.
            } else if heading_start {
                // ProseMirror Enter at the start of a heading inserts a fresh
                // paragraph *before* it; the heading keeps its original ID.
                let paragraph =
                    create_block(&parent, &mut txn, index as u32, "paragraph", &default_attrs);
                if !text_attrs.is_empty() {
                    let text = paragraph.push_back(&mut txn, XmlTextPrelim::new(""));
                    preserve_text_attributes(&text, &mut txn, &text_attrs);
                }
                if !preserve_tail {
                    insert_runs(&target, &mut txn, 0, tail);
                }
            } else {
                if !lines[0].is_empty() {
                    target.insert_with_attributes(&mut txn, offset, lines[0], inherited);
                }
                if lines.len() == 1 && !preserve_tail {
                    insert_runs(
                        &target,
                        &mut txn,
                        offset + lines[0].encode_utf16().count() as u32,
                        tail,
                    );
                } else if lines.len() > 1 {
                    let mut last_text = None;
                    for (part, line) in lines.iter().enumerate().skip(1) {
                        let block = create_block(
                            &parent,
                            &mut txn,
                            index as u32 + part as u32,
                            next_kind,
                            &new_attrs,
                        );
                        let text = block.push_back(&mut txn, XmlTextPrelim::new(*line));
                        preserve_text_attributes(&text, &mut txn, &text_attrs);
                        last_text = Some(text);
                    }
                    insert_runs(
                        &last_text.unwrap(),
                        &mut txn,
                        lines.last().unwrap().encode_utf16().count() as u32,
                        tail,
                    );
                }
            }
        }
        self.undo.reset();
        self.revision += 1;
        let after = self.native_projection()?;
        let affected_end = last.range.location + last.range.length - edit.range.length
            + edit.text.encode_utf16().count() as u32;
        let affected: Vec<_> = after
            .blocks
            .into_iter()
            .filter(|block| {
                block.range.location >= first.range.location && block.range.location <= affected_end
            })
            .collect();
        let lineage_after = self.capture_lineage(&affected)?;
        Ok((lineage_before, lineage_after, relocation))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source(kind: &str) -> DocumentSession {
        let mut source = DocumentSession::new();
        {
            let mut txn = source.doc.transact_mut();
            let block = source
                .root
                .push_back(&mut txn, XmlElementPrelim::empty(kind));
            block.insert_attribute(&mut txn, "id", "a");
            block.push_back(&mut txn, XmlTextPrelim::new("甲👩🏽‍🚀乙"));
            let next = source
                .root
                .push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            next.insert_attribute(&mut txn, "id", "b");
            next.push_back(&mut txn, XmlTextPrelim::new("尾段"));
        }
        source.undo.reset();
        source
    }
    fn edit(
        doc: &mut DocumentSession,
        location: u32,
        length: u32,
        text: &str,
    ) -> Result<NativeEditMap, String> {
        doc.replace_native(NativeReplacement {
            revision: doc.revision,
            range: NativeRange { location, length },
            text: text.into(),
        })
    }
    fn raw_marks_at(doc: &DocumentSession, id: &str, at: u32) -> Attrs {
        let txn = doc.doc.transact();
        let block = doc.find_block(&txn, id).unwrap();
        let Some(XmlOut::Text(text)) = block.get(&txn, 0) else {
            unreachable!()
        };
        let mut offset = 0;
        for run in text.diff(&txn, YChange::identity) {
            let Out::Any(Any::String(value)) = run.insert else {
                unreachable!()
            };
            let end = offset + value.encode_utf16().count() as u32;
            if offset <= at && at < end {
                return run.attributes.map(|attrs| *attrs).unwrap_or_default();
            }
            offset = end;
        }
        panic!("No marked character at {id}:{at}");
    }

    #[test]
    fn raw_inline_marks_survive_in_memory_inheritance_entity_affinity_split_join_and_history() {
        let mut doc = source("paragraph");
        let attrs = Attrs::from([
            ("futureBuffer".into(), Any::Buffer(vec![0, 1, 255].into())),
            ("futureUndefined".into(), Any::Undefined),
            (
                "futureNested".into(),
                Any::Map(
                    std::collections::HashMap::from([
                        ("buffer".to_owned(), Any::Buffer(vec![7, 8].into())),
                        ("unset".to_owned(), Any::Undefined),
                    ])
                    .into(),
                ),
            ),
        ]);
        let link =
            Any::from_json(r#"{"targetKind":"element","targetId":"synthetic-link"}"#).unwrap();
        let mut linked = attrs.clone();
        linked.insert("entityLink".into(), link.clone());
        let suffix = Attrs::from([("futureTail".into(), Any::Buffer(vec![9, 10].into()))]);
        {
            let mut txn = doc.doc.transact_mut();
            for (id, length, attrs) in [("a", 9, &attrs), ("b", 2, &suffix)] {
                let node = doc.find_block(&txn, id).unwrap();
                let Some(XmlOut::Text(text)) = node.get(&txn, 0) else {
                    unreachable!()
                };
                text.format(&mut txn, 0, length, attrs.clone());
                if id == "a" {
                    text.format(
                        &mut txn,
                        0,
                        8,
                        Attrs::from([("entityLink".into(), link.clone())]),
                    );
                }
            }
        }
        edit(&mut doc, 8, 0, "新").unwrap();
        assert_eq!(
            raw_marks_at(&doc, "a", 8),
            attrs,
            "entity-link endpoint stays noninclusive; unknown types remain exact"
        );
        assert!(doc.undo());
        edit(&mut doc, 1, 0, "新").unwrap();
        assert_eq!(
            raw_marks_at(&doc, "a", 1),
            linked,
            "interior insertion keeps exact raw link and future attributes"
        );
        assert!(doc.undo());
        edit(&mut doc, 1, 0, "\n").unwrap();
        let split = doc.native_projection().unwrap().blocks[1]
            .id
            .clone()
            .unwrap();
        assert_eq!(raw_marks_at(&doc, &split, 0), linked);
        assert_eq!(
            raw_marks_at(&doc, &split, 7),
            attrs,
            "UTF16 emoji tail keeps its final mark boundary"
        );
        assert!(doc.undo());
        edit(&mut doc, 9, 1, "").unwrap();
        assert_eq!(raw_marks_at(&doc, "a", 9), suffix);
        // Typed format values are preserved in memory. The separate v1 wire
        // guard rejects non-JSON format values rather than serializing them
        // differently from the original Yjs v2 representation.
        assert!(doc.undo());
        assert_eq!(raw_marks_at(&doc, "b", 0), suffix);
        assert!(doc.redo());
        assert_eq!(raw_marks_at(&doc, "a", 9), suffix);
    }

    fn text_metadata(doc: &DocumentSession, id: &str) -> Attrs {
        let txn = doc.doc.transact();
        let element = doc.find_block(&txn, id).unwrap();
        text_attributes(&[element], &txn).unwrap()
    }
    fn set_text_metadata(doc: &DocumentSession, id: &str, key: &str, value: Any) {
        let mut txn = doc.doc.transact_mut();
        let element = doc.find_block(&txn, id).unwrap();
        let Some(XmlOut::Text(text)) = element.get(&txn, 0) else {
            unreachable!()
        };
        text.insert_attribute(&mut txn, key, value);
    }
    #[test]
    fn xml_text_metadata_survives_split_heading_start_join_history_and_checkpoint() {
        let typed =
            Any::from_json(r#"{"array":[1,true,null],"nested":{"future":"keep"}}"#).unwrap();
        for kind in ["paragraph", "heading"] {
            let mut doc = source(kind);
            set_text_metadata(&doc, "a", "future", typed.clone());
            let attrs = text_metadata(&doc, "a");
            edit(&mut doc, if kind == "heading" { 0 } else { 1 }, 0, "\n").unwrap();
            let view = doc.native_projection().unwrap();
            for block in &view.blocks[..2] {
                assert_eq!(text_metadata(&doc, block.id.as_deref().unwrap()), attrs);
            }
            assert!(doc.undo());
            assert_eq!(text_metadata(&doc, "a"), attrs);
            assert!(doc.redo());
            let mut restored = DocumentSession::new();
            restored
                .apply_remote(&doc.update(None, 1).unwrap(), 1)
                .unwrap();
            for block in &restored.native_projection().unwrap().blocks[..2] {
                assert_eq!(
                    text_metadata(&restored, block.id.as_deref().unwrap()),
                    attrs
                );
            }
        }
        let mut doc = source("paragraph");
        set_text_metadata(&doc, "a", "first", typed);
        set_text_metadata(&doc, "b", "last", Any::Buffer(vec![0, 1, 255].into()));
        let first = text_metadata(&doc, "a");
        let last = text_metadata(&doc, "b");
        let mut both = first.clone();
        both.extend(last.clone());
        edit(&mut doc, 9, 1, "").unwrap();
        assert_eq!(text_metadata(&doc, "a"), both);
        assert!(doc.undo());
        assert_eq!(text_metadata(&doc, "a"), first);
        assert_eq!(text_metadata(&doc, "b"), last);
        assert!(doc.redo());
        assert_eq!(text_metadata(&doc, "a"), both);
    }
    #[test]
    fn xml_text_metadata_conflicts_and_shared_values_reject_before_mutation() {
        let mut doc = source("paragraph");
        set_text_metadata(&doc, "a", "future", Any::Bool(true));
        set_text_metadata(&doc, "b", "future", Any::Bool(false));
        let before = doc.update(None, 1).unwrap();
        assert!(edit(&mut doc, 9, 1, "")
            .unwrap_err()
            .contains("conflicting XML text metadata"));
        assert_eq!(doc.update(None, 1).unwrap(), before);
        assert!(!doc.undo());
        let mut doc = source("paragraph");
        {
            let mut txn = doc.doc.transact_mut();
            let block = doc.find_block(&txn, "a").unwrap();
            let Some(XmlOut::Text(text)) = block.get(&txn, 0) else {
                unreachable!()
            };
            text.insert_attribute(&mut txn, "future", yrs::MapPrelim::default());
        }
        let before = doc.update(None, 1).unwrap();
        assert!(edit(&mut doc, 1, 0, "\n")
            .unwrap_err()
            .contains("shared XML text metadata"));
        assert_eq!(doc.update(None, 1).unwrap(), before);
        assert!(!doc.undo());
    }
    #[test]
    fn structural_block_metadata_keeps_binary_types_and_rejects_shared_values() {
        let mut doc = source("paragraph");
        let bytes = Any::Buffer(vec![0, 1, 255].into());
        {
            let mut txn = doc.doc.transact_mut();
            doc.find_block(&txn, "a").unwrap().insert_attribute(
                &mut txn,
                "futureBytes",
                bytes.clone(),
            );
        }
        edit(&mut doc, 1, 0, "\n").unwrap();
        {
            let txn = doc.doc.transact();
            for block in &doc.native_projection().unwrap().blocks[..2] {
                let node = doc.find_block(&txn, block.id.as_deref().unwrap()).unwrap();
                assert!(
                    matches!(node.get_attribute(&txn, "futureBytes"), Some(Out::Any(ref value)) if value == &bytes)
                );
            }
        }
        assert!(doc.undo());
        edit(&mut doc, 9, 1, "").unwrap();
        {
            let txn = doc.doc.transact();
            assert!(
                matches!(doc.find_block(&txn, "a").unwrap().get_attribute(&txn, "futureBytes"), Some(Out::Any(ref value)) if value == &bytes)
            );
        }
        let mut doc = source("paragraph");
        {
            let mut txn = doc.doc.transact_mut();
            doc.find_block(&txn, "a").unwrap().insert_attribute(
                &mut txn,
                "future",
                yrs::MapPrelim::default(),
            );
        }
        let before = doc.update(None, 1).unwrap();
        assert!(edit(&mut doc, 1, 0, "\n")
            .unwrap_err()
            .contains("shared XML block metadata"));
        assert_eq!(doc.update(None, 1).unwrap(), before);
        assert!(!doc.undo());
    }
    #[test]
    fn split_keeps_prefix_items_and_maps_tail_then_undo_restores_original_anchors() {
        let mut doc = source("paragraph");
        let prefix = doc.anchor("a", 0, true).unwrap();
        let tail = doc.anchor("a", 8, false).unwrap();
        let map = edit(&mut doc, 1, 0, "\n").unwrap();
        assert_eq!(
            doc.resolve_anchor(&prefix).unwrap().unwrap(),
            json!({"block": "a", "offset": 0})
        );
        let mapped = map.map_point("a", 8, false).unwrap();
        assert_ne!(mapped.block, "a");
        assert_eq!(mapped.offset, 7);
        let fresh = doc.anchor(&mapped.block, mapped.offset, false).unwrap();
        assert_eq!(
            doc.resolve_anchor(&fresh).unwrap().unwrap(),
            json!({"block": mapped.block, "offset": 7})
        );
        assert!(doc.undo());
        assert_eq!(
            doc.resolve_anchor(&tail).unwrap().unwrap(),
            json!({"block": "a", "offset": 8})
        );
        assert!(!doc.undo());
    }
    #[test]
    fn enter_before_heading_keeps_the_live_heading_and_its_relative_positions() {
        let mut doc = source("heading");
        let old = doc.anchor("a", 8, false).unwrap();
        let map = edit(&mut doc, 0, 0, "\n").unwrap();
        let view = doc.native_projection().unwrap();
        assert_eq!(view.blocks[0].kind, "paragraph");
        assert_eq!(view.blocks[1].id.as_deref(), Some("a"));
        assert_eq!(
            doc.resolve_anchor(&old).unwrap().unwrap(),
            json!({"block": "a", "offset": 8})
        );
        assert_eq!(map.map_point("a", 8, false).unwrap().offset, 8);
    }
    #[test]
    fn conflicting_unknown_metadata_rejects_merge_without_mutation_or_history() {
        let mut doc = source("paragraph");
        {
            let mut txn = doc.doc.transact_mut();
            for (id, value) in [("a", "first"), ("b", "second")] {
                doc.find_block(&txn, id)
                    .unwrap()
                    .insert_attribute(&mut txn, "future", value);
            }
        }
        let original = doc.update(None, 1).unwrap();
        assert!(edit(&mut doc, 9, 1, "")
            .unwrap_err()
            .contains("conflicting"));
        assert_eq!(doc.update(None, 1).unwrap(), original);
        assert!(!doc.undo());
        let mapping = edit(&mut doc, 0, 9, "").unwrap();
        let comment = json!({"startBlockId":"a", "startOffset": 0, "endBlockId":"a", "endOffset":9, "text":"甲👩🏽‍🚀乙", "unknown": [1,2]});
        let remapped = mapping.map_comment_anchor(&comment).unwrap();
        assert_eq!(remapped["collapsed"], true);
        assert_eq!(remapped["textAnchor"]["unknown"], json!([1, 2]));
        assert_eq!(remapped["textAnchor"]["text"], comment["text"]);
    }
}
