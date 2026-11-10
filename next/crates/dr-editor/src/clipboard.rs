//! Versioned rich clipboard. Copy reads the displayed mirror, never a fresh
//! writer observation. Tagged values retain types; container references refuse
//! the action before any cut/paste mutation.
use crate::table::clip::CellMark;
use gpui::{App, ClipboardItem, Entity, Focusable, Window};
use gpui_prose::{
    HostStep, ProseEditor,
    text::{Edit, ORIGIN_USER, ProseDoc},
};
use loro::LoroValue;
use serde_json::{Value, json};
const KEY: &str = "drifting_prose_v3";
pub(crate) fn encode_value(v: &LoroValue) -> Result<Value, String> {
    encode_at(v, 0)
}
fn encode_at(v: &LoroValue, depth: u8) -> Result<Value, String> {
    if depth > 48 {
        return Err("clipboard value nesting is unsupported".into());
    }
    Ok(match v {
        LoroValue::Null => json!(["null"]),
        LoroValue::Bool(v) => json!(["bool", v]),
        LoroValue::I64(v) => json!(["i64", v.to_string()]),
        LoroValue::Double(v) => json!(["f64", v.to_bits().to_string()]),
        LoroValue::String(v) => json!(["string", v.as_str()]),
        LoroValue::Binary(v) => json!(["binary", v.as_slice()]),
        LoroValue::List(v) => json!([
            "list",
            v.iter()
                .map(|v| encode_at(v, depth + 1))
                .collect::<Result<Vec<_>, _>>()?
        ]),
        LoroValue::Map(v) => json!([
            "map",
            v.iter()
                .map(|(k, v)| Ok((k.clone(), encode_at(v, depth + 1)?)))
                .collect::<Result<std::collections::BTreeMap<_, _>, String>>()?
        ]),
        LoroValue::Container(_) => {
            return Err("clipboard container references are unsupported".into());
        }
    })
}
pub(crate) fn decode_value(value: &Value) -> Result<LoroValue, String> {
    let bad = || "invalid typed clipboard value".to_owned();
    let a = value.as_array().ok_or_else(bad)?;
    let tag = a.first().and_then(Value::as_str).ok_or_else(bad)?;
    if tag == "null" && a.len() == 1 {
        return Ok(LoroValue::Null);
    }
    if a.len() != 2 {
        return Err(bad());
    }
    let v = &a[1];
    Ok(match tag {
        "bool" => LoroValue::Bool(v.as_bool().ok_or_else(bad)?),
        "i64" => LoroValue::I64(v.as_str().ok_or_else(bad)?.parse().map_err(|_| bad())?),
        "f64" => LoroValue::Double(f64::from_bits(
            v.as_str().ok_or_else(bad)?.parse().map_err(|_| bad())?,
        )),
        "string" => v.as_str().ok_or_else(bad)?.into(),
        "binary" => LoroValue::Binary(
            serde_json::from_value::<Vec<u8>>(v.clone())
                .map_err(|_| bad())?
                .into(),
        ),
        "list" => LoroValue::List(
            v.as_array()
                .ok_or_else(bad)?
                .iter()
                .map(decode_value)
                .collect::<Result<Vec<_>, _>>()?
                .into(),
        ),
        "map" => LoroValue::Map(
            v.as_object()
                .ok_or_else(bad)?
                .iter()
                .map(|(k, v)| Ok((k.clone(), decode_value(v)?)))
                .collect::<Result<Vec<_>, String>>()?
                .into(),
        ),
        _ => return Err(bad()),
    })
}
pub(crate) fn encode_marks(marks: &[CellMark]) -> Result<Value, String> {
    Ok(Value::Array(
        marks
            .iter()
            .map(|(a, b, k, v)| Ok(json!([a, b, k, encode_value(v)?])))
            .collect::<Result<Vec<_>, String>>()?,
    ))
}
pub(crate) fn decode_marks(value: &Value) -> Result<Vec<CellMark>, String> {
    let bad = || "invalid clipboard marks".to_owned();
    value
        .as_array()
        .ok_or_else(bad)?
        .iter()
        .map(|v| {
            let a = v.as_array().filter(|a| a.len() == 4).ok_or_else(bad)?;
            let at = |n: usize| {
                a[n].as_u64()
                    .and_then(|n| usize::try_from(n).ok())
                    .ok_or_else(bad)
            };
            Ok((
                at(0)?,
                at(1)?,
                a[2].as_str().ok_or_else(bad)?.to_owned(),
                decode_value(&a[3])?,
            ))
        })
        .collect()
}
pub(crate) fn metadata_checked(item: &ClipboardItem) -> Result<Option<Value>, String> {
    for entry in item.entries() {
        if let gpui::ClipboardEntry::String(s) = entry
            && let Some(metadata) = s.metadata.as_deref()
        {
            return serde_json::from_str(metadata)
                .map(Some)
                .map_err(|e| format!("malformed clipboard metadata: {e}"));
        }
    }
    Ok(None)
}
pub(crate) fn metadata(item: &ClipboardItem) -> Option<Value> {
    metadata_checked(item).ok().flatten()
}
fn supported(key: &str) -> bool {
    dr_doc::schema::inline::entity_target(key).is_some()
        || matches!(
            key,
            "bold" | "italic" | "underline" | "strike" | "code" | "link" | "highlight"
        )
}
pub(crate) fn validate(text: &str, marks: &[CellMark]) -> Result<(), String> {
    let len = text.chars().count();
    for (a, b, k, v) in marks {
        if a >= b || *b > len || !supported(k) || v.is_null() {
            return Err("invalid clipboard mark range or key".into());
        }
        encode_value(v)?;
    }
    dr_doc::prose::v3::EntityLinkMarksV3::from_marks(
        len,
        marks
            .iter()
            .filter(|m| dr_doc::schema::inline::entity_target(&m.2).is_some())
            .map(|(a, b, k, v)| (*a..*b, k.clone(), v.clone()))
            .collect(),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn fragment(
    doc: &ProseDoc,
    range: std::ops::Range<usize>,
) -> Result<(String, Vec<CellMark>), String> {
    let text = doc.slice(range.clone());
    let mut marks = Vec::new();
    for (ix, line) in doc.lines().iter().enumerate() {
        let at = doc.line_start(ix);
        for span in line.spans.iter() {
            let a = at + line.text[..span.range.start].chars().count();
            let b = at + line.text[..span.range.end].chars().count();
            let start = a.max(range.start);
            let end = b.min(range.end);
            if start < end {
                for (k, v) in span.marks.iter() {
                    marks.push((
                        start - range.start,
                        end - range.start,
                        k.to_owned(),
                        v.clone(),
                    ));
                }
            }
        }
    }
    validate(&text, &marks)?;
    Ok((text, marks))
}
fn copied(editor: &ProseEditor) -> Result<ClipboardItem, String> {
    let sel = editor.selection();
    let mut text = String::new();
    let mut marks = Vec::new();
    let mut first = true;
    for chapter in sel.start().chapter..=sel.end().chapter {
        let doc = &editor.book().chapters[chapter].doc;
        let Some((range, _)) = editor.selected_in(chapter) else {
            continue;
        };
        let (part, mut runs) = fragment(doc, range)?;
        if !first {
            text.push('\n');
        }
        first = false;
        let at = text.chars().count();
        for m in &mut runs {
            m.0 += at;
            m.1 += at;
        }
        text += &part;
        marks.extend(runs);
    }
    let payload = encode_marks(&marks)?;
    Ok(ClipboardItem::new_string_with_json_metadata(
        text.clone(),
        json!({KEY:{"version":1,"text":text,"marks":payload}}),
    ))
}
fn guard(doc: &mut ProseDoc) {
    let source = doc.source_mut().as_any_mut();
    if let Some(s) = source.downcast_mut::<crate::SessionSource>() {
        s.guard_rich = true;
    } else if let Some(s) = source.downcast_mut::<crate::table::CellSource>() {
        s.guard_rich = true;
    }
}
pub(crate) fn copy(
    editor: &Entity<ProseEditor>,
    cut: bool,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let e = editor.read(cx);
    if !e.focus_handle(cx).is_focused(window) || e.selection().is_empty() {
        return false;
    }
    if e.composition().is_some() {
        return true;
    }
    match copied(e) {
        Ok(item) => {
            cx.write_to_clipboard(item);
            if cut {
                editor.update(cx, |e, cx| {
                    let sel = e.selection();
                    if sel.spans_chapters() {
                        crate::links::clipboard_refused(cx, "cut across documents");
                        return;
                    }
                    let saved = std::cell::Cell::new(false);
                    e.edit_chapter(sel.chapter, HostStep::Own, window, cx, |doc| {
                        guard(doc);
                        let out =
                            doc.edit_batch(&[Edit::Delete { range: sel.range() }], ORIGIN_USER);
                        saved.set(!out.deleted.is_empty());
                        saved.get().then_some(sel.range().start)
                    });
                    if !saved.get() {
                        crate::links::clipboard_refused(cx, "stale or failed rich cut");
                    }
                });
            }
        }
        Err(e) => crate::links::clipboard_refused(cx, e),
    }
    true
}
pub(crate) fn paste(editor: &Entity<ProseEditor>, window: &mut Window, cx: &mut App) -> bool {
    if !editor.read(cx).focus_handle(cx).is_focused(window) {
        return false;
    }
    let Some(item) = cx.read_from_clipboard() else {
        return false;
    };
    let meta = match metadata_checked(&item) {
        Ok(Some(meta)) => meta,
        Ok(None) => return false,
        Err(e) => {
            crate::links::clipboard_refused(cx, e);
            return true;
        }
    };
    let Some(value) = meta.get(KEY) else {
        return false;
    };
    let parsed = (|| {
        if value["version"] != 1 {
            return Err("unsupported rich clipboard version".into());
        }
        let text = value["text"]
            .as_str()
            .ok_or("missing clipboard text")?
            .to_owned();
        if item.text().as_deref() != Some(text.as_str()) {
            return Err("clipboard text mismatch".into());
        }
        let marks = decode_marks(&value["marks"])?;
        validate(&text, &marks)?;
        Ok::<_, String>((text, marks))
    })();
    let (text, marks) = match parsed {
        Ok(p) => p,
        Err(e) => {
            crate::links::clipboard_refused(cx, e);
            return true;
        }
    };
    let e = editor.read(cx);
    let sel = e.selection();
    if e.composition().is_some() {
        return true;
    }
    if sel.spans_chapters() {
        crate::links::clipboard_refused(cx, "rich paste across documents is unsupported");
        return true;
    }
    let doc = &e.book().chapters[sel.chapter].doc;
    if doc
        .source_as::<crate::SessionSource>()
        .is_some_and(|s| crate::v3::body(s.doc_id()).is_some())
        && (text.contains('\u{fffc}')
            || marks
                .iter()
                .any(|m| matches!(m.2.as_str(), "highlight" | "code")))
    {
        crate::links::clipboard_refused(cx, "unsupported target profile");
        return true;
    }
    let range = sel.range();
    let at = range.start;
    editor.update(cx, move |e, cx| {
        let saved = std::cell::Cell::new(false);
        let completed = &saved;
        e.edit_chapter(sel.chapter, HostStep::Own, window, cx, move |doc| {
            let clears = doc
                .marks_before(at)
                .iter()
                .map(|(k, _)| (k.to_owned(), None))
                .collect::<Vec<_>>();
            let mut edits = vec![Edit::Replace {
                range: range.clone(),
                text: &text,
                overrides: &clears,
            }];
            for (a, b, k, v) in &marks {
                edits.push(Edit::Mark {
                    range: at + a..at + b,
                    key: k,
                    value: v.clone(),
                });
            }
            guard(doc);
            let out = doc.edit_batch(&edits, ORIGIN_USER);
            completed.set(out.undo_items > 0 || out.caret > 0);
            if completed.get() {
                Some(at + text.chars().count())
            } else {
                None
            }
        });
        if !saved.get() {
            crate::links::clipboard_refused(cx, "stale or failed rich paste");
        }
    });
    true
}

/// Rich text selections inside a cell use the same lossless OS metadata.
pub(crate) fn wrap(
    editor: &Entity<ProseEditor>,
    element: impl gpui::IntoElement,
) -> impl gpui::IntoElement {
    use gpui::{InteractiveElement as _, ParentElement as _, Styled as _};
    use gpui_prose::input::actions::{Copy, Cut, Paste};
    let c = editor.clone();
    let x = editor.clone();
    let p = editor.clone();
    gpui::div()
        .size_full()
        .capture_action(move |_: &Copy, w, cx| {
            if copy(&c, false, w, cx) {
                cx.stop_propagation();
            }
        })
        .capture_action(move |_: &Cut, w, cx| {
            if copy(&x, true, w, cx) {
                cx.stop_propagation();
            }
        })
        .capture_action(move |_: &Paste, w, cx| {
            if paste(&p, w, cx) {
                cx.stop_propagation();
            }
        })
        .child(element)
}

#[cfg(test)]
mod tests;
