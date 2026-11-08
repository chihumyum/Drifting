//! `workspace inspect`: what a library holds, the 0.1 client's
//! `db:inspect`. The library is opened read-only (F2's `open_read_only`: no
//! lock, no migration, no writes), so it works while the app has it open and
//! copies nothing. A library this build would first migrate cannot be opened
//! that way; it is read from a consistent copy instead, migrated there, and
//! the library itself is left as it is. `opened` says which.

use std::collections::BTreeMap;
use std::path::Path;

use dr_doc::book::BookDoc;
use dr_model::id::BookId;
use dr_model::kind::NodeKind;
use loro::ToJson;
use serde_json::{Value, json};

use crate::offline::{self, APP_VERSION};

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// A summary of the library, or one document's value with `doc`.
pub fn inspect(library: &Path, doc: Option<&str>) -> Result<Value, String> {
    if !offline::db_path(library).exists() {
        return Err(format!(
            "{} is not a library (no library.sqlite)",
            library.display()
        ));
    }
    let options = || dr_workspace::library_options(APP_VERSION);
    match dr_store::Library::open_read_only(library, options()) {
        Ok(lib) => read(lib, doc, "read-only"),
        Err(dr_store::StoreError::NeedsMigration { .. }) => offline::on_copy(library, |copy| {
            let lib = dr_store::Library::open(copy, options()).map_err(err)?;
            read(lib, doc, "copy")
        }),
        Err(e) => Err(err(e)),
    }
}

/// Reads what was asked for and closes `lib`.
fn read(lib: dr_store::Library, doc: Option<&str>, opened: &str) -> Result<Value, String> {
    let out = match doc {
        Some(id) => lib.load_copy(id).map_err(err).and_then(|d| {
            let value: Value = serde_json::from_str(&d.get_deep_value().to_json()).map_err(err)?;
            Ok(json!({ "doc": id, "value": value }))
        }),
        None => summary(&lib),
    };
    lib.close().map_err(err)?;
    let mut out = out?;
    out["opened"] = json!(opened);
    Ok(out)
}

fn summary(lib: &dr_store::Library) -> Result<Value, String> {
    let docs = lib.docs(None, None).map_err(err)?;
    let mut kinds: BTreeMap<String, usize> = BTreeMap::new();
    for d in &docs {
        *kinds.entry(d.kind.clone()).or_default() += 1;
    }
    let mut books = Vec::new();
    for d in docs.iter().filter(|d| d.kind == "book") {
        let Some(id) = d.doc_id.strip_prefix("book:") else {
            continue;
        };
        let book_id = BookId::parse(id).map_err(err)?;
        let copy = lib.load_copy(&d.doc_id).map_err(err)?;
        let snapshot = copy.export(loro::ExportMode::Snapshot).map_err(err)?;
        let book = BookDoc::load(book_id, 1, &[snapshot]).map_err(err)?;
        let v = book.view();
        let nodes = v.nodes();
        let mut chapter_chars = 0usize;
        for n in nodes.iter().filter(|n| n.kind == NodeKind::Chapter) {
            if let Ok(p) = lib.load_copy(&format!("node:{}", n.id)) {
                chapter_chars += p
                    .get_text(dr_doc::schema::prose::BODY)
                    .to_string()
                    .chars()
                    .filter(|c| *c != '\n')
                    .count();
            }
        }
        books.push(json!({
            "id": id,
            "name": v.meta().name,
            "chapters": v.chapters().len(),
            "ideas": v.drifts().len(),
            "elements": v.elements().len(),
            "relations": v.relations().len(),
            "comments": v.comments().len(),
            "materials": v.materials().len(),
            "writingDays": v.writing_days().len(),
            "chapterChars": chapter_chars,
            "documents": docs.iter().filter(|x| x.book_id.as_deref() == Some(id)).count(),
        }));
    }
    Ok(json!({
        "libraryId": lib.library_id(),
        "documents": kinds,
        "books": books,
        "sqliteBytes": lib.size_bytes().map_err(err)?,
    }))
}

/// The summary as lines for a person.
pub fn human(v: &Value) -> String {
    if v.get("doc").is_some() {
        return serde_json::to_string_pretty(v).unwrap_or_default();
    }
    let mut s = format!(
        "library {}  ({} bytes, read from {})\ndocuments: {}\n",
        v["libraryId"].as_str().unwrap_or("?"),
        v["sqliteBytes"],
        match v["opened"].as_str() {
            Some("copy") => "a migrated copy",
            _ => "the library itself, read-only",
        },
        v["documents"]
    );
    for b in v["books"].as_array().into_iter().flatten() {
        s.push_str(&format!(
            "book {}  {}\n  {} chapters ({} characters), {} ideas, {} elements, {} relations, {} comments, {} materials, {} writing days\n",
            b["id"].as_str().unwrap_or("?"),
            b["name"].as_str().unwrap_or(""),
            b["chapters"],
            b["chapterChars"],
            b["ideas"],
            b["elements"],
            b["relations"],
            b["comments"],
            b["materials"],
            b["writingDays"],
        ));
    }
    s
}
