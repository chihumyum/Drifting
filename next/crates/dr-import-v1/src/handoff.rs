//! The handoff stamp the last 0.1 releases write into `library_state`
//! (`docs/v2-handoff.md`, `src/renderer/services/v2-handoff/`):
//!
//! ```json
//! { "version": 1, "appVersion": "0.1.0-alpha.11", "updatedAt": "…",
//!   "documents": { "<docId>": { "revision": 12, "sha256": "<hex>" } },
//!   "settings": { "capturedAt": "…", "entries": { "<key>": "<raw value>" } },
//!   "books": { "<projectId>": { "wordTarget": 80000, "dailyWordTarget": 0,
//!     "relationTypeColors": { "<id>": "#aabbcc" },
//!     "elementPins": { "<elementId>": [12.5, -40] } } } }
//! ```
//!
//! `books` came later (M10); an older stamp falls back to reading the same
//! values out of the raw `settings.entries`, the way the 0.1 renderer does.

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::Result;

/// `library_state` key of the stamp.
pub const KEY: &str = "v2-handoff";

/// One stamped document: the Yjs revision its cache was verified at, and
/// the lower-case hex SHA-256 of that cache's UTF-8 bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Entry {
    pub revision: i64,
    pub sha256: String,
}

/// Per-book data that lived only in WebView storage.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookSettings {
    /// Set when the author made a plan; 0 turns it off.
    pub word_target: Option<i64>,
    pub daily_word_target: Option<i64>,
    pub relation_type_colors: BTreeMap<String, String>,
    pub element_pins: BTreeMap<String, (f64, f64)>,
}

impl BookSettings {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// The stamp, as read.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    pub app_version: Option<String>,
    pub updated_at: Option<String>,
    pub documents: BTreeMap<String, Entry>,
    /// Raw WebView storage values, by key.
    pub settings: BTreeMap<String, String>,
    pub settings_captured_at: Option<String>,
    /// Whether the stamp had a `books` section (else [`Self::books`] comes
    /// from the raw settings).
    pub books_section: bool,
    pub books: BTreeMap<String, BookSettings>,
}

pub fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64().filter(|f| f.is_finite())
}

fn int(v: &Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| num(v).filter(|f| f.fract() == 0.0).map(|f| f as i64))
}

fn pins(v: &Value) -> BTreeMap<String, (f64, f64)> {
    let mut out = BTreeMap::new();
    if let Some(o) = v.as_object() {
        for (id, p) in o {
            if let Some([x, y]) = p.as_array().map(Vec::as_slice)
                && let (Some(x), Some(y)) = (num(x), num(y))
            {
                out.insert(id.clone(), (x, y));
            }
        }
    }
    out
}

fn colors(v: &Value) -> BTreeMap<String, String> {
    v.as_object()
        .map(|o| {
            o.iter()
                .filter_map(|(k, c)| Some((k.clone(), c.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// The `books` section (the M10 addition).
fn books_section(v: &Value) -> BTreeMap<String, BookSettings> {
    let mut out = BTreeMap::new();
    let Some(o) = v.as_object() else {
        return out;
    };
    for (book, b) in o {
        let s = BookSettings {
            word_target: b.get("wordTarget").and_then(int).map(|n| n.max(0)),
            daily_word_target: b.get("dailyWordTarget").and_then(int).map(|n| n.max(0)),
            relation_type_colors: b.get("relationTypeColors").map(colors).unwrap_or_default(),
            element_pins: b.get("elementPins").map(pins).unwrap_or_default(),
        };
        if !s.is_empty() {
            out.insert(book.clone(), s);
        }
    }
    out
}

/// The same values out of raw WebView storage, the way the 0.1 renderer
/// reads them (`writing-stats-store.ts`, `useEdgeKindMeta.ts`,
/// `element-relate-layout.ts`).
pub fn books_from_settings(settings: &BTreeMap<String, String>) -> BTreeMap<String, BookSettings> {
    let mut out: BTreeMap<String, BookSettings> = BTreeMap::new();
    if let Some(raw) = settings.get("writing-stats-storage")
        && let Ok(v) = serde_json::from_str::<Value>(raw)
        && let Some(plans) = v.pointer("/state/plans").and_then(Value::as_object)
    {
        for (book, plan) in plans {
            let e = out.entry(book.clone()).or_default();
            e.word_target = plan
                .get("projectWordTarget")
                .and_then(int)
                .map(|n| n.max(0));
            e.daily_word_target = plan.get("dailyWordGoal").and_then(int).map(|n| n.max(0));
        }
    }
    for (key, raw) in settings {
        if let Some(book) = key.strip_prefix("drifting:edge-kind-meta:")
            && let Ok(v) = serde_json::from_str::<Value>(raw)
            && v.get("v").and_then(Value::as_i64) == Some(2)
            && let Some(by) = v.get("byRelationTypeId").and_then(Value::as_object)
        {
            let e = out.entry(book.to_string()).or_default();
            for (id, meta) in by {
                if let Some(c) = meta.get("color").and_then(Value::as_str) {
                    e.relation_type_colors.insert(id.clone(), c.to_string());
                }
            }
        }
        if let Some(book) = key.strip_prefix("super-element-view:relate:")
            && let Ok(v) = serde_json::from_str::<Value>(raw)
            && let Some(p) = v.get("pins")
        {
            out.entry(book.to_string()).or_default().element_pins = pins(p);
        }
    }
    out.retain(|_, b| !b.is_empty());
    out
}

/// Read the stamp of a staged library. `None` when the library never ran a
/// build with the handoff (or the stamp is of another version).
pub fn read(conn: &Connection) -> Result<Option<Stamp>> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value_json FROM library_state WHERE key = ?1",
            [KEY],
            |r| r.get(0),
        )
        .optional()?;
    let Some(value) = value else { return Ok(None) };
    let Ok(v) = serde_json::from_str::<Value>(&value) else {
        return Ok(None);
    };
    if v.get("version").and_then(Value::as_i64) != Some(1) {
        return Ok(None);
    }
    let documents = v
        .get("documents")
        .and_then(Value::as_object)
        .map(|o| {
            o.iter()
                .filter_map(|(k, e)| {
                    Some((
                        k.clone(),
                        Entry {
                            revision: e.get("revision")?.as_i64()?,
                            sha256: e.get("sha256")?.as_str()?.to_string(),
                        },
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let settings: BTreeMap<String, String> = v
        .pointer("/settings/entries")
        .and_then(Value::as_object)
        .map(|o| {
            o.iter()
                .filter_map(|(k, s)| Some((k.clone(), s.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let books_section = v.get("books").is_some_and(Value::is_object);
    let books = if books_section {
        books_section_or_empty(&v)
    } else {
        books_from_settings(&settings)
    };
    Ok(Some(Stamp {
        app_version: v
            .get("appVersion")
            .and_then(Value::as_str)
            .map(str::to_string),
        updated_at: v
            .get("updatedAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        documents,
        settings_captured_at: v
            .pointer("/settings/capturedAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        settings,
        books_section,
        books,
    }))
}

fn books_section_or_empty(v: &Value) -> BTreeMap<String, BookSettings> {
    v.get("books").map(books_section).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_lower_case_hex_of_utf8() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    fn library_state(value: &str) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE library_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)")
            .unwrap();
        conn.execute(
            "INSERT INTO library_state VALUES (?1, ?2, '2026-11-07T00:00:00Z')",
            [KEY, value],
        )
        .unwrap();
        conn
    }

    #[test]
    fn the_books_section_wins_over_raw_settings() {
        let conn = library_state(
            r##"{"version":1,"documents":{"element:e":{"revision":3,"sha256":"aa"},"bad":{"revision":"x"}},
               "settings":{"capturedAt":"t","entries":{"writing-stats-storage":"{\"state\":{\"plans\":{\"b1\":{\"projectWordTarget\":5,\"dailyWordGoal\":6}}}}"}},
               "books":{"b1":{"wordTarget":80000,"dailyWordTarget":0,"relationTypeColors":{"rt":"#123456"},"elementPins":{"e1":[1.5,-2],"bad":[1]}}}}"##,
        );
        let s = read(&conn).unwrap().unwrap();
        assert_eq!(s.documents.len(), 1);
        assert_eq!(s.documents["element:e"].revision, 3);
        assert!(s.books_section);
        let b = &s.books["b1"];
        assert_eq!((b.word_target, b.daily_word_target), (Some(80000), Some(0)));
        assert_eq!(b.relation_type_colors["rt"], "#123456");
        assert_eq!(b.element_pins.len(), 1);
    }

    #[test]
    fn an_older_stamp_reads_the_raw_settings() {
        let conn = library_state(
            r##"{"version":1,"documents":{},"settings":{"capturedAt":"t","entries":{
                "writing-stats-storage":"{\"state\":{\"plans\":{\"b1\":{\"projectWordTarget\":90000,\"dailyWordGoal\":0}},\"history\":{}},\"version\":3}",
                "drifting:edge-kind-meta:b1":"{\"v\":2,\"byRelationTypeId\":{\"rt\":{\"color\":\"#abcdef\"},\"rt2\":{}}}",
                "drifting:edge-kind-meta:b2":"{\"v\":1,\"byRelationTypeId\":{\"rt\":{\"color\":\"#000\"}}}",
                "super-element-view:relate:b1":"{\"v\":1,\"mode\":\"relate\",\"positions\":{\"x\":[0,0]},\"pins\":{\"e1\":[10.5,20]},\"signature\":null}"}}}"##,
        );
        let s = read(&conn).unwrap().unwrap();
        assert!(!s.books_section);
        assert_eq!(
            s.books.len(),
            1,
            "a version-1 colour payload is ignored, as in 0.1"
        );
        let b = &s.books["b1"];
        assert_eq!((b.word_target, b.daily_word_target), (Some(90000), Some(0)));
        assert_eq!(b.relation_type_colors.len(), 1);
        assert_eq!(b.element_pins["e1"], (10.5, 20.0));
    }

    #[test]
    fn no_stamp_or_another_version() {
        let conn = library_state(r#"{"version":2}"#);
        assert!(read(&conn).unwrap().is_none());
        let conn = library_state("not json");
        assert!(read(&conn).unwrap().is_none());
    }
}
