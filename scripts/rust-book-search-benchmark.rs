//! Experiment only: adapt the existing native search kernel to Tauri's book-find results.
use drifting_document::native_search_ranges;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::time::Instant;

#[derive(Serialize)]
#[serde(untagged)]
enum ExcerptText {
    Text(String),
    Units { utf16: Vec<u16> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Excerpt {
    text: ExcerptText,
    match_start: usize,
    match_end: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BookMatch<'a> {
    node_id: &'a str,
    chapter_index: u64,
    kind: &'static str,
    block_id: Option<String>,
    occurrence: usize,
    excerpt: Excerpt,
}

#[derive(Serialize)]
struct Reply<'a, T> {
    id: &'a Value,
    value: T,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchReply<'a> {
    matches: Vec<BookMatch<'a>>,
    rust_elapsed_ms: f64,
}

fn text_of(node: &Value) -> String {
    if let Some(text) = node["text"].as_str() {
        return text.into();
    }
    node["content"]
        .as_array()
        .map(|children| children.iter().map(text_of).collect())
        .unwrap_or_default()
}

fn blocks_of(node: &Value, blocks: &mut Vec<(String, String)>) {
    if let Some(id) = node
        .pointer("/attrs/id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        blocks.push((id.into(), text_of(node)));
    } else if let Some(children) = node["content"].as_array() {
        for child in children {
            blocks_of(child, blocks);
        }
    }
}

fn excerpt(text: &[u16], at: usize, len: usize) -> Excerpt {
    let start = at.saturating_sub(10);
    let end = (at + len + 60).min(text.len());
    let mut units = Vec::new();
    if start > 0 {
        units.push(0x2026);
    }
    units.extend(
        text[start..end]
            .iter()
            .map(|unit| if *unit == 10 { 32 } else { *unit }),
    );
    if end < text.len() {
        units.push(0x2026);
    }
    let match_start = usize::from(start > 0) + at - start;
    // JS slice can retain a lone surrogate. Preserve it on the wire rather than
    // silently replacing it with U+FFFD at an excerpt boundary.
    let output = match String::from_utf16(&units) {
        Ok(value) => ExcerptText::Text(value),
        Err(_) => ExcerptText::Units { utf16: units },
    };
    Excerpt {
        text: output,
        match_start,
        match_end: match_start + len,
    }
}

fn occurrences<'a>(
    doc: &'a Value,
    kind: &'static str,
    id: Option<&str>,
    text: &str,
    query: &str,
    out: &mut Vec<BookMatch<'a>>,
) {
    let ranges = native_search_ranges(text, query, usize::MAX);
    if ranges.is_empty() {
        return;
    }
    let units: Vec<_> = text.encode_utf16().collect();
    for (occurrence, range) in ranges.iter().enumerate() {
        out.push(BookMatch {
            node_id: doc["nodeId"].as_str().unwrap_or(""),
            chapter_index: doc["index"].as_u64().unwrap_or(0),
            kind,
            block_id: id.map(str::to_owned),
            occurrence,
            excerpt: excerpt(&units, range.location as usize, range.length as usize),
        });
    }
}

fn search<'a>(docs: &'a [Value], query: &str) -> Vec<BookMatch<'a>> {
    if query.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for doc in docs {
        occurrences(
            doc,
            "title",
            None,
            doc["title"].as_str().unwrap_or(""),
            query,
            &mut out,
        );
        occurrences(
            doc,
            "summary",
            None,
            doc["summary"].as_str().unwrap_or(""),
            query,
            &mut out,
        );
        let parsed = doc["contentJson"]
            .as_str()
            .and_then(|text| serde_json::from_str::<Value>(text).ok());
        if let Some(body) = parsed {
            let mut blocks = Vec::new();
            blocks_of(&body, &mut blocks);
            for (id, text) in blocks {
                occurrences(doc, "body", Some(&id), &text, query, &mut out);
            }
        }
    }
    out
}

fn main() -> Result<(), String> {
    let mut docs = Vec::new();
    let mut stdout = io::stdout().lock();
    for line in io::stdin().lock().lines() {
        let message: Value =
            serde_json::from_str(&line.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let args = &message["args"];
        match message["command"].as_str().unwrap_or("") {
            "load" => {
                docs = args["docs"].as_array().ok_or("Missing documents")?.clone();
                serde_json::to_writer(
                    &mut stdout,
                    &Reply {
                        id: &message["id"],
                        value: json!({"loaded": docs.len()}),
                    },
                )
                .map_err(|e| e.to_string())?;
            }
            "search" | "search_once" => {
                let input = if message["command"] == "search_once" {
                    args["docs"].as_array().ok_or("Missing documents")?
                } else {
                    &docs
                };
                let start = Instant::now();
                let matches = search(input, args["query"].as_str().ok_or("Missing query")?);
                let reply = SearchReply {
                    matches,
                    rust_elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
                };
                serde_json::to_writer(
                    &mut stdout,
                    &Reply {
                        id: &message["id"],
                        value: reply,
                    },
                )
                .map_err(|e| e.to_string())?;
            }
            _ => return Err("Unknown command".into()),
        };
        stdout.write_all(b"\n").map_err(|e| e.to_string())?;
        stdout.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}
