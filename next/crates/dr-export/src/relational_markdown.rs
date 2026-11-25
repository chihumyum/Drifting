//! Export every live project in the library as a relational Markdown ZIP
//! archive with YAML frontmatter and `[[path|title]]` Wiki links (0.1
//! `services/export/relational-markdown.service.ts`, ported to Format 5).

use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::SystemTime;

use dr_doc::prose::{BorrowedProse, ProseView, Run as ProseRun};
use dr_doc::v3::{BookStructureV3, BorrowedBookV3};
use dr_model::DocId;
use dr_model::id::{BodyDocId, BookId};
use dr_model::kind::{EntityKind, ListKind};
use dr_model::prose::{LINE_BREAK, OBJECT_CHAR};
use dr_model::v3::{Entry, EntryTemplate, FieldType, FieldValue, ModuleKind};
use dr_store::OpenDoc;
use dr_workspace::Workspace;
use serde_json::json;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::{ExportError, Result, timestamp};

/// Summary of an exported relational Markdown archive.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelationalMarkdownSummary {
    pub books: usize,
    pub documents: usize,
    pub bytes: u64,
}

/// Suggested archive filename: `drifting-markdown-YYYY-MM-DD.zip`.
pub fn relational_markdown_filename(now: SystemTime) -> String {
    let ts = timestamp(now);
    let date = ts.split('T').next().unwrap_or("export");
    format!("drifting-markdown-{date}.zip")
}

fn safe_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut last_space = false;
    for c in value.chars() {
        let mapped = match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | ']' | '[' => '-',
            c if c.is_whitespace() => ' ',
            c => c,
        };
        if mapped == ' ' {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(mapped);
            last_space = false;
        }
    }
    let trimmed = out.trim().trim_end_matches(['.', ' ']).replace("..", "-");
    let chosen = if trimmed.is_empty() {
        "Untitled".to_owned()
    } else {
        trimmed
    };
    chosen.chars().take(80).collect()
}

fn yaml_str(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

fn field_value_text(
    field_type: &FieldType,
    value: &FieldValue,
    paths: &HashMap<String, (String, String)>,
) -> String {
    match (field_type, value) {
        (_, FieldValue::Null) => String::new(),
        (FieldType::EntityRef, FieldValue::Text(id)) => wiki_link_or(id, paths),
        (FieldType::EntityRef, FieldValue::List(ids)) => ids
            .iter()
            .map(|id| wiki_link_or(id, paths))
            .collect::<Vec<_>>()
            .join(", "),
        (_, FieldValue::Text(s)) => s.clone(),
        (_, FieldValue::Number(n)) => {
            if n.is_finite() && n.fract() == 0.0 && n.abs() < (i64::MAX as f64) {
                format!("{}", *n as i64)
            } else {
                format!("{n}")
            }
        }
        (_, FieldValue::Bool(b)) => if *b { "true" } else { "false" }.to_owned(),
        (_, FieldValue::List(list)) => list.join(", "),
    }
}

struct ExportDoc {
    title: String,
    path: String,
    frontmatter: Vec<(String, String)>,
    body: String,
}

/// Built archive entries ready to write into a ZIP file.
pub struct BuiltArchive {
    pub entries: Vec<(String, String)>,
    pub books: usize,
    pub documents: usize,
}

/// Builds all UTF-8 archive entries `(relative_path, content)` for every live
/// project in `ws`.
pub fn build_entries(ws: &Workspace, now: SystemTime) -> Result<BuiltArchive> {
    let docs = ws
        .library()
        .docs(None, Some("book"))
        .map_err(|e| ExportError::Invalid(e.to_string()))?;

    let mut books: Vec<(String, String)> = Vec::new();
    for info in docs {
        let Some(book_id) = info
            .book_id
            .clone()
            .or_else(|| info.doc_id.strip_prefix("book:").map(str::to_owned))
        else {
            continue;
        };
        let Ok(parsed_book_id) = BookId::parse(&book_id) else {
            continue;
        };
        let Ok(handle) = ws.library().open_doc(&info.doc_id, OpenDoc::Existing) else {
            continue;
        };
        let meta = handle
            .read(move |raw| {
                if !dr_doc::v3::is_book_doc(raw) {
                    return None;
                }
                let borrowed = BorrowedBookV3::new(raw, &parsed_book_id).ok()?;
                let view = borrowed.view();
                let meta = view.meta();
                if meta.deleted_at.is_some() {
                    return None;
                }
                Some(meta.name)
            })
            .ok()
            .flatten();
        if let Some(title) = meta {
            books.push((title, book_id));
        }
    }
    books.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

    let mut all_entries: Vec<(String, String)> = Vec::new();
    let mut total_docs = 0usize;

    for (book_title, book_id) in &books {
        let Ok(parsed_book_id) = BookId::parse(book_id) else {
            continue;
        };
        let doc_id = format!("book:{book_id}");
        let Ok(handle) = ws.library().open_doc(&doc_id, OpenDoc::Existing) else {
            continue;
        };
        let prefix = format!(
            "books/{}-{}",
            safe_segment(book_title),
            safe_segment(book_id)
        );

        let Ok(Some(snapshot)) = handle.read(move |raw| {
            let borrowed = BorrowedBookV3::new(raw, &parsed_book_id).ok()?;
            let view = borrowed.view();
            let meta = view.meta();
            let templates: BTreeMap<_, _> = view
                .templates()
                .into_iter()
                .map(|t| (t.id.clone(), t))
                .collect();
            let structure = view.structure_snapshot();
            let entries: Vec<Entry> = view
                .entries()
                .into_iter()
                .filter(|e| !e.is_trashed())
                .collect();
            let relations = view.relations();
            let relation_types: HashMap<String, String> = view
                .relation_types()
                .into_iter()
                .map(|rt| (rt.id.to_string(), rt.name))
                .collect();
            let facts = view.facts();
            let comments = view.comments();
            Some((
                meta,
                templates,
                structure,
                entries,
                relations,
                relation_types,
                facts,
                comments,
            ))
        }) else {
            continue;
        };
        let (meta, templates, structure, entries, relations, relation_types, facts, comments) =
            snapshot;

        // Pre-compute archive paths for Wiki links.
        let mut path_by_entry: HashMap<String, (String, String)> = HashMap::new();
        for entry in &entries {
            let title = if entry.title.trim().is_empty() {
                "Untitled".to_owned()
            } else {
                entry.title.clone()
            };
            let path = format!(
                "{prefix}/entries/{}-{}.md",
                safe_segment(&title),
                safe_segment(entry.id.as_str())
            );
            path_by_entry.insert(entry.id.to_string(), (path, title));
        }
        let path_by_entry = Arc::new(path_by_entry);

        // Build adjacency list of relations per entry id.
        let mut rel_map: HashMap<String, Vec<(String, String)>> = HashMap::new();
        for rel in &relations {
            let label = relation_types
                .get(rel.relation_type.as_str())
                .cloned()
                .unwrap_or_else(|| "related".to_owned());
            for l in &rel.left {
                for r in &rel.right {
                    if l == r {
                        continue;
                    }
                    rel_map
                        .entry(l.to_string())
                        .or_default()
                        .push((r.to_string(), label.clone()));
                    rel_map
                        .entry(r.to_string())
                        .or_default()
                        .push((l.to_string(), label.clone()));
                }
            }
        }

        // Project overview README.md
        let mut readme_body = String::new();
        if !meta.summary.trim().is_empty() {
            readme_body.push_str(&crate::markdown::summary(&meta.summary));
            readme_body.push_str("\n\n");
        }
        if !facts.is_empty() {
            readme_body.push_str("## Facts\n\n");
            for f in &facts {
                readme_body.push_str(&format!("- **{}**: {}\n", f.key, f.value));
            }
            readme_body.push('\n');
        }
        let roots = structure.children_of(None);
        if !roots.is_empty() {
            readme_body.push_str("## Outline\n\n");
            append_tree_links(&structure, None, 0, &path_by_entry, &mut readme_body);
        }
        let project_doc = ExportDoc {
            title: if meta.name.trim().is_empty() {
                "Untitled".to_owned()
            } else {
                meta.name.clone()
            },
            path: format!("{prefix}/README.md"),
            frontmatter: vec![
                ("drifting_kind".into(), yaml_str("project")),
                ("drifting_id".into(), yaml_str(book_id)),
                ("title".into(), yaml_str(&meta.name)),
            ],
            body: readme_body,
        };
        all_entries.push((
            project_doc.path.clone(),
            render_export_doc(&project_doc, &[]),
        ));
        total_docs += 1;

        // Every live entry document
        for entry in &entries {
            let Some((path, title)) = path_by_entry.get(entry.id.as_str()).cloned() else {
                continue;
            };
            let tpl: Option<&EntryTemplate> =
                entry.template.as_ref().and_then(|tid| templates.get(tid));
            let mut fm = vec![
                ("drifting_kind".into(), yaml_str("entry")),
                ("drifting_id".into(), yaml_str(entry.id.as_str())),
                ("title".into(), yaml_str(&title)),
            ];
            if let Some(t) = tpl {
                fm.push(("template".into(), yaml_str(&t.name)));
            }
            if let Some(parent) = &entry.parent {
                fm.push(("parent_id".into(), yaml_str(parent.as_str())));
            }

            let mut sections: Vec<String> = Vec::new();
            let modules = tpl.map(|t| t.modules.as_slice()).unwrap_or(&[]);
            for module in modules {
                match module.kind {
                    ModuleKind::Prose => {
                        let doc_id =
                            DocId::Body(BodyDocId::new(entry.id.clone(), module.id.clone()));
                        let prose_doc_str = doc_id.to_string();
                        let paths = Arc::clone(&path_by_entry);
                        if let Ok(prose_handle) =
                            ws.library().open_doc(&prose_doc_str, OpenDoc::Existing)
                            && let Ok(Some(md)) = prose_handle.read(move |raw| {
                                let borrowed = BorrowedProse::new(raw, &doc_id).ok()?;
                                let view = borrowed.view();
                                Some(prose_with_wikilinks(&view, 1, &paths))
                            })
                            && !md.trim().is_empty()
                        {
                            if !module.name.trim().is_empty() && modules.len() > 1 {
                                sections.push(format!("## {}\n\n{md}", module.name));
                            } else {
                                sections.push(md);
                            }
                        }
                    }
                    ModuleKind::Fields => {
                        let mut lines = Vec::new();
                        if let Some(values) = entry.fields.get(&module.id) {
                            for def in &module.config.defs {
                                if let Some(val) = values.get(&def.id) {
                                    let rendered =
                                        field_value_text(&def.field_type, val, &path_by_entry);
                                    if !rendered.trim().is_empty() {
                                        lines.push(format!("- **{}**: {rendered}", def.name));
                                    }
                                }
                            }
                        }
                        if !lines.is_empty() {
                            let heading = if module.name.trim().is_empty() {
                                "Fields"
                            } else {
                                module.name.as_str()
                            };
                            sections.push(format!("## {heading}\n\n{}", lines.join("\n")));
                        }
                    }
                    ModuleKind::KeyValue => {
                        if let Some(kvs) = entry.kv.get(&module.id)
                            && !kvs.is_empty()
                        {
                            let lines: Vec<String> = kvs
                                .iter()
                                .map(|kv| format!("- **{}**: {}", kv.key, kv.value))
                                .collect();
                            let heading = if module.name.trim().is_empty() {
                                "Key-Value"
                            } else {
                                module.name.as_str()
                            };
                            sections.push(format!("## {heading}\n\n{}", lines.join("\n")));
                        }
                    }
                    _ => {}
                }
            }

            // Comments targeting this entry
            let entry_comments: Vec<String> = comments
                .iter()
                .filter(|c| {
                    c.target
                        .as_ref()
                        .is_some_and(|t| t.kind == EntityKind::Entry && t.id == entry.id.as_str())
                })
                .filter_map(|c| {
                    let body = c.body.text.trim();
                    (!body.is_empty()).then(|| format!("- [{:?}] {body}", c.status))
                })
                .collect();
            if !entry_comments.is_empty() {
                sections.push(format!("## Comments\n\n{}", entry_comments.join("\n")));
            }

            let mut backlinks: Vec<String> = Vec::new();
            if let Some(parent_id) = &entry.parent
                && let Some((p_path, p_title)) = path_by_entry.get(parent_id.as_str())
            {
                backlinks.push(format!(
                    "- parent: [[{}|{p_title}]]",
                    p_path.trim_end_matches(".md")
                ));
            }
            if let Some(rels) = rel_map.get(entry.id.as_str()) {
                for (target_id, label) in rels {
                    if let Some((t_path, t_title)) = path_by_entry.get(target_id) {
                        let line = format!(
                            "- {label}: [[{}|{t_title}]]",
                            t_path.trim_end_matches(".md")
                        );
                        if !backlinks.contains(&line) {
                            backlinks.push(line);
                        }
                    }
                }
            }

            let doc = ExportDoc {
                title,
                path: path.clone(),
                frontmatter: fm,
                body: sections.join("\n\n"),
            };
            all_entries.push((path, render_export_doc(&doc, &backlinks)));
            total_docs += 1;
        }
    }

    let manifest = serde_json::to_string_pretty(&json!({
        "format": "drifting.relational-markdown",
        "formatVersion": 2,
        "exportedAt": timestamp(now),
        "bookCount": books.len(),
        "documentCount": total_docs,
    }))
    .unwrap_or_else(|_| "{}".to_owned());
    all_entries.push(("manifest.json".to_owned(), format!("{manifest}\n")));

    Ok(BuiltArchive {
        entries: all_entries,
        books: books.len(),
        documents: total_docs,
    })
}

/// Writes the relational Markdown ZIP archive of all live projects to `dest`.
pub fn export_all_to_zip(
    ws: &Workspace,
    dest: &Path,
    now: SystemTime,
) -> Result<RelationalMarkdownSummary> {
    let BuiltArchive {
        entries,
        books,
        documents,
    } = build_entries(ws, now)?;
    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (path, content) in entries {
            zip.start_file(path, opts)
                .map_err(|e| ExportError::Invalid(e.to_string()))?;
            zip.write_all(content.as_bytes())
                .map_err(|e| ExportError::Invalid(e.to_string()))?;
        }
        zip.finish()
            .map_err(|e| ExportError::Invalid(e.to_string()))?;
    }
    let bytes = cursor.into_inner();
    let len = bytes.len() as u64;
    crate::write_file(dest, &bytes).map_err(|e| ExportError::Invalid(e.to_string()))?;
    Ok(RelationalMarkdownSummary {
        books,
        documents,
        bytes: len,
    })
}

fn append_tree_links(
    structure: &BookStructureV3,
    parent: Option<&dr_model::id::EntryId>,
    depth: usize,
    paths: &HashMap<String, (String, String)>,
    out: &mut String,
) {
    let indent = "  ".repeat(depth);
    for child in structure.children_of(parent) {
        if let Some((path, title)) = paths.get(child.id.as_str()) {
            out.push_str(&format!(
                "{indent}- [[{}|{title}]]\n",
                path.trim_end_matches(".md")
            ));
        }
        if child.is_level() {
            append_tree_links(structure, Some(&child.id), depth + 1, paths, out);
        }
    }
}

fn wiki_link_or(id: &str, paths: &HashMap<String, (String, String)>) -> String {
    match paths.get(id) {
        Some((path, title)) => format!("[[{}|{title}]]", path.trim_end_matches(".md")),
        None => id.to_owned(),
    }
}

fn render_export_doc(doc: &ExportDoc, backlinks: &[String]) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    for (k, v) in &doc.frontmatter {
        out.push_str(&format!("{k}: {v}\n"));
    }
    out.push_str("---\n\n");
    out.push_str(&format!("# {}\n\n", doc.title));
    if !doc.body.trim().is_empty() {
        out.push_str(doc.body.trim());
        out.push('\n');
    }
    if !backlinks.is_empty() {
        out.push_str("\n## Relations\n\n");
        for b in backlinks {
            out.push_str(b);
            out.push('\n');
        }
    }
    out
}

/// Renders prose to Markdown while preserving entity links as `[[path|label]]` Wiki links.
fn prose_with_wikilinks(
    view: &ProseView<'_>,
    offset: usize,
    paths: &HashMap<String, (String, String)>,
) -> String {
    let mut blocks = Vec::new();
    for p in view.paragraphs() {
        if p.attrs.rule {
            blocks.push("---".to_owned());
            continue;
        }
        let text = render_runs(&p.runs, paths);
        if let Some(level) = p.attrs.heading {
            let hashes = "#".repeat((level as usize + offset).clamp(1, 6));
            blocks.push(format!("{hashes} {text}"));
        } else if p.attrs.quote {
            blocks.push(format!("> {text}"));
        } else if let Some(list_kind) = &p.attrs.list {
            let indent = "  ".repeat((p.attrs.list_level as usize).min(8));
            let marker = match list_kind {
                ListKind::Ordered => "1. ",
                ListKind::Task if p.attrs.checked => "- [x] ",
                ListKind::Task => "- [ ] ",
                ListKind::Bullet | ListKind::Other(_) => "- ",
            };
            blocks.push(format!("{indent}{marker}{text}"));
        } else {
            blocks.push(text);
        }
    }
    blocks.join("\n\n")
}

fn render_runs(runs: &[ProseRun], paths: &HashMap<String, (String, String)>) -> String {
    let mut out = String::new();
    for run in runs {
        let mut seg: String = run
            .text
            .chars()
            .filter(|&c| c != OBJECT_CHAR)
            .map(|c| if c == LINE_BREAK { '\n' } else { c })
            .collect();
        if seg.is_empty() {
            continue;
        }
        if let Some(entity) = run
            .marks
            .entities
            .iter()
            .find(|e| e.kind == EntityKind::Entry)
            && let Some((path, _)) = paths.get(&entity.target)
        {
            seg = format!("[[{}|{seg}]]", path.trim_end_matches(".md"));
        }
        if run.marks.code {
            seg = format!("`{seg}`");
        }
        if run.marks.bold {
            seg = format!("**{seg}**");
        }
        if run.marks.italic {
            seg = format!("*{seg}*");
        }
        if run.marks.strike {
            seg = format!("~~{seg}~~");
        }
        if run.marks.underline {
            seg = format!("<u>{seg}</u>");
        }
        if let Some(href) = &run.marks.link {
            seg = format!("[{seg}]({href})");
        }
        out.push_str(&seg);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_segment_cleans_forbidden_chars() {
        assert_eq!(safe_segment("A/B:C*D?E[F]"), "A-B-C-D-E-F-");
        assert_eq!(safe_segment("   "), "Untitled");
    }

    #[test]
    fn filename_has_date_and_zip_extension() {
        let name = relational_markdown_filename(SystemTime::UNIX_EPOCH);
        assert_eq!(name, "drifting-markdown-1970-01-01.zip");
    }
}
