//! Read-only text for search. Never writes Yrs state back to SQLite or a live
//! editor. Preserve the renderer's top-level block ordinals and concatenation:
//! hard breaks contribute no text; empty/whitespace blocks are retained.
use crate::DocumentSession;
use yrs::{
    types::text::YChange, updates::decoder::Decode, Any, Out, ReadTxn, Text, Transact, XmlFragment,
    XmlOut,
};

pub fn search_text_blocks(updates: &[Vec<u8>]) -> Result<Vec<String>, String> {
    let doc = yrs::Doc::with_options(yrs::Options {
        offset_kind: yrs::OffsetKind::Utf16,
        ..Default::default()
    });
    let root = doc.get_or_insert_xml_fragment("default");
    for bytes in updates {
        let bytes = DocumentSession::normalize_update(bytes, 1)?;
        doc.transact_mut()
            .apply_update(yrs::Update::decode_v1(&bytes).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    let txn = doc.transact();
    if txn.has_missing_updates() {
        return Err("Pending dependencies".into());
    }
    fn text(node: &XmlOut, txn: &impl ReadTxn, out: &mut String) -> Result<(), String> {
        match node {
            XmlOut::Text(value) => {
                for delta in value.diff(txn, YChange::identity) {
                    match delta.insert {
                        Out::Any(Any::String(value)) => out.push_str(&value),
                        _ => return Err("Unsupported embedded value".into()),
                    }
                }
            }
            XmlOut::Element(value) => {
                if value.tag().as_ref() == "text" {
                    return Err("Unsupported text element".into());
                }
                for child in value.children(txn) {
                    text(&child, txn, out)?;
                }
            }
            _ => return Err("Unsupported nested fragment".into()),
        }
        Ok(())
    }
    root.children(&txn)
        .map(|node| {
            if !matches!(node, XmlOut::Element(_)) {
                return Err("Unsupported top-level text".into());
            }
            let mut out = String::new();
            text(&node, &txn, &mut out)?;
            Ok(out)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Edit;

    #[test]
    fn readonly_snapshot_tail_and_deletion_preserve_text_and_empty_blocks() {
        let mut doc = DocumentSession::with_test_client_id(88001).unwrap();
        for (id, text) in [("one", "Ａ👩🏽‍🚀e\u{301}甲"), ("empty", ""), ("space", "  ")]
        {
            doc.edit(Edit::AppendParagraph {
                id: id.into(),
                text: text.into(),
            })
            .unwrap();
        }
        let snapshot = doc.update(None, 1).unwrap();
        let vector = doc.state_vector();
        doc.edit(Edit::Delete {
            block: "one".into(),
            offset: 0,
            length: 1,
        })
        .unwrap();
        doc.edit(Edit::Insert {
            block: "one".into(),
            offset: 0,
            text: "尾".into(),
        })
        .unwrap();
        let tail = doc.update(Some(&vector), 1).unwrap();
        assert_eq!(
            search_text_blocks(&[snapshot, tail.clone()]).unwrap(),
            vec!["尾👩🏽‍🚀e\u{301}甲", "", "  "]
        );
        assert!(
            search_text_blocks(&[tail]).is_err(),
            "missing snapshot cannot look like empty text"
        );
        assert!(search_text_blocks(&[vec![255, 255]]).is_err());
    }
}
