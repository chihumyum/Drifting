//! Fit the live chapter schema's blockquote boundaries without rebuilding the
//! document. Unaffected prefixes and suffixes retain their CRDT items. A join
//! that needs to relocate an unselected suffix awaits identity-safe history.
use super::*;

/// The production binding can keep the right quote when the left quote holds
/// only the affected paragraph. Only that paragraph's prefix is reconstructed;
/// right-hand siblings keep their original parent and item identities.
pub(super) struct RightSurvivor {
    left: XmlElementRef,
    right: XmlElementRef,
    attrs: Attrs,
}

impl RightSurvivor {
    pub fn new<T: ReadTxn>(
        root: &XmlFragmentRef,
        txn: &T,
        elements: &[XmlElementRef],
        first: &NativeBlock,
        last: &NativeBlock,
        edit: &NativeReplacement,
    ) -> Result<Option<Self>, String> {
        let end = edit.range.location + edit.range.length;
        let separator_only = edit.range.length == 1
            && edit.range.location == first.range.location + first.range.length
            && end == last.range.location;
        let partial_delete = edit.range.location > first.range.location
            && edit.range.location <= first.range.location + first.range.length
            && end >= last.range.location
            && end < last.range.location + last.range.length;
        if elements.len() != 2
            || first.range.length == 0
            || first.kind != "paragraph"
            || last.kind != "paragraph"
            || !edit.text.is_empty()
            || !(separator_only || partial_delete)
        {
            return Ok(None);
        }
        let (Some(XmlOut::Element(left)), Some(XmlOut::Element(right))) =
            (elements[0].parent(), elements[1].parent())
        else {
            return Ok(None);
        };
        if left == right
            || left.tag().as_ref() != "blockquote"
            || right.tag().as_ref() != "blockquote"
            || left.len(txn) != 1
            || right.len(txn) < 2
            || !matches!(right.get(txn, 0), Some(XmlOut::Element(node)) if node == elements[1])
            || !matches!(left.parent(), Some(XmlOut::Fragment(parent)) if parent == *root)
            || !matches!(right.parent(), Some(XmlOut::Fragment(parent)) if parent == *root)
        {
            return Ok(None);
        }
        let siblings: Vec<_> = root.children(txn).collect();
        if !siblings.windows(2).any(|pair| {
            matches!((&pair[0], &pair[1]),
            (XmlOut::Element(a), XmlOut::Element(b)) if *a == left && *b == right)
        }) {
            return Ok(None);
        }
        let mut attrs = attributes(&left, txn)?;
        merge(&mut attrs, &attributes(&right, txn)?)?;
        Ok(Some(Self { left, right, attrs }))
    }

    pub fn parent(&self) -> Parent {
        Parent(XmlOut::Element(self.right.clone()))
    }

    pub fn apply(&self, txn: &mut yrs::TransactionMut) {
        // Public ID/presentation follow the left quote, while the right quote's
        // CRDT identity survives. Undo restores these attributes in place.
        replace_presentation_attributes(&self.right, txn, &self.attrs);
        remove(txn, &self.left);
    }
}

pub(super) struct Plan {
    pub keep_last: bool,
    parent: XmlOut,
    removed: Vec<XmlElementRef>,
    ancestors: Vec<XmlElementRef>,
    joins: Vec<(XmlElementRef, XmlElementRef, Attrs)>,
    metadata: Attrs,
}

fn path(element: &XmlElementRef) -> Vec<XmlElementRef> {
    let mut result = vec![element.clone()];
    while let Some(XmlOut::Element(parent)) = result.last().unwrap().parent() {
        result.push(parent);
    }
    result.reverse();
    result
}

fn attributes<T: ReadTxn>(element: &impl Xml, txn: &T) -> Result<Attrs, String> {
    element
        .attributes(txn)
        .map(|(key, value)| match value {
            Out::Any(value) => Ok((key.into(), value)),
            _ => Err("Cannot relocate shared container attributes".into()),
        })
        .collect()
}

fn merge(target: &mut Attrs, attrs: &Attrs) -> Result<(), String> {
    for (key, value) in attrs {
        if !structural_attribute(key) {
            continue;
        }
        if target.get(key.as_ref()).is_some_and(|old| old != value) {
            return Err("Cannot merge conflicting unknown container metadata".into());
        }
        target.insert(key.clone(), value.clone());
    }
    Ok(())
}

fn remove(txn: &mut yrs::TransactionMut, element: &XmlElementRef) {
    let Some(parent) = element.parent() else {
        return;
    };
    let parent = Parent(parent);
    let index = parent
        .children(txn)
        .position(|node| matches!(node, XmlOut::Element(value) if value == *element));
    if let Some(index) = index {
        parent.remove_range(txn, index as u32, 1);
    }
}

// A source quote can be joined without moving identities only when every
// child it contains is covered by this replacement. Moving a surviving suffix
// needs a future history policy: undo may retain a remotely edited copy and
// also restore its original, creating duplicate public block IDs.
fn covered<T: ReadTxn>(node: XmlOut, txn: &T, selected: &[XmlElementRef]) -> bool {
    match node {
        XmlOut::Element(element) if selected.contains(&element) => true,
        XmlOut::Element(element)
            if element.tag().as_ref() == "blockquote" && element.len(txn) > 0 =>
        {
            element
                .children(txn)
                .all(|child| covered(child, txn, selected))
        }
        _ => false,
    }
}

impl Plan {
    pub fn new<T: ReadTxn>(
        root: &XmlFragmentRef,
        txn: &T,
        elements: &[XmlElementRef],
        prefer_last: bool,
    ) -> Result<Self, String> {
        let first = path(&elements[0]);
        let last = path(elements.last().unwrap());
        let common = first.iter().zip(&last).take_while(|(a, b)| a == b).count();
        // Deleting an entire leading branch keeps the ending block identity.
        // A retained earlier child prevents lifting through that ancestor.
        let keep_last = prefer_last
            && first[common..].windows(2).all(|pair| {
                pair[0]
                    .get(txn, 0)
                    .is_some_and(|node| matches!(node, XmlOut::Element(value) if value == pair[1]))
            });
        let survivor = if keep_last {
            elements.last().unwrap()
        } else {
            &elements[0]
        };
        let mut ancestors = Vec::new();
        for element in elements {
            let chain = path(element);
            for ancestor in &chain[..chain.len() - 1] {
                if ancestor.tag().as_ref() != "blockquote" {
                    return Err(
                        "Cross-container editing requires the chapter blockquote schema".into(),
                    );
                }
                if !ancestors.contains(ancestor) {
                    ancestors.push(ancestor.clone());
                }
            }
        }
        ancestors.sort_by_key(|ancestor| std::cmp::Reverse(path(ancestor).len()));
        let mut joins = Vec::new();
        let mut metadata = Attrs::new();
        if !keep_last {
            for (left, right) in first[common..first.len() - 1]
                .iter()
                .zip(&last[common..last.len() - 1])
            {
                let mut merged = Attrs::new();
                merge(&mut merged, &attributes(left, txn)?)?;
                merge(&mut merged, &attributes(right, txn)?)?;
                let mut attrs = attributes(left, txn)?;
                attrs.extend(merged);
                if !right.children(txn).all(|node| covered(node, txn, elements)) {
                    return Err("Container suffix relocation requires identity-safe history".into());
                }
                joins.push((left.clone(), right.clone(), attrs));
            }
        }
        // A removed wrapper's future attributes must not disappear. Keep them
        // on the surviving text block unless a conflicting value forbids it.
        for ancestor in &ancestors {
            let leaves: Vec<_> = ancestor
                .successors(txn)
                .filter_map(|node| {
                    if let XmlOut::Element(element) = node {
                        matches!(element.tag().as_ref(), "paragraph" | "heading").then_some(element)
                    } else {
                        None
                    }
                })
                .collect();
            if !leaves.is_empty()
                && leaves
                    .iter()
                    .all(|leaf| elements.contains(leaf) && leaf != survivor)
            {
                merge(&mut metadata, &attributes(ancestor, txn)?)?;
            }
        }
        Ok(Self {
            keep_last,
            parent: survivor.parent().unwrap_or(XmlOut::Fragment(root.clone())),
            removed: elements
                .iter()
                .filter(|element| *element != survivor)
                .cloned()
                .collect(),
            ancestors,
            joins,
            metadata,
        })
    }
    pub fn parent(&self) -> Parent {
        Parent(self.parent.clone())
    }
    pub fn preserve_metadata(&self, target: &mut Attrs) -> Result<(), String> {
        merge(target, &self.metadata)
    }
    pub fn apply(&self, txn: &mut yrs::TransactionMut) {
        for element in &self.removed {
            remove(txn, element);
        }
        for (left, right, attrs) in self.joins.iter().rev() {
            for (key, value) in attrs {
                left.insert_attribute(txn, key.clone(), value.clone());
            }
            remove(txn, right);
        }
        for ancestor in &self.ancestors {
            if ancestor.len(txn) == 0 {
                remove(txn, ancestor);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(suffix: bool) -> DocumentSession {
        let seed = DocumentSession::with_test_client_id(29101).unwrap();
        {
            let mut txn = seed.doc.transact_mut();
            for (id, entries) in [
                ("left", vec![("a", "开篇"), ("b", "潮汐")]),
                (
                    "right",
                    if suffix {
                        vec![("c", "夜航"), ("d", "尾声")]
                    } else {
                        vec![("c", "夜航")]
                    },
                ),
            ] {
                let quote = seed
                    .root
                    .push_back(&mut txn, XmlElementPrelim::empty("blockquote"));
                quote.insert_attribute(&mut txn, "id", id);
                if id == "right" {
                    quote.insert_attribute(
                        &mut txn,
                        "futureQuote",
                        Any::from_json(r#"{"preserve":[1,true]}"#).unwrap(),
                    );
                }
                for (id, value) in entries {
                    let block = quote.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
                    block.insert_attribute(&mut txn, "id", id);
                    let text = block.push_back(&mut txn, XmlTextPrelim::new(value));
                    if id == "c" {
                        block.insert_attribute(
                            &mut txn,
                            "future",
                            Any::from_json(r#"{"preserve":[1,true]}"#).unwrap(),
                        );
                        text.format(
                            &mut txn,
                            1,
                            1,
                            Attrs::from([("bold".into(), Any::Bool(true))]),
                        );
                    }
                }
            }
        }
        let mut doc = DocumentSession::with_test_client_id(29102).unwrap();
        doc.apply_remote(&seed.update(None, 1).unwrap(), 1).unwrap();
        doc
    }
    fn join(doc: &mut DocumentSession) -> Result<NativeEditMap, String> {
        doc.replace_native(NativeReplacement {
            revision: doc.revision,
            range: NativeRange {
                location: 5,
                length: 1,
            },
            text: String::new(),
        })
    }
    fn select(doc: &mut DocumentSession, epoch: u64, at: u32) {
        doc.set_selection(NativeSelectionRequest {
            view_id: "tail".into(),
            epoch,
            revision: doc.revision,
            range: NativeRange {
                location: at,
                length: 0,
            },
        })
        .unwrap();
    }
    fn caret(doc: &DocumentSession) -> u32 {
        doc.native_projection().unwrap().selections[0]
            .range
            .as_ref()
            .unwrap()
            .location
    }
    fn right_source() -> DocumentSession {
        let doc = source(true);
        {
            let mut txn = doc.doc.transact_mut();
            let left = doc.find_block(&txn, "left").unwrap();
            left.remove_range(&mut txn, 0, 1);
            left.insert_attribute(&mut txn, "indent", 1);
            left.insert_attribute(&mut txn, "futureLeft", Any::Buffer(vec![7, 8].into()));
            let right = doc.find_block(&txn, "right").unwrap();
            right.insert_attribute(&mut txn, "indent", 2);
            for (id, align, key) in [("b", "right", "prefixBlock"), ("c", "left", "tailBlock")] {
                let block = doc.find_block(&txn, id).unwrap();
                block.insert_attribute(&mut txn, "textAlign", align);
                block.insert_attribute(&mut txn, key, Any::Buffer(vec![2, 4].into()));
                let Some(XmlOut::Text(text)) = block.get(&txn, 0) else {
                    unreachable!()
                };
                text.insert_attribute(&mut txn, key, Any::Buffer(vec![3, 5].into()));
                if id == "b" {
                    text.format(
                        &mut txn,
                        0,
                        1,
                        Attrs::from([("italic".into(), Any::Bool(true))]),
                    );
                }
            }
        }
        doc
    }
    fn right_join(doc: &mut DocumentSession) -> Result<NativeEditMap, String> {
        doc.replace_native(NativeReplacement {
            revision: doc.revision,
            range: NativeRange {
                location: 2,
                length: 1,
            },
            text: String::new(),
        })
    }
    fn partial_delete(
        doc: &mut DocumentSession,
        location: u32,
        length: u32,
    ) -> Result<NativeEditMap, String> {
        doc.replace_native(NativeReplacement {
            revision: doc.revision,
            range: NativeRange { location, length },
            text: String::new(),
        })
    }
    fn replace_fixture_text(doc: &DocumentSession, id: &str, value: &str) {
        let mut txn = doc.doc.transact_mut();
        let block = doc.find_block(&txn, id).unwrap();
        let Some(XmlOut::Text(text)) = block.get(&txn, 0) else {
            unreachable!()
        };
        let length = text.len(&txn);
        text.remove_range(&mut txn, 0, length);
        text.insert(&mut txn, 0, value);
    }
    fn node(doc: &DocumentSession, id: &str) -> XmlElementRef {
        doc.find_block(&doc.doc.transact(), id).unwrap()
    }
    fn comment(id: &str, block: &str, start: u32, end: u32, quote: &str) -> CommentAnchorRecord {
        CommentAnchorRecord {
            id: id.into(), target_block_id: Some(block.into()), target_block_ids_json: json!([block]).to_string(),
            anchor_json: json!({"futureComment":true,"selectedText":quote,"textAnchor":{
                "startBlockId":block,"startOffset":start,"endBlockId":block,"endOffset":end,"text":quote}}).to_string(),
        }
    }
    fn assert_unique_ids(doc: &DocumentSession) {
        let txn = doc.doc.transact();
        let mut ids = std::collections::HashSet::new();
        for child in doc.root.successors(&txn) {
            if let XmlOut::Element(element) = child {
                let Some(Out::Any(Any::String(id))) = element.get_attribute(&txn, "id") else {
                    panic!("Missing public ID")
                };
                assert!(ids.insert(id), "Duplicate public ID");
            }
        }
    }
    fn assert_comment_quotes(doc: &DocumentSession, expected: &[(&str, &str)]) {
        let projection = doc.native_projection().unwrap();
        assert_eq!(projection.comments.len(), expected.len());
        for (id, quote) in expected {
            let comment = projection
                .comments
                .iter()
                .find(|comment| comment.id == *id)
                .unwrap();
            assert_eq!(comment.quote, *quote);
            assert_eq!(comment.status, "anchored");
            assert!(!comment.ranges.is_empty());
            let selected = comment
                .ranges
                .iter()
                .map(|range| {
                    text_slice(
                        &projection.text,
                        range.location,
                        range.location + range.length,
                    )
                    .unwrap()
                })
                .collect::<String>();
            assert_eq!(selected, *quote, "Exact UTF-16 comment range for {id}");
        }
        for record in doc.comment_anchor_records() {
            let anchor: Value = serde_json::from_str(&record.anchor_json).unwrap();
            assert_eq!(anchor["futureComment"], true);
        }
    }
    #[test]
    fn right_survivor_keeps_physical_tail_and_typed_metadata_through_history_and_reopen() {
        let mut doc = right_source();
        let original = doc.semantic().unwrap();
        let right = node(&doc, "right");
        let c = node(&doc, "c");
        let d = node(&doc, "d");
        let text = c.get(&doc.doc.transact(), 0).unwrap();
        doc.set_comment_anchors(vec![
            comment("prefix", "b", 0, 1, "潮"),
            comment("joined-tail", "c", 1, 2, "航"),
            comment("suffix", "d", 0, 2, "尾声"),
        ])
        .unwrap();
        select(&mut doc, 1, 4);
        right_join(&mut doc).unwrap();
        assert_eq!(node(&doc, "left"), right);
        assert_eq!(node(&doc, "b"), c);
        assert_eq!(node(&doc, "d"), d);
        assert_eq!(c.get(&doc.doc.transact(), 0).unwrap().id(), text.id());
        assert_eq!(caret(&doc), 3);
        assert_eq!(doc.native_projection().unwrap().text, "潮汐夜航\n尾声");
        let merged = doc.semantic().unwrap();
        assert_eq!(merged["content"][0]["attrs"]["indent"], 1);
        assert_eq!(
            merged["content"][0]["content"][0]["attrs"]["textAlign"],
            "right"
        );
        {
            let txn = doc.doc.transact();
            assert_eq!(
                right.get_attribute(&txn, "futureLeft"),
                Some(Out::Any(Any::Buffer(vec![7, 8].into())))
            );
            assert!(right.get_attribute(&txn, "futureQuote").is_some());
            let attrs = text_attributes(&[c.clone()], &txn).unwrap();
            assert_eq!(attrs["prefixBlock"], Any::Buffer(vec![3, 5].into()));
            assert_eq!(attrs["tailBlock"], Any::Buffer(vec![3, 5].into()));
        }
        assert_unique_ids(&doc);
        assert!(doc.undo());
        assert_eq!(doc.semantic().unwrap(), original);
        assert_eq!(node(&doc, "right"), right);
        assert_eq!(node(&doc, "c"), c);
        assert_eq!(node(&doc, "d"), d);
        assert_eq!(caret(&doc), 4);
        assert!(doc.redo());
        assert_eq!(doc.semantic().unwrap(), merged);
        assert_eq!(caret(&doc), 3);
        // A newer manual caret in the copied prefix maps back to its original
        // block; the retained c tail uses its same item identities throughout.
        select(&mut doc, 2, 1);
        assert!(doc.undo());
        assert_eq!(caret(&doc), 1);
        assert!(doc.redo());
        assert_eq!(caret(&doc), 1);
        assert_unique_ids(&doc);
        let mut reopened = DocumentSession::new();
        reopened
            .apply_remote(&doc.update(None, 1).unwrap(), 1)
            .unwrap();
        reopened
            .set_comment_anchors(doc.comment_anchor_records())
            .unwrap();
        assert_eq!(reopened.semantic().unwrap(), merged);
        for anchor in reopened.native_projection().unwrap().comments {
            assert_eq!(anchor.status, "anchored");
            assert!(!anchor.ranges.is_empty());
        }
        assert_unique_ids(&reopened);
    }
    #[test]
    fn right_survivor_partial_delete_preserves_ranges_unicode_comments_and_history() {
        for (left, right, location, length, expected) in [
            ("潮汐", "夜航", 1, 3, "潮航"),
            ("潮汐", "夜航", 1, 2, "潮夜航"),
            ("潮汐", "夜航", 2, 2, "潮汐航"),
            ("甲👩🏽‍🚀e\u{301}", "夜𠮷航", 8, 4, "甲👩🏽‍🚀𠮷航"),
        ] {
            let mut doc = right_source();
            if left != "潮汐" {
                replace_fixture_text(&doc, "b", left);
            }
            if right != "夜航" {
                replace_fixture_text(&doc, "c", right);
            }
            let original = doc.semantic().unwrap();
            let wrapper = node(&doc, "right");
            let c = node(&doc, "c");
            let d = node(&doc, "d");
            let text = c.get(&doc.doc.transact(), 0).unwrap();
            let left_length = left.encode_utf16().count() as u32;
            let right_length = right.encode_utf16().count() as u32;
            let tail_start = location + length - left_length - 1;
            let prefix_quote = text_slice(left, 0, location).unwrap();
            let tail_quote = text_slice(right, tail_start, right_length).unwrap();
            let expected_comments = [
                ("prefix", prefix_quote.as_str()),
                ("tail", tail_quote.as_str()),
                ("suffix", "尾声"),
            ];
            doc.set_comment_anchors(vec![
                comment("prefix", "b", 0, location, &prefix_quote),
                comment("tail", "c", tail_start, right_length, &tail_quote),
                comment("suffix", "d", 0, 2, "尾声"),
            ])
            .unwrap();
            select(&mut doc, 1, location + length);
            partial_delete(&mut doc, location, length).unwrap();
            assert_comment_quotes(&doc, &expected_comments);
            assert_eq!(
                doc.native_projection().unwrap().text,
                format!("{expected}\n尾声")
            );
            assert_eq!(node(&doc, "left"), wrapper);
            assert_eq!(node(&doc, "b"), c);
            assert_eq!(node(&doc, "d"), d);
            assert_eq!(c.get(&doc.doc.transact(), 0).unwrap().id(), text.id());
            assert_eq!(caret(&doc), location);
            let merged = doc.semantic().unwrap();
            for cycle in 0..2 {
                assert!(doc.undo(), "{left}/{right} cycle {cycle}");
                assert_eq!(doc.semantic().unwrap(), original);
                assert_eq!(node(&doc, "right"), wrapper);
                assert_eq!(node(&doc, "c"), c);
                assert_eq!(node(&doc, "d"), d);
                assert_eq!(caret(&doc), location + length);
                assert_comment_quotes(&doc, &expected_comments);
                assert!(!doc.undo());
                assert!(doc.redo());
                assert_eq!(doc.semantic().unwrap(), merged);
                assert_eq!(caret(&doc), location);
                assert_comment_quotes(&doc, &expected_comments);
                assert_unique_ids(&doc);
            }
            let txn = doc.doc.transact();
            assert_eq!(
                wrapper.get_attribute(&txn, "futureLeft"),
                Some(Out::Any(Any::Buffer(vec![7, 8].into())))
            );
            let attrs = text_attributes(&[c.clone()], &txn).unwrap();
            assert_eq!(attrs["prefixBlock"], Any::Buffer(vec![3, 5].into()));
            assert_eq!(attrs["tailBlock"], Any::Buffer(vec![3, 5].into()));
            drop(txn);
            let mut reopened = DocumentSession::new();
            reopened
                .apply_remote(&doc.update(None, 1).unwrap(), 1)
                .unwrap();
            reopened
                .set_comment_anchors(doc.comment_anchor_records())
                .unwrap();
            assert_eq!(reopened.semantic().unwrap(), merged);
            assert_comment_quotes(&reopened, &expected_comments);
            assert_unique_ids(&reopened);
        }
    }
    #[test]
    fn right_survivor_partial_delete_retains_raw_clipped_marks() {
        let mut doc = right_source();
        let prefix = Attrs::from([("futureMark".into(), Any::Buffer(vec![1, 2].into()))]);
        let tail = Attrs::from([("futureMark".into(), Any::Buffer(vec![3, 4].into()))]);
        {
            let mut txn = doc.doc.transact_mut();
            for (id, attrs) in [("b", prefix.clone()), ("c", tail.clone())] {
                let block = doc.find_block(&txn, id).unwrap();
                let Some(XmlOut::Text(text)) = block.get(&txn, 0) else {
                    unreachable!()
                };
                text.format(&mut txn, 0, 2, attrs);
            }
        }
        partial_delete(&mut doc, 1, 3).unwrap();
        let check = |doc: &DocumentSession| {
            let view = doc.native_projection().unwrap();
            let txn = doc.doc.transact();
            let block = doc.find_block(&txn, "b").unwrap();
            let runs = source_runs(&view.blocks[0], &block, &txn).unwrap();
            assert_eq!(
                runs.iter().map(|run| run.text.as_ref()).collect::<String>(),
                "潮航"
            );
            assert_eq!(runs[0].range.length, 1);
            assert_eq!(runs[0].attributes["futureMark"], prefix["futureMark"]);
            assert_eq!(runs[1].range.length, 1);
            assert_eq!(runs[1].attributes["futureMark"], tail["futureMark"]);
        };
        check(&doc);
        assert!(doc.undo());
        assert!(doc.redo());
        check(&doc);
        // These raw binary marks are intentionally in-memory only: v1 cannot
        // encode their format values losslessly, and the existing wire gate rejects them.
        assert!(doc.update(None, 1).is_err());
    }
    #[test]
    fn right_survivor_partial_delete_remote_prefix_matches_production_history() {
        let mut doc = right_source();
        let suffix = node(&doc, "d");
        partial_delete(&mut doc, 1, 3).unwrap();
        let mut peer = DocumentSession::with_test_client_id(29105).unwrap();
        peer.apply_remote(&doc.update(None, 1).unwrap(), 1).unwrap();
        let vector = doc.state_vector();
        peer.edit(Edit::Insert {
            block: "b".into(),
            offset: 0,
            text: "远".into(),
        })
        .unwrap();
        peer.edit(Edit::Insert {
            block: "d".into(),
            offset: 0,
            text: "外".into(),
        })
        .unwrap();
        {
            let mut txn = peer.doc.transact_mut();
            peer.find_block(&txn, "d").unwrap().insert_attribute(
                &mut txn,
                "futureSuffix",
                "retained",
            );
        }
        doc.apply_remote(&peer.update(Some(&vector), 1).unwrap(), 1)
            .unwrap();
        assert_eq!(doc.native_projection().unwrap().text, "远潮航\n外尾声");
        for _ in 0..2 {
            assert!(doc.undo());
            // Actual old y-tiptap restores the deleted c prefix before remote
            // input attached at that deletion boundary; it does not move it to b.
            assert_eq!(
                doc.native_projection().unwrap().text,
                "潮汐\n夜远航\n外尾声"
            );
            assert_eq!(node(&doc, "d"), suffix);
            assert!(doc.redo());
            assert_eq!(doc.native_projection().unwrap().text, "远潮航\n外尾声");
            assert_eq!(
                suffix.get_attribute(&doc.doc.transact(), "futureSuffix"),
                Some(Out::Any(Any::String("retained".into())))
            );
            assert_unique_ids(&doc);
        }
    }
    #[test]
    fn right_survivor_partial_delete_queued_typing_has_two_undo_units() {
        let mut doc = right_source();
        let original = doc.semantic().unwrap();
        doc.fork_input("typing".into(), None).unwrap();
        for (sequence, location, length, text) in [(0, 1, 3, ""), (1, 1, 0, "续")] {
            doc.replace_input(NativeInputEdit {
                key: "typing".into(),
                sequence,
                range: NativeRange { location, length },
                text: text.into(),
                selection: None,
            })
            .unwrap();
        }
        assert_eq!(doc.native_projection().unwrap().text, "潮续航\n尾声");
        assert!(doc.undo());
        assert_eq!(doc.native_projection().unwrap().text, "潮航\n尾声");
        assert!(doc.undo());
        assert_eq!(doc.semantic().unwrap(), original);
        assert!(!doc.undo());
        assert!(doc.redo());
        assert!(doc.redo());
        assert_eq!(doc.native_projection().unwrap().text, "潮续航\n尾声");
    }
    #[test]
    fn right_survivor_separator_join_still_accepts_empty_right_paragraph() {
        let mut doc = right_source();
        replace_fixture_text(&doc, "c", "");
        let original = doc.semantic().unwrap();
        let right = node(&doc, "right");
        let c = node(&doc, "c");
        let suffix = node(&doc, "d");
        right_join(&mut doc).unwrap();
        assert_eq!(doc.native_projection().unwrap().text, "潮汐\n尾声");
        assert_eq!(node(&doc, "left"), right);
        assert_eq!(node(&doc, "b"), c);
        assert_eq!(node(&doc, "d"), suffix);
        assert!(doc.undo());
        assert_eq!(doc.semantic().unwrap(), original);
        assert!(doc.redo());
        assert_eq!(node(&doc, "d"), suffix);
    }
    #[test]
    fn right_survivor_partial_delete_keeps_unsupported_boundaries_atomic() {
        for (complex, location, length, text) in [
            (true, 5, 1, ""),
            (true, 4, 3, "新"),
            (true, 3, 4, ""),
            (false, 1, 3, "新"),
            (false, 1, 3, "\n"),
            (false, 1, 4, ""),
        ] {
            let mut doc = if complex {
                source(true)
            } else {
                right_source()
            };
            let before = doc.update(None, 1).unwrap();
            let revision = doc.revision;
            let error = doc
                .replace_native(NativeReplacement {
                    revision,
                    range: NativeRange { location, length },
                    text: text.into(),
                })
                .unwrap_err();
            assert!(
                error.contains("suffix relocation"),
                "{complex}/{location}/{length}/{text}: {error}"
            );
            assert_eq!(doc.update(None, 1).unwrap(), before);
            assert_eq!(doc.revision, revision);
            assert!(!doc.undo());
        }
    }
    #[test]
    fn right_survivor_retains_remote_suffix_text_and_metadata_on_undo_redo() {
        let mut doc = right_source();
        let right = node(&doc, "right");
        let c = node(&doc, "c");
        let d = node(&doc, "d");
        doc.set_comment_anchors(vec![comment("suffix", "d", 0, 2, "尾声")])
            .unwrap();
        right_join(&mut doc).unwrap();
        let mut peer = DocumentSession::with_test_client_id(29103).unwrap();
        peer.apply_remote(&doc.update(None, 1).unwrap(), 1).unwrap();
        let vector = doc.state_vector();
        peer.edit(Edit::Insert {
            block: "d".into(),
            offset: 1,
            text: "远".into(),
        })
        .unwrap();
        {
            let mut txn = peer.doc.transact_mut();
            let suffix = peer.find_block(&txn, "d").unwrap();
            suffix.insert_attribute(&mut txn, "remoteMeta", Any::Buffer(vec![9, 8, 7].into()));
            let Some(XmlOut::Text(text)) = suffix.get(&txn, 0) else {
                unreachable!()
            };
            text.insert_attribute(
                &mut txn,
                "remoteTextMeta",
                Any::from_json(r#"{"future":[true,3]}"#).unwrap(),
            );
        }
        doc.apply_remote(&peer.update(Some(&vector), 1).unwrap(), 1)
            .unwrap();
        select(&mut doc, 3, 8);
        for undo in [true, false, true, false] {
            assert!(if undo { doc.undo() } else { doc.redo() });
            assert_eq!(node(&doc, "d"), d);
            assert_eq!(node(&doc, if undo { "right" } else { "left" }), right);
            assert_eq!(node(&doc, if undo { "c" } else { "b" }), c);
            assert!(doc.native_projection().unwrap().text.ends_with("尾远声"));
            assert_eq!(caret(&doc), if undo { 9 } else { 8 });
            let anchor = &doc.native_projection().unwrap().comments[0];
            assert_eq!(anchor.quote, "尾声");
            assert_eq!(
                anchor.status, "changed",
                "The original quote is retained while remote text changes its live range"
            );
            assert_eq!(anchor.ranges[0].length, 3);
            let txn = doc.doc.transact();
            assert_eq!(
                d.get_attribute(&txn, "remoteMeta"),
                Some(Out::Any(Any::Buffer(vec![9, 8, 7].into())))
            );
            let Some(XmlOut::Text(text)) = d.get(&txn, 0) else {
                unreachable!()
            };
            assert!(text.get_attribute(&txn, "remoteTextMeta").is_some());
            drop(txn);
            assert_unique_ids(&doc);
        }
        let mut reopened = DocumentSession::new();
        reopened
            .apply_remote(&doc.update(None, 1).unwrap(), 1)
            .unwrap();
        reopened
            .set_comment_anchors(doc.comment_anchor_records())
            .unwrap();
        assert_eq!(reopened.semantic().unwrap(), doc.semantic().unwrap());
        assert_unique_ids(&reopened);
    }
    #[test]
    fn right_survivor_accepts_late_suffix_edits_from_the_original_parent() {
        let mut doc = right_source();
        let suffix = node(&doc, "d");
        let mut late = DocumentSession::with_test_client_id(29104).unwrap();
        late.apply_remote(&doc.update(None, 1).unwrap(), 1).unwrap();
        let vector = doc.state_vector();
        late.edit(Edit::Insert {
            block: "d".into(),
            offset: 1,
            text: "迟".into(),
        })
        .unwrap();
        {
            let mut txn = late.doc.transact_mut();
            late.find_block(&txn, "d").unwrap().insert_attribute(
                &mut txn,
                "lateMeta",
                "before-join-peer",
            );
        }
        right_join(&mut doc).unwrap();
        doc.apply_remote(&late.update(Some(&vector), 1).unwrap(), 1)
            .unwrap();
        assert_eq!(node(&doc, "d"), suffix);
        assert!(doc.native_projection().unwrap().text.ends_with("尾迟声"));
        for undo in [true, false] {
            assert!(if undo { doc.undo() } else { doc.redo() });
            assert_eq!(node(&doc, "d"), suffix);
            assert!(doc.native_projection().unwrap().text.ends_with("尾迟声"));
            assert_eq!(
                suffix.get_attribute(&doc.doc.transact(), "lateMeta"),
                Some(Out::Any(Any::String("before-join-peer".into())))
            );
            assert_unique_ids(&doc);
        }
    }

    #[test]
    fn right_survivor_conflicts_reject_before_any_public_identity_changes() {
        for kind in ["wrapper", "block", "text", "shared-wrapper"] {
            let mut doc = right_source();
            {
                let mut txn = doc.doc.transact_mut();
                let (left, right) = if kind == "wrapper" || kind == "shared-wrapper" {
                    (
                        doc.find_block(&txn, "left").unwrap(),
                        doc.find_block(&txn, "right").unwrap(),
                    )
                } else {
                    (
                        doc.find_block(&txn, "b").unwrap(),
                        doc.find_block(&txn, "c").unwrap(),
                    )
                };
                if kind == "text" {
                    let Some(XmlOut::Text(left)) = left.get(&txn, 0) else {
                        unreachable!()
                    };
                    let Some(XmlOut::Text(right)) = right.get(&txn, 0) else {
                        unreachable!()
                    };
                    left.insert_attribute(&mut txn, "conflict", "left");
                    right.insert_attribute(&mut txn, "conflict", "right");
                } else if kind == "shared-wrapper" {
                    right.insert_attribute(&mut txn, "shared", yrs::MapPrelim::default());
                } else {
                    left.insert_attribute(&mut txn, "conflict", "left");
                    right.insert_attribute(&mut txn, "conflict", "right");
                }
            }
            let before = doc.update(None, 1).unwrap();
            let error = right_join(&mut doc).unwrap_err();
            assert!(
                error.contains("conflict") || error.contains("shared"),
                "{kind}: {error}"
            );
            assert_eq!(doc.update(None, 1).unwrap(), before);
            assert!(!doc.undo());
            assert_unique_ids(&doc);
        }
    }

    #[test]
    fn consumed_container_keeps_typed_metadata_marks_comments_and_manual_selection_history() {
        let mut doc = source(false);
        let original = doc.semantic().unwrap();
        select(&mut doc, 1, 7);
        doc.set_comment_anchors(vec![CommentAnchorRecord {
            id: "tail-comment".into(),
            target_block_id: Some("c".into()),
            target_block_ids_json: r#"["c"]"#.into(),
            anchor_json: json!({"selectedText":"航","future":true,"textAnchor":{
                "startBlockId":"c","startOffset":1,"endBlockId":"c","endOffset":2,"text":"航"}})
            .to_string(),
        }])
        .unwrap();
        join(&mut doc).unwrap();
        let merged = doc.semantic().unwrap();
        assert_eq!(merged["content"].as_array().unwrap().len(), 1);
        assert_eq!(
            merged["content"][0]["attrs"]["futureQuote"],
            original["content"][1]["attrs"]["futureQuote"]
        );
        assert_eq!(
            merged["content"][0]["content"][1]["attrs"]["future"],
            original["content"][1]["content"][0]["attrs"]["future"]
        );
        assert_eq!(
            merged["content"][0]["content"][1]["content"][1]["marks"][0]["type"],
            "bold"
        );
        assert_eq!(caret(&doc), 6);
        assert_eq!(
            doc.native_projection().unwrap().comments[0].ranges[0].location,
            6
        );
        assert!(doc.undo());
        assert_eq!(doc.semantic().unwrap(), original);
        assert_eq!(caret(&doc), 7);
        assert!(doc.redo());
        assert_eq!(doc.semantic().unwrap(), merged);
        select(&mut doc, 2, 6);
        assert!(doc.undo());
        assert_eq!(caret(&doc), 7, "manual caret follows the copied tail");
        assert!(doc.redo());
        assert_eq!(caret(&doc), 6);
        let mut reopened = DocumentSession::new();
        reopened
            .apply_remote(&doc.update(None, 1).unwrap(), 1)
            .unwrap();
        reopened
            .set_comment_anchors(doc.comment_anchor_records())
            .unwrap();
        assert_eq!(reopened.semantic().unwrap(), merged);
        assert_eq!(
            reopened.native_projection().unwrap().comments[0].ranges[0].location,
            6
        );
    }
    #[test]
    fn conflicting_container_metadata_fails_atomically_before_any_text_is_removed() {
        let mut doc = source(false);
        {
            let mut txn = doc.doc.transact_mut();
            for (id, value) in [("left", "one"), ("right", "two")] {
                doc.find_block(&txn, id)
                    .unwrap()
                    .insert_attribute(&mut txn, "conflict", value);
            }
        }
        let before = doc.update(None, 1).unwrap();
        assert!(join(&mut doc)
            .unwrap_err()
            .contains("conflicting unknown container metadata"));
        assert_eq!(doc.update(None, 1).unwrap(), before);
        assert!(!doc.undo());
    }
    #[test]
    fn suffix_relocation_is_rejected_before_it_can_create_duplicate_ids_on_remote_undo() {
        let mut doc = source(true);
        let before = doc.update(None, 1).unwrap();
        assert!(join(&mut doc)
            .unwrap_err()
            .contains("Container suffix relocation requires identity-safe history"));
        assert_eq!(doc.update(None, 1).unwrap(), before);
        assert!(!doc.undo());
    }
}
