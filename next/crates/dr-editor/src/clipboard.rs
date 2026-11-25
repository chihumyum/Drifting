//! Versioned rich clipboard. Copy reads the displayed mirror, never a fresh
//! writer observation. Tagged values retain types; container references refuse
//! the action before any cut/paste mutation.
//!
//! What other programs copy with formatting (HTML, or RTF the platform
//! turns into HTML) pastes into a body with the formats a body has
//! ([`paste_html`]); a table's cell, a title or a field still takes only
//! the text. ⇧⌘V ([`PasteAsPlainText`]) takes only the text anywhere in a
//! body ([`paste_plain_text`]).
use crate::table::clip::{CellMark, GridMarks};
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
pub(crate) fn encode_blocks(blocks: &[gpui_prose::text::BlockAttrs]) -> Result<Value, String> {
    let mut out = Vec::with_capacity(blocks.len());
    for attrs in blocks {
        let mut obj = serde_json::Map::new();
        for &key in gpui_prose::text::PASTED_KEYS {
            if let Some(val) = attrs.get(key) {
                obj.insert(key.to_owned(), encode_value(val)?);
            }
        }
        out.push(Value::Object(obj));
    }
    Ok(Value::Array(out))
}

pub(crate) fn decode_blocks(value: &Value) -> Result<Vec<gpui_prose::text::BlockAttrs>, String> {
    let bad = || "invalid clipboard blocks".to_owned();
    value
        .as_array()
        .ok_or_else(bad)?
        .iter()
        .map(|entry| {
            let map = entry.as_object().ok_or_else(bad)?;
            let mut attrs = gpui_prose::text::BlockAttrs::default();
            for (k, v) in map {
                if !gpui_prose::text::PASTED_KEYS.contains(&k.as_str()) {
                    return Err(bad());
                }
                attrs.set(k, Some(decode_value(v)?));
            }
            Ok(attrs)
        })
        .collect()
}

fn fragment(
    doc: &ProseDoc,
    range: std::ops::Range<usize>,
) -> Result<(String, Vec<CellMark>, Vec<gpui_prose::text::BlockAttrs>), String> {
    let text = doc.slice(range.clone());
    let mut marks = Vec::new();
    let (first_line, _) = doc.locate(range.start);
    let (last_line, _) = doc.locate(range.end);
    let single_partial = first_line == last_line
        && (range.start > doc.line_start(first_line)
            || range.end < doc.line_start(first_line) + doc.line(first_line).chars);
    let mut blocks = Vec::with_capacity(last_line.saturating_sub(first_line) + 1);
    for ix in first_line..=last_line {
        let line = doc.line(ix);
        let at = doc.line_start(ix);
        if single_partial {
            blocks.push(gpui_prose::text::BlockAttrs::default());
        } else {
            let mut attrs = gpui_prose::text::BlockAttrs::default();
            for &key in gpui_prose::text::PASTED_KEYS {
                if let Some(v) = line.block.get(key) {
                    attrs.set(key, Some(v.clone()));
                }
            }
            blocks.push(attrs);
        }
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
    Ok((text, marks, blocks))
}

fn build_fragment(
    text: &str,
    marks: &[CellMark],
    blocks: &[gpui_prose::text::BlockAttrs],
) -> gpui_prose::text::Fragment {
    let parts: Vec<&str> = text.split('\n').collect();
    let mut paragraphs = Vec::with_capacity(parts.len());
    let mut offset = 0usize;
    for (ix, part) in parts.iter().enumerate() {
        let len = part.chars().count();
        let end = offset + len;
        let mut p_marks = Vec::new();
        for (a, b, k, v) in marks {
            let s = (*a).max(offset);
            let e = (*b).min(end);
            if s < e {
                p_marks.push((s - offset..e - offset, k.clone(), v.clone()));
            }
        }
        let attrs = blocks.get(ix).cloned().unwrap_or_default();
        paragraphs.push(gpui_prose::text::FragmentParagraph {
            text: (*part).to_owned(),
            marks: p_marks,
            attrs,
        });
        offset = end + 1;
    }
    gpui_prose::text::Fragment { paragraphs }
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\u{2028}' => out.push_str("<br>"),
            _ => out.push(c),
        }
    }
    out
}

/// Renders a copied fragment as semantic HTML for external applications.
pub(crate) fn fragment_to_html(
    text: &str,
    marks: &[CellMark],
    blocks: &[gpui_prose::text::BlockAttrs],
) -> String {
    use gpui_prose::schema::block;
    let frag = build_fragment(text, marks, blocks);
    let mut out = String::new();
    let mut open_list: Option<&str> = None;
    let close_list = |out: &mut String, list: &mut Option<&str>| {
        if let Some(tag) = list.take() {
            out.push_str("</");
            out.push_str(tag);
            out.push('>');
        }
    };
    for p in &frag.paragraphs {
        let list_tag = match p.attrs.get(block::LIST) {
            Some(LoroValue::String(s)) if s.as_str() == "ordered" => Some("ol"),
            Some(LoroValue::String(_)) => Some("ul"),
            _ => None,
        };
        if list_tag != open_list {
            close_list(&mut out, &mut open_list);
            if let Some(tag) = list_tag {
                out.push('<');
                out.push_str(tag);
                out.push('>');
                open_list = Some(tag);
            }
        }
        if p.is_rule() {
            out.push_str("<hr>");
            continue;
        }
        let body = inline_html(&p.text, &p.marks);
        if list_tag.is_some() {
            out.push_str("<li>");
            out.push_str(&body);
            out.push_str("</li>");
        } else if p.attrs.get(block::CODE_BLOCK).is_some() {
            out.push_str("<pre><code>");
            out.push_str(&escape_html(&p.text));
            out.push_str("</code></pre>");
        } else if matches!(p.attrs.get(block::QUOTE), Some(LoroValue::Bool(true))) {
            out.push_str("<blockquote><p>");
            out.push_str(&body);
            out.push_str("</p></blockquote>");
        } else if let Some(level) = p.attrs.heading() {
            out.push_str(&format!("<h{level}>{body}</h{level}>"));
        } else {
            let align = match p.attrs.get(block::ALIGN) {
                Some(LoroValue::String(a)) if a.as_str() == "center" => {
                    " style=\"text-align:center\""
                }
                Some(LoroValue::String(a)) if a.as_str() == "right" => {
                    " style=\"text-align:right\""
                }
                _ => "",
            };
            out.push_str(&format!("<p{align}>{body}</p>"));
        }
    }
    close_list(&mut out, &mut open_list);
    out
}

fn inline_html(text: &str, marks: &[(std::ops::Range<usize>, String, LoroValue)]) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return String::new();
    }
    let mut cuts: Vec<usize> = vec![0, chars.len()];
    for (r, _, _) in marks {
        cuts.push(r.start.min(chars.len()));
        cuts.push(r.end.min(chars.len()));
    }
    cuts.sort_unstable();
    cuts.dedup();
    let mut out = String::new();
    for win in cuts.windows(2) {
        let (a, b) = (win[0], win[1]);
        if a >= b {
            continue;
        }
        let seg: String = chars[a..b].iter().collect();
        let mut piece = escape_html(&seg);
        let mut bold = false;
        let mut italic = false;
        let mut underline = false;
        let mut strike = false;
        let mut code = false;
        let mut highlight = false;
        let mut href: Option<&str> = None;
        for (r, k, v) in marks {
            if r.start <= a && b <= r.end {
                match k.as_str() {
                    "bold" => bold = true,
                    "italic" => italic = true,
                    "underline" => underline = true,
                    "strike" => strike = true,
                    "code" => code = true,
                    "highlight" => highlight = true,
                    "link" => {
                        if let LoroValue::String(url) = v {
                            href = Some(url.as_str());
                        }
                    }
                    _ => {}
                }
            }
        }
        if code {
            piece = format!("<code>{piece}</code>");
        }
        if highlight {
            piece = format!("<mark>{piece}</mark>");
        }
        if strike {
            piece = format!("<s>{piece}</s>");
        }
        if underline {
            piece = format!("<u>{piece}</u>");
        }
        if italic {
            piece = format!("<em>{piece}</em>");
        }
        if bold {
            piece = format!("<strong>{piece}</strong>");
        }
        if let Some(url) = href {
            piece = format!("<a href=\"{}\">{piece}</a>", escape_html(url));
        }
        out.push_str(&piece);
    }
    out
}

fn copied(editor: &ProseEditor) -> Result<(ClipboardItem, String), String> {
    let sel = editor.selection();
    let mut text = String::new();
    let mut marks = Vec::new();
    let mut blocks = Vec::new();
    let mut first = true;
    for chapter in sel.start().chapter..=sel.end().chapter {
        let doc = &editor.book().chapters[chapter].doc;
        let Some((range, _)) = editor.selected_in(chapter) else {
            continue;
        };
        let (part, mut runs, part_blocks) = fragment(doc, range)?;
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
        blocks.extend(part_blocks);
    }
    let payload = encode_marks(&marks)?;
    let html = fragment_to_html(&text, &marks, &blocks);
    let meta = if blocks.iter().any(|b| !b.is_empty()) {
        let blocks_payload = encode_blocks(&blocks)?;
        json!({KEY:{"version":1,"text":text,"marks":payload,"blocks":blocks_payload}})
    } else {
        json!({KEY:{"version":1,"text":text,"marks":payload}})
    };
    Ok((
        ClipboardItem::new_string_with_json_metadata(text, meta),
        html,
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

/// The marks the text before `at` would carry on into typed text, cleared:
/// pasted text has only its own.
fn caret_clears(doc: &ProseDoc, at: usize) -> Vec<gpui_prose::text::MarkOverride> {
    doc.marks_before(at)
        .iter()
        .map(|(k, _)| (k.to_owned(), None))
        .collect()
}

/// Replaces a selection across chapters as one step: `first` gives the
/// edits of the first chapter's part (its document and range) and the
/// caret's offset there; the other parts are deleted.
fn replace_group(
    editor: &mut ProseEditor,
    first: impl FnOnce(&ProseDoc, std::ops::Range<usize>) -> (Vec<crate::convert::OwnedEdit>, usize),
    window: &mut Window,
    cx: &mut gpui::Context<ProseEditor>,
) -> Result<bool, dr_workspace::WsError> {
    use crate::convert::OwnedEdit;
    let sel = editor.selection();
    let start = sel.start();
    let mut chapters = Vec::new();
    let mut edits = Vec::new();
    let mut first = Some(first);
    let mut offset = start.offset;
    for chapter in start.chapter..=sel.end().chapter {
        let (range, _) = editor.selected_in(chapter).expect("selected chapter");
        chapters.push(chapter);
        match first.take().filter(|_| chapter == start.chapter) {
            Some(first) => {
                let (part, caret) = first(&editor.book().chapters[chapter].doc, range);
                offset = caret;
                edits.push(part);
            }
            None => edits.push(vec![OwnedEdit::from(Edit::Delete { range })]),
        }
    }
    let caret = gpui_prose::layout::BookPos {
        chapter: start.chapter,
        offset,
    };
    editor.edit_group(&chapters, caret, window, cx, move |docs| {
        crate::SessionSource::edit_group(docs, edits)
    })
}

/// The first part of a rich paste across chapters: the text and its marks.
fn rich_part(
    text: &str,
    marks: &[CellMark],
) -> impl FnOnce(&ProseDoc, std::ops::Range<usize>) -> (Vec<crate::convert::OwnedEdit>, usize) {
    move |doc, range| {
        use crate::convert::OwnedEdit;
        let clears = caret_clears(doc, range.start);
        let mut part = vec![OwnedEdit::from(Edit::Replace {
            range: range.clone(),
            text,
            overrides: &clears,
        })];
        for (a, b, key, value) in marks {
            part.push(OwnedEdit::from(Edit::Mark {
                range: range.start + a..range.start + b,
                key,
                value: value.clone(),
            }));
        }
        (part, range.start + text.chars().count())
    }
}

/// The first part of a cut across chapters: deleted, the caret at its start.
fn cut_part(
    _: &ProseDoc,
    range: std::ops::Range<usize>,
) -> (Vec<crate::convert::OwnedEdit>, usize) {
    let at = range.start;
    (
        vec![crate::convert::OwnedEdit::from(Edit::Delete { range })],
        at,
    )
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
        Ok((item, html)) => {
            cx.write_to_clipboard(item);
            if let Some(write) = cx.try_global::<ClipboardHtmlWriter>().map(|w| w.0.clone()) {
                write(&html);
            }
            if cut {
                editor.update(cx, |e, cx| {
                    let sel = e.selection();
                    if sel.spans_chapters() {
                        if !matches!(replace_group(e, cut_part, window, cx), Ok(true)) {
                            crate::links::clipboard_refused(
                                cx,
                                "stale or failed cross-document cut",
                            );
                        }
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
        let blocks = match value.get("blocks") {
            Some(b) => decode_blocks(b)?,
            None => Vec::new(),
        };
        Ok::<_, String>((text, marks, blocks))
    })();
    let (text, marks, blocks) = match parsed {
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
    if text.contains('\u{fffc}') {
        crate::links::clipboard_refused(cx, "unsupported embed placeholder in text paste");
        return true;
    }
    let has_blocks =
        blocks.iter().any(|b| !b.is_empty()) && !e.options().fit_content && takes_formatting(e);
    if sel.spans_chapters() {
        editor.update(cx, move |e, cx| {
            let ok = if has_blocks {
                let fragment = build_fragment(&text, &marks, &blocks);
                let part = |doc: &ProseDoc, range: std::ops::Range<usize>| {
                    let clears = caret_clears(doc, range.start);
                    let plan = gpui_prose::text::PastePlan::new(doc, range, &fragment);
                    let edits = plan
                        .edits(&clears)
                        .into_iter()
                        .map(crate::convert::OwnedEdit::from)
                        .collect();
                    (edits, plan.caret())
                };
                matches!(replace_group(e, part, window, cx), Ok(true))
            } else {
                matches!(
                    replace_group(e, rich_part(&text, &marks), window, cx),
                    Ok(true)
                )
            };
            if !ok {
                crate::links::clipboard_refused(cx, "stale or failed cross-document paste");
            }
        });
        return true;
    }
    let range = sel.range();
    let at = range.start;
    editor.update(cx, move |e, cx| {
        let saved = std::cell::Cell::new(false);
        let completed = &saved;
        e.edit_chapter(sel.chapter, HostStep::Own, window, cx, move |doc| {
            let clears = caret_clears(doc, at);
            if has_blocks {
                let fragment = build_fragment(&text, &marks, &blocks);
                let plan = gpui_prose::text::PastePlan::new(doc, range.clone(), &fragment);
                guard(doc);
                let out = doc.edit_batch(&plan.edits(&clears), ORIGIN_USER);
                completed.set(out.undo_items > 0 || out.caret > 0);
                return completed.get().then_some(plan.caret());
            }
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

gpui::actions!(dr_editor, [PasteAsPlainText]);

/// ⇧⌘V (Ctrl+Shift+V off macOS; the shell's key registry binds it in the
/// editor's key context, with no menu item): only the clipboard's plain
/// text, as the 0.1 client's ProseMirror pasted it with Shift held. No
/// formats from another program ([`paste_html`]), none from Drifting's own
/// copy ([`paste`]), no table from a copied table or a tab-separated grid,
/// no image or file: the text goes through gpui-prose's plain paste, as ⌘V
/// with only text on the clipboard does (line breaks make paragraphs, one
/// undo step, automatic links as for typed text). Nothing happens when the
/// clipboard holds no text. Returns whether `editor` has the keyboard.
pub(crate) fn paste_plain_text(
    editor: &Entity<ProseEditor>,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    if !editor.read(cx).focus_handle(cx).is_focused(window) {
        return false;
    }
    if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
        editor.update(cx, |e, cx| e.paste_text(&text, window, cx));
    }
    true
}

/// How the editor reads the HTML on the system clipboard: the app's is
/// `dr_platform::clipboard::read_html`. Unset (tests, examples), ⌘V never
/// looks for formatting from other programs.
#[derive(Clone)]
pub struct ClipboardHtml(pub std::rc::Rc<dyn Fn() -> Option<String>>);

impl gpui::Global for ClipboardHtml {}

/// Sets where ⌘V in a body reads other programs' formatting from.
pub fn set_clipboard_html(cx: &mut App, read: impl Fn() -> Option<String> + 'static) {
    cx.set_global(ClipboardHtml(std::rc::Rc::new(read)));
}

/// How the editor writes HTML to the system clipboard on ⌘C/⌘X alongside
/// GPUI's plain text and JSON metadata (`dr_platform::clipboard::write_html`).
#[derive(Clone)]
pub struct ClipboardHtmlWriter(pub std::rc::Rc<dyn Fn(&str)>);

impl gpui::Global for ClipboardHtmlWriter {}

/// Sets where ⌘C/⌘X in a body writes semantic HTML for external programs.
pub fn set_clipboard_html_writer(cx: &mut App, write: impl Fn(&str) + 'static) {
    cx.set_global(ClipboardHtmlWriter(std::rc::Rc::new(write)));
}

/// Whether a paste over the selection may bring paragraph formats: not
/// into a code line (the old editor pasted plain text there), and never
/// over a selection holding an embed (the plain paste steps around it).
fn takes_formatting(editor: &ProseEditor) -> bool {
    let sel = editor.selection();
    let start = sel.start();
    for chapter in start.chapter..=sel.end().chapter {
        let doc = &editor.book().chapters[chapter].doc;
        let range = if sel.spans_chapters() {
            match editor.selected_in(chapter) {
                Some((range, _)) => range,
                None => continue,
            }
        } else {
            sel.range()
        };
        let (first, _) = doc.locate(range.start);
        let (last, _) = doc.locate(range.end);
        if chapter == start.chapter
            && doc
                .line(first)
                .block
                .get(gpui_prose::schema::block::CODE_BLOCK)
                .is_some()
        {
            return false;
        }
        let last = last.min(doc.visible_lines().saturating_sub(1));
        if (first..=last).any(|line| doc.line(line).embed().is_some()) {
            return false;
        }
    }
    true
}

/// ⌘V in a body with formatted text from another program on the clipboard
/// (Word, Pages, a browser …): what this body's format has stays — the
/// paragraphs' kinds, alignment, bold, italic, links … — and the rest is
/// text (`gpui_prose::html`). One paste is one undo step; automatic links
/// follow as for typed text. Returns false to leave the paste to the plain
/// text path: no reader set, nothing formatted on the clipboard, too large
/// or nothing in it, a code line, an embed, a composition.
pub(crate) fn paste_html(editor: &Entity<ProseEditor>, window: &mut Window, cx: &mut App) -> bool {
    let e = editor.read(cx);
    if !e.focus_handle(cx).is_focused(window) || e.composition().is_some() {
        return false;
    }
    let Some(read) = cx.try_global::<ClipboardHtml>().map(|r| r.0.clone()) else {
        return false;
    };
    if !takes_formatting(e) {
        return false;
    }
    let Some(fragment) = read().and_then(|html| gpui_prose::html::parse(&html)) else {
        return false;
    };
    let sel = e.selection();
    if sel.spans_chapters() {
        editor.update(cx, |e, cx| {
            let part = |doc: &ProseDoc, range: std::ops::Range<usize>| {
                let clears = caret_clears(doc, range.start);
                let plan = gpui_prose::text::PastePlan::new(doc, range, &fragment);
                let edits = plan
                    .edits(&clears)
                    .into_iter()
                    .map(crate::convert::OwnedEdit::from)
                    .collect();
                (edits, plan.caret())
            };
            if !matches!(replace_group(e, part, window, cx), Ok(true)) {
                crate::links::clipboard_refused(cx, "stale or failed cross-document paste");
            }
        });
        return true;
    }
    editor.update(cx, |e, cx| {
        let saved = std::cell::Cell::new(false);
        e.edit_chapter(sel.chapter, HostStep::Own, window, cx, |doc| {
            let range = sel.range();
            let clears = caret_clears(doc, range.start);
            let plan = gpui_prose::text::PastePlan::new(doc, range, &fragment);
            guard(doc);
            let out = doc.edit_batch(&plan.edits(&clears), ORIGIN_USER);
            saved.set(out.undo_items > 0 || out.caret > 0);
            saved.get().then_some(plan.caret())
        });
        if !saved.get() {
            crate::links::clipboard_refused(cx, "stale or failed formatted paste");
        }
    });
    true
}

/// The marks of a table pasted from another program as tab-separated text
/// (`cells`, read by [`crate::table::clip::parse_grid`]): its cells' bold,
/// links … from the HTML beside it, when that HTML is exactly this table,
/// row by row and cell by cell (`gpui_prose::html` reads a table as one
/// paragraph per row, cells separated by tabs). Otherwise `None`: the cells
/// stay plain, as before.
pub(crate) fn html_table_marks(cx: &App, cells: &[Vec<String>]) -> Option<GridMarks> {
    let read = cx.try_global::<ClipboardHtml>()?.0.clone();
    let fragment = gpui_prose::html::parse(&read()?)?;
    if fragment.paragraphs.len() != cells.len() {
        return None;
    }
    let mut grid = GridMarks::new();
    for (paragraph, row) in fragment.paragraphs.iter().zip(cells) {
        if !paragraph.attrs.is_empty()
            || paragraph
                .text
                .split('\t')
                .ne(row.iter().map(String::as_str))
        {
            return None;
        }
        // Each cell's start, in characters of the row.
        let mut starts = Vec::with_capacity(row.len());
        let mut at = 0;
        for cell in row {
            starts.push(at);
            at += cell.chars().count() + 1;
        }
        let mut marks = vec![Vec::new(); row.len()];
        for (range, key, value) in &paragraph.marks {
            for (ix, cell) in row.iter().enumerate() {
                let (from, to) = (starts[ix], starts[ix] + cell.chars().count());
                let (a, b) = (range.start.max(from), range.end.min(to));
                if a < b {
                    marks[ix].push((a - from, b - from, key.clone(), value.clone()));
                }
            }
        }
        for (cell, m) in row.iter().zip(&marks) {
            validate(cell, m).ok()?;
        }
        grid.push(marks);
    }
    grid.iter().flatten().any(|m| !m.is_empty()).then_some(grid)
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
    let plain = editor.clone();
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
        .capture_action(move |_: &PasteAsPlainText, w, cx| {
            if paste_plain_text(&plain, w, cx) {
                cx.stop_propagation();
            }
        })
        .child(element)
}

#[cfg(test)]
mod tests;
