//! One prose document as a Loro document, following decision D3 as
//! `foundation.md` F1 states it: a single `LoroText`, one line per leaf block
//! ending in `\n`, block attributes as marks on that `\n`, inline formatting as
//! marks. The keys here are the spike's; P0-C's `loro-schema.md` owns the real ones.

use std::collections::{BTreeMap, HashMap};

use anyhow::{Context, Result, anyhow};
use loro::{
    ExpandType, ExportMode, Frontiers, LoroDoc, LoroText, LoroValue, StyleConfig, StyleConfigMap,
    TextDelta, UpdateOptions,
    cursor::{Cursor, Side},
};
use serde_json::Value;

use crate::prose::{Container, Line, Prose, Span, normalize_spans};

pub const BODY: &str = "body";
/// Inline formatting that grows when the author types at its end.
const EXPANDING: &[&str] = &["bold", "italic", "underline", "strike", "code", "highlight"];
const BLOCK_PREFIX: &str = "b.";

/// A Loro key per mark. Entity links may overlap (`excludes: ''` in the old
/// schema), and one Loro key holds one value per character, so each target gets
/// its own key. No hash: the key is readable and the same in every language.
fn mark_key(span: &Span) -> String {
    match span.mark.as_str() {
        "entityLink" => {
            let attrs: Value = serde_json::from_str(&span.attrs).unwrap_or(Value::Null);
            let field = |name: &str| {
                attrs
                    .get(name)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            };
            format!(
                "entityLink:{}:{}:{}",
                field("targetKind"),
                field("targetId"),
                field("targetBlockId")
            )
        }
        other => other.to_string(),
    }
}

fn mark_name(key: &str) -> &str {
    key.split(':').next().unwrap_or(key)
}

pub fn new_doc(peer: u64) -> Result<LoroDoc> {
    let doc = LoroDoc::new();
    doc.set_peer_id(peer)?;
    let mut styles = StyleConfigMap::new();
    for key in EXPANDING {
        styles.insert(
            (*key).into(),
            StyleConfig {
                expand: ExpandType::After,
            },
        );
    }
    doc.config_text_style(styles);
    // Links, entity links, inline objects and block attributes never grow.
    doc.config_default_text_style(Some(StyleConfig {
        expand: ExpandType::None,
    }));
    Ok(doc)
}

fn json_string(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

fn line_attributes(line: &Line) -> Vec<(String, LoroValue)> {
    let mut out = vec![(
        format!("{BLOCK_PREFIX}type"),
        LoroValue::from(line.kind.as_str()),
    )];
    for (key, value) in &line.attrs {
        out.push((
            format!("{BLOCK_PREFIX}{key}"),
            LoroValue::from(json_string(value)),
        ));
    }
    if !line.path.is_empty() {
        out.push((
            format!("{BLOCK_PREFIX}path"),
            LoroValue::from(json_string(&line.path)),
        ));
    }
    out.push((
        format!("{BLOCK_PREFIX}ordinal"),
        LoroValue::from(line.ordinal as i64),
    ));
    if line.atom {
        out.push((format!("{BLOCK_PREFIX}atom"), LoroValue::from(true)));
    }
    out
}

fn flatten(prose: &Prose) -> (String, Vec<usize>) {
    let mut body = String::new();
    let mut starts = Vec::with_capacity(prose.lines.len());
    let mut at = 0usize;
    for line in &prose.lines {
        starts.push(at);
        body.push_str(&line.text);
        body.push('\n');
        at += line.text.chars().count() + 1;
    }
    (body, starts)
}

/// Write `prose` into `doc`'s (empty) body text. Returns the char offset of every line start.
pub fn write(doc: &LoroDoc, prose: &Prose) -> Result<Vec<usize>> {
    let (body, starts) = flatten(prose);
    doc.get_text(BODY).insert(0, &body)?;
    apply_marks(&doc.get_text(BODY), prose, &starts)?;
    doc.commit();
    Ok(starts)
}

/// Turn the body into `prose` with as few text operations as a diff gives:
/// how one snapshot-history version follows the previous one.
pub fn rewrite(doc: &LoroDoc, prose: &Prose) -> Result<Vec<usize>> {
    let text = doc.get_text(BODY);
    let (body, starts) = flatten(prose);
    text.update(&body, UpdateOptions::default())
        .map_err(|e| anyhow!("{e:?}"))?;
    let len = text.len_unicode();
    let mut keys: Vec<String> = Vec::new();
    for delta in text.to_delta() {
        if let TextDelta::Insert {
            attributes: Some(attributes),
            ..
        } = delta
        {
            keys.extend(attributes.into_keys());
        }
    }
    keys.sort();
    keys.dedup();
    for key in keys {
        text.unmark(0..len, &key)?;
    }
    apply_marks(&text, prose, &starts)?;
    doc.commit();
    Ok(starts)
}

/// Replay snapshot-history versions (oldest first) into one document and return
/// the version each one left, so restoring a label is a checkout, not a copy.
pub fn replay(versions: &[Prose], peer: u64) -> Result<(LoroDoc, Vec<Frontiers>, bool)> {
    let doc = new_doc(peer)?;
    let mut frontiers = Vec::with_capacity(versions.len());
    for (index, version) in versions.iter().enumerate() {
        if index == 0 {
            write(&doc, version)?;
        } else {
            rewrite(&doc, version)?;
        }
        frontiers.push(doc.state_frontiers());
    }
    let mut all_match = true;
    for (version, at) in versions.iter().zip(&frontiers) {
        doc.checkout(at)?;
        all_match &= read(&doc.get_text(BODY))? == *version;
    }
    doc.checkout_to_latest();
    Ok((doc, frontiers, all_match))
}

fn apply_marks(text: &LoroText, prose: &Prose, starts: &[usize]) -> Result<()> {
    for (line, start) in prose.lines.iter().zip(starts) {
        for span in &line.marks {
            let value = if span.attrs.is_empty() {
                LoroValue::from(true)
            } else {
                LoroValue::from(span.attrs.as_str())
            };
            text.mark(start + span.start..start + span.end, &mark_key(span), value)?;
        }
        let newline = start + line.text.chars().count();
        for (key, value) in line_attributes(line) {
            text.mark(newline..newline + 1, &key, value)?;
        }
    }
    Ok(())
}

fn as_json(value: &LoroValue) -> Result<Value> {
    let raw = value
        .as_string()
        .ok_or_else(|| anyhow!("block attribute is not a string"))?;
    Ok(serde_json::from_str(raw)?)
}

/// Read the body text back into lines.
pub fn read(text: &LoroText) -> Result<Prose> {
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut spans: Vec<Span> = Vec::new();
    let mut len = 0usize;
    for delta in text.to_delta() {
        let TextDelta::Insert { insert, attributes } = delta else {
            continue;
        };
        let attributes: HashMap<String, LoroValue> = attributes
            .map(|a| a.into_iter().collect())
            .unwrap_or_default();
        for piece in insert.split_inclusive('\n') {
            let (body, ends_line) = match piece.strip_suffix('\n') {
                Some(body) => (body, true),
                None => (piece, false),
            };
            let count = body.chars().count();
            if count > 0 {
                for (key, value) in &attributes {
                    if key.starts_with(BLOCK_PREFIX) {
                        continue;
                    }
                    let attrs = if value.as_bool() == Some(&true) {
                        String::new()
                    } else {
                        value.as_string().map(|s| s.to_string()).unwrap_or_default()
                    };
                    spans.push(Span {
                        start: len,
                        end: len + count,
                        mark: mark_name(key).to_string(),
                        attrs,
                    });
                }
                current.push_str(body);
                len += count;
            }
            if ends_line {
                lines.push(finish_line(
                    &attributes,
                    std::mem::take(&mut current),
                    normalize_spans(std::mem::take(&mut spans)),
                )?);
                len = 0;
            }
        }
    }
    Ok(Prose { lines })
}

fn finish_line(
    attributes: &HashMap<String, LoroValue>,
    text: String,
    marks: Vec<Span>,
) -> Result<Line> {
    let mut attrs = BTreeMap::new();
    let mut kind = String::new();
    let mut path: Vec<Container> = Vec::new();
    let mut ordinal = 0usize;
    let mut atom = false;
    for (key, value) in attributes {
        let Some(name) = key.strip_prefix(BLOCK_PREFIX) else {
            continue;
        };
        match name {
            "type" => kind = value.as_string().map(|s| s.to_string()).unwrap_or_default(),
            "path" => path = serde_json::from_value(as_json(value)?).context("block path")?,
            "ordinal" => ordinal = value.as_i64().copied().unwrap_or(0) as usize,
            "atom" => atom = value.as_bool() == Some(&true),
            other => {
                attrs.insert(other.to_string(), as_json(value)?);
            }
        }
    }
    Ok(Line {
        kind,
        attrs,
        path,
        text,
        marks,
        ordinal,
        atom,
    })
}

/// Build one prose document, read it back, and export a snapshot.
pub struct Built {
    pub doc: LoroDoc,
    pub line_starts: Vec<usize>,
    pub round_trip: bool,
    pub snapshot_bytes: usize,
}

pub fn build(prose: &Prose, peer: u64) -> Result<Built> {
    let doc = new_doc(peer)?;
    let line_starts = write(&doc, prose)?;
    let round_trip = read(&doc.get_text(BODY))? == *prose;
    let snapshot_bytes = doc.export(ExportMode::Snapshot)?.len();
    Ok(Built {
        doc,
        line_starts,
        round_trip,
        snapshot_bytes,
    })
}

/// A stable Loro position for a char offset in the body, checked by resolving it back.
pub fn cursor_at(doc: &LoroDoc, pos: usize, side: Side) -> Result<Option<Cursor>> {
    let text = doc.get_text(BODY);
    let Some(cursor) = text.get_cursor(pos, side) else {
        return Ok(None);
    };
    let resolved = doc.get_cursor_pos(&cursor).map_err(|e| anyhow!("{e:?}"))?;
    Ok((resolved.current.pos == pos).then_some(cursor))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prose::parse;

    #[test]
    fn lines_round_trip_through_loro() {
        let source = r#"{"type":"doc","content":[
          {"type":"heading","attrs":{"id":"h","level":2},"content":[{"type":"text","text":"标题"}]},
          {"type":"paragraph","attrs":{"id":"p","indent":2},"content":[
            {"type":"text","text":"阿Q","marks":[{"type":"entityLink","attrs":{"targetKind":"element","targetId":"a"}},{"type":"entityLink","attrs":{"targetKind":"element","targetId":"b"}}]},
            {"type":"text","text":"说","marks":[{"type":"bold"}]},{"type":"hardBreak"},{"type":"text","text":"儿子打老子"}]},
          {"type":"blockquote","attrs":{"id":"q"},"content":[{"type":"paragraph","attrs":{"id":"qp"}}]},
          {"type":"horizontalRule","attrs":{"id":"hr"}}
        ]}"#;
        let prose = parse(source).unwrap();
        let built = build(&prose, 7).unwrap();
        assert!(
            built.round_trip,
            "{:#?}",
            read(&built.doc.get_text(BODY)).unwrap()
        );
        assert_eq!(built.line_starts, vec![0, 3, 13, 14]);
        // Typing after a bold run extends it; typing after an entity link does not.
        let text = built.doc.get_text(BODY);
        text.insert(6, "了").unwrap();
        text.insert(5, "们").unwrap();
        let after = read(&text).unwrap();
        let p = &after.lines[1];
        assert!(
            p.marks
                .iter()
                .any(|s| s.mark == "bold" && s.start == 3 && s.end == 5)
        );
        assert!(
            p.marks
                .iter()
                .filter(|s| s.mark == "entityLink")
                .all(|s| s.end == 2)
        );
    }

    #[test]
    fn history_versions_replay_into_checkoutable_frontiers() {
        let v = |body: &str| parse(&format!(r#"{{"type":"doc","content":[{body}]}}"#)).unwrap();
        let versions = [
            v(
                r#"{"type":"paragraph","attrs":{"id":"p"},"content":[{"type":"text","text":"已经不止一两年了"}]}"#,
            ),
            v(
                r#"{"type":"paragraph","attrs":{"id":"p"},"content":[{"type":"text","text":"已经不止三四年了","marks":[{"type":"bold"}]}]}"#,
            ),
            v(
                r#"{"type":"paragraph","attrs":{"id":"p"},"content":[{"type":"text","text":"已经不止三四年了"}]},{"type":"heading","attrs":{"id":"h","level":3},"content":[{"type":"text","text":"新"}]}"#,
            ),
        ];
        let (doc, frontiers, all_match) = replay(&versions, 3).unwrap();
        assert!(all_match);
        assert_eq!(frontiers.len(), 3);
        assert_eq!(read(&doc.get_text(BODY)).unwrap(), versions[2]);
    }

    #[test]
    fn cursors_resolve_to_their_offsets() {
        let prose = parse(r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"p"},"content":[{"type":"text","text":"你那里配姓赵"}]}]}"#).unwrap();
        let built = build(&prose, 1).unwrap();
        let start = cursor_at(&built.doc, 1, Side::Middle).unwrap().unwrap();
        let end = cursor_at(&built.doc, 3, Side::Middle).unwrap().unwrap();
        built.doc.get_text(BODY).insert(0, "“").unwrap();
        assert_eq!(built.doc.get_cursor_pos(&start).unwrap().current.pos, 2);
        assert_eq!(built.doc.get_cursor_pos(&end).unwrap().current.pos, 4);
    }
}
