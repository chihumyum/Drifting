//! Paragraphs → the old editor's JSON: the round trip's way back. A body
//! read from Loro, exported and imported again must give the same
//! paragraphs (`plan(parse(export(p))) == p`), which proves the import keeps
//! nothing the exporter cannot say and the exporter drops nothing the
//! document holds. Also the starting point of the "Loro → Manuscript"
//! conversion of M41.

use dr_doc::prose::{EmbedView, Run};
use dr_model::kind::ListKind;
use dr_model::prose::{Align, LINE_BREAK, OBJECT_CHAR};
use serde_json::{Map, Value, json};

use super::plan::Para;

fn marks_of(run: &Run) -> Vec<Value> {
    let m = &run.marks;
    let mut out = Vec::new();
    if m.bold {
        out.push(json!({"type": "bold"}));
    }
    if m.italic {
        out.push(json!({"type": "italic"}));
    }
    if m.underline {
        out.push(json!({"type": "underline"}));
    }
    if m.strike {
        out.push(json!({"type": "strike"}));
    }
    if let Some(href) = &m.link {
        out.push(json!({"type": "link", "attrs": {"href": href}}));
    }
    if let Some(color) = &m.highlight {
        if color.is_empty() {
            out.push(json!({"type": "highlight"}));
        } else {
            out.push(json!({"type": "highlight", "attrs": {"color": color}}));
        }
    }
    if m.code {
        out.push(json!({"type": "code"}));
    }
    for l in &m.entities {
        let mut attrs = Map::new();
        attrs.insert("targetKind".into(), l.kind.as_str().into());
        attrs.insert("targetId".into(), l.target.as_str().into());
        if let Some(b) = &l.block {
            attrs.insert("targetBlockId".into(), b.as_str().into());
        }
        if let Some(b) = &l.end_block {
            attrs.insert("targetEndBlockId".into(), b.as_str().into());
        }
        out.push(json!({"type": "entityLink", "attrs": attrs}));
    }
    out
}

fn inline(runs: &[Run]) -> Vec<Value> {
    let mut out = Vec::new();
    for run in runs {
        let marks = marks_of(run);
        let mut text = String::new();
        let flush = |text: &mut String, out: &mut Vec<Value>| {
            if !text.is_empty() {
                let mut node = json!({"type": "text", "text": std::mem::take(text)});
                if !marks.is_empty() {
                    node["marks"] = Value::Array(marks.clone());
                }
                out.push(node);
            }
        };
        for c in run.text.chars() {
            if c == LINE_BREAK {
                flush(&mut text, &mut out);
                let mut node = json!({"type": "hardBreak"});
                if !marks.is_empty() {
                    node["marks"] = Value::Array(marks.clone());
                }
                out.push(node);
            } else if c != OBJECT_CHAR {
                text.push(c);
            }
        }
        flush(&mut text, &mut out);
    }
    out
}

fn leaf_attrs(p: &Para) -> Map<String, Value> {
    let mut a = Map::new();
    if let Some(id) = &p.id {
        a.insert("id".into(), id.as_str().into());
    }
    if p.attrs.indent > 0 {
        a.insert("indent".into(), (p.attrs.indent as i64).into());
    }
    match p.attrs.align {
        Align::Center => {
            a.insert("textAlign".into(), "center".into());
        }
        Align::Right => {
            a.insert("textAlign".into(), "right".into());
        }
        Align::Left => {}
    }
    a
}

fn text_block(p: &Para) -> Value {
    let mut a = leaf_attrs(p);
    let kind = if let Some(h) = p.attrs.heading {
        a.insert("level".into(), h.level().into());
        "heading"
    } else {
        "paragraph"
    };
    json!({"type": kind, "attrs": a, "content": inline(&p.runs)})
}

fn embed_block(p: &Para, e: &EmbedView) -> Value {
    match e {
        EmbedView::Material { material, .. } => {
            let mut a = Map::new();
            if let Some(id) = &p.id {
                a.insert("id".into(), id.as_str().into());
            }
            if let Some(m) = material {
                a.insert("libraryItemId".into(), m.as_str().into());
            }
            json!({"type": "materialEmbed", "attrs": a})
        }
        EmbedView::Table {
            rows, cols, cells, ..
        } => {
            let mut a = Map::new();
            if let Some(id) = &p.id {
                a.insert("id".into(), id.as_str().into());
            }
            let rows: Vec<Value> = rows
                .iter()
                .map(|r| {
                    let cells: Vec<Value> = cols
                        .iter()
                        .filter_map(|c| cells.get(&(r.id.clone(), c.id.clone())))
                        .map(|text| {
                            let paras: Vec<Value> = text
                                .split(LINE_BREAK)
                                .map(|t| {
                                    let content = if t.is_empty() {
                                        vec![]
                                    } else {
                                        vec![json!({"type": "text", "text": t})]
                                    };
                                    json!({"type": "paragraph", "content": content})
                                })
                                .collect();
                            json!({"type": "tableCell", "content": paras})
                        })
                        .collect();
                    json!({"type": "tableRow", "content": cells})
                })
                .collect();
            json!({"type": "table", "attrs": a, "content": rows})
        }
        EmbedView::Other { .. } => json!({"type": "paragraph", "content": []}),
    }
}

fn list_type(kind: &ListKind) -> &'static str {
    match kind {
        ListKind::Ordered => "orderedList",
        ListKind::Task => "taskList",
        _ => "bulletList",
    }
}

/// A list item (or task item) for one paragraph.
fn item(p: &Para, body: Value) -> Value {
    if p.attrs.list == Some(ListKind::Task) {
        let mut a = Map::new();
        a.insert("checked".into(), p.attrs.checked.into());
        if let Some(t) = &p.attrs.todo {
            a.insert("todoId".into(), t.as_str().into());
        }
        json!({"type": "taskItem", "attrs": a, "content": [body]})
    } else {
        json!({"type": "listItem", "content": [body]})
    }
}

/// Nest list paragraphs by level. `items[i]` is a paragraph with a list.
fn lists(paras: &[&Para], blocks: &[Value]) -> Vec<Value> {
    // A stack of open lists: (level, kind, items).
    let mut stack: Vec<(u32, ListKind, Vec<Value>)> = Vec::new();
    let mut out = Vec::new();
    fn close(stack: &mut Vec<(u32, ListKind, Vec<Value>)>, out: &mut Vec<Value>) {
        let (_, kind, items) = stack.pop().expect("open list");
        let list = json!({"type": list_type(&kind), "content": items});
        match stack.last_mut() {
            Some((_, _, parent)) => match parent.last_mut() {
                Some(last) => last["content"].as_array_mut().expect("item").push(list),
                None => parent.push(list),
            },
            None => out.push(list),
        }
    }
    for (p, block) in paras.iter().zip(blocks) {
        let kind = p.attrs.list.clone().expect("list paragraph");
        let level = p.attrs.list_level;
        while let Some((l, k, _)) = stack.last() {
            if *l > level || (*l == level && *k != kind) {
                close(&mut stack, &mut out);
            } else {
                break;
            }
        }
        // Open lists down to this level (a jump opens the missing ones).
        while stack.last().is_none_or(|(l, _, _)| *l < level) {
            let next = stack.last().map_or(0, |(l, _, _)| l + 1);
            let k = if next == level {
                kind.clone()
            } else {
                ListKind::Bullet
            };
            if next > 0 && stack.last().is_some_and(|(_, _, items)| items.is_empty()) {
                // Nothing to nest under: an empty item holds the sub-list.
                let last = stack.last_mut().expect("open list");
                last.2.push(json!({"type": "listItem", "content": []}));
            }
            stack.push((next, k, Vec::new()));
            if next == level {
                break;
            }
        }
        stack
            .last_mut()
            .expect("open list")
            .2
            .push(item(p, block.clone()));
    }
    while !stack.is_empty() {
        close(&mut stack, &mut out);
    }
    out
}

/// Group code paragraphs, then list paragraphs, then quotes and callouts.
pub fn export(paras: &[Para]) -> Value {
    // 1. Leaf blocks (code lines joined into one code block).
    let mut leaves: Vec<(Vec<&Para>, Value)> = Vec::new();
    let mut i = 0;
    while i < paras.len() {
        let p = &paras[i];
        if let Some(e) = &p.embed {
            leaves.push((vec![p], embed_block(p, e)));
            i += 1;
            continue;
        }
        if p.attrs.rule {
            let mut a = Map::new();
            if let Some(id) = &p.id {
                a.insert("id".into(), id.as_str().into());
            }
            leaves.push((vec![p], json!({"type": "horizontalRule", "attrs": a})));
            i += 1;
            continue;
        }
        if let Some(lang) = &p.attrs.code_block {
            let mut j = i + 1;
            while j < paras.len()
                && paras[j].embed.is_none()
                && paras[j].attrs.code_block.as_ref() == Some(lang)
                && paras[j].id.is_none()
                && paras[j].attrs.list == p.attrs.list
                && paras[j].attrs.quote == p.attrs.quote
            {
                j += 1;
            }
            let mut runs: Vec<Run> = Vec::new();
            for (n, q) in paras[i..j].iter().enumerate() {
                if n > 0 {
                    runs.push(Run {
                        text: "\n".into(),
                        marks: Default::default(),
                    });
                }
                runs.extend(q.runs.iter().cloned());
            }
            let mut a = leaf_attrs(p);
            a.insert("language".into(), lang.as_str().into());
            let content: Vec<Value> =
                inline(&runs)
                    .into_iter()
                    .fold(Vec::<Value>::new(), |mut acc, node| {
                        // Join the line breaks into the neighbouring text.
                        if let (Some(last), Some(t)) = (acc.last_mut(), node["text"].as_str())
                            && last.get("marks").is_none()
                            && node.get("marks").is_none()
                            && last["type"] == "text"
                        {
                            let joined = format!("{}{t}", last["text"].as_str().unwrap_or(""));
                            last["text"] = joined.into();
                            return acc;
                        }
                        acc.push(node);
                        acc
                    });
            leaves.push((
                paras[i..j].iter().collect(),
                json!({"type": "codeBlock", "attrs": a, "content": content}),
            ));
            i = j;
            continue;
        }
        leaves.push((vec![p], text_block(p)));
        i += 1;
    }
    // 2. Lists, then 3. quotes and callouts around runs of blocks.
    let mut grouped: Vec<(&Para, Value)> = Vec::new();
    let mut k = 0;
    while k < leaves.len() {
        let head = leaves[k].0[0];
        if head.attrs.list.is_some() && head.embed.is_none() {
            let mut j = k;
            while j < leaves.len()
                && leaves[j].0[0].attrs.list.is_some()
                && leaves[j].0[0].embed.is_none()
                && leaves[j].0[0].attrs.quote == head.attrs.quote
                && leaves[j].0[0].attrs.callout == head.attrs.callout
            {
                j += 1;
            }
            let ps: Vec<&Para> = leaves[k..j].iter().map(|l| l.0[0]).collect();
            let bs: Vec<Value> = leaves[k..j].iter().map(|l| l.1.clone()).collect();
            for list in lists(&ps, &bs) {
                grouped.push((head, list));
            }
            k = j;
            continue;
        }
        grouped.push((head, leaves[k].1.clone()));
        k += 1;
    }
    let mut out = Vec::new();
    let mut k = 0;
    while k < grouped.len() {
        let head = grouped[k].0;
        let wrap = (head.attrs.quote || head.attrs.callout.is_some()) && head.embed.is_none();
        if !wrap {
            out.push(grouped[k].1.clone());
            k += 1;
            continue;
        }
        let mut j = k;
        while j < grouped.len()
            && grouped[j].0.embed.is_none()
            && grouped[j].0.attrs.quote == head.attrs.quote
            && grouped[j].0.attrs.callout == head.attrs.callout
        {
            j += 1;
        }
        let mut body: Vec<Value> = grouped[k..j].iter().map(|g| g.1.clone()).collect();
        if head.attrs.callout.is_some() {
            body = vec![json!({"type": "callout", "content": body})];
        }
        if head.attrs.quote {
            body = vec![json!({"type": "blockquote", "content": body})];
        }
        out.extend(body);
        k = j;
    }
    json!({"type": "doc", "content": out})
}
