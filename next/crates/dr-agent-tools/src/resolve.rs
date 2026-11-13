//! Canonical identity projection and read-before-write coverage.
use crate::{Error, Result};
use dr_model::id::BookId;
use dr_workspace::{Workspace, registry};
use serde_json::Value;
use std::collections::BTreeSet;
#[path = "resolve_v3.rs"]
mod v3;
pub(crate) use v3::{action_input_schema_v3, facade_schema_v3, prose_doc_from_module_args};
#[derive(Clone, Debug)]
pub struct ResolvedCall {
    pub name: String,
    pub arguments: Value,
    /// Stable document identities for the read-before-write guard. Metadata
    /// shares the book document; prose keeps its own document identity.
    pub targets: Vec<String>,
    /// Author objects whose contents the caller must have actually read.
    /// A shared book frontier is a CAS token, not permission to edit every
    /// entity stored in that document.
    pub subjects: Vec<String>,
}
pub fn resolve(ws: &Workspace, book: &BookId, name: &str, args: Value) -> Result<ResolvedCall> {
    resolve_with_catalog(ws, book, None, name, args)
}

pub(crate) fn resolve_with_catalog(
    ws: &Workspace,
    book: &BookId,
    catalog: Option<&crate::catalog::Catalog>,
    name: &str,
    args: Value,
) -> Result<ResolvedCall> {
    if !crate::catalog::is_v3_book(ws, book)? {
        return Err(Error::Invalid(
            "only books in the current format support tools".into(),
        ));
    }
    v3::resolve_v3(ws, book, catalog, name, args)
}
pub fn coverage(name: &str, args: &Value, output: &Value) -> Vec<String> {
    if let Some(read) = v3::coverage_v3(name, args, output) {
        return read;
    }
    let output = output.get("output").unwrap_or(output);
    let Some((domain, verb)) = name.split_once('.') else {
        return Vec::new();
    };
    let mut read = BTreeSet::new();
    if domain == "prose" && verb == "read" {
        if let Some(doc) = args["doc"].as_str() {
            read.insert(format!("prose:{doc}"));
        }
    } else if verb == "list" {
        if let Some(rows) = output.as_array() {
            for row in rows {
                if let Some(id) = row["id"].as_str() {
                    read.insert(format!("{domain}:{id}"));
                }
            }
            let unfiltered = args.as_object().is_some_and(|args| {
                args.iter().all(|(key, value)| {
                    matches!(key.as_str(), "book" | "trashed" | "removed") || value.is_null()
                })
            });
            if unfiltered {
                read.insert(format!("{domain}:*"));
                if args["trashed"] == true
                    && registry().get(name).is_some_and(|spec| {
                        spec.input_schema().as_value()["properties"]
                            .get("trashed")
                            .is_some()
                    })
                {
                    read.insert(format!("{domain}:all"));
                }
            }
        }
    } else if verb == "get"
        && let Some(id) = output["id"].as_str()
    {
        read.insert(format!("{domain}:{id}"));
    }
    read.into_iter().collect()
}
pub(crate) fn subjects_common(name: &str, args: &Value) -> Vec<String> {
    let Some((domain, verb)) = name.split_once('.') else {
        return Vec::new();
    };
    let mut out = BTreeSet::new();
    if domain == "prose" {
        if let Some(doc) = args["doc"].as_str() {
            out.insert(format!("prose:{doc}"));
        }
    } else if domain == "book" {
        if let Some(book) = args["book"].as_str() {
            out.insert(format!("book:{book}"));
        }
    } else if matches!(verb, "create" | "add") || (verb == "put" && args["id"].is_null()) {
        out.insert(format!("{domain}:*"));
    } else if let Some(id) = args["id"].as_str() {
        out.insert(format!("{domain}:{id}"));
    }
    if name == "material.delete" {
        out.extend(["relation:all".into(), "comment:*".into()]);
    }
    if name == "material_folder.delete" {
        out.extend(["material_folder:*".into(), "material:*".into()]);
    }
    out.into_iter().collect()
}
