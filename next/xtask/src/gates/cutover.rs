//! The source replay adapter cannot become an alternative App runtime.
use super::{Outcome, is_test_path};
use crate::repo::Repo;
use regex::Regex;

fn source_adapter(path: &str) -> bool {
    [
        "next/crates/dr-doc/src/import_v1/",
        "next/crates/dr-import-v1/",
        "next/crates/dr-samples/src/",
        "next/crates/dr-testkit/",
    ]
    .iter()
    .any(|prefix| path.starts_with(prefix))
}
/// Inside `dr-model` the source-format types live in `import_v1`. Only that
/// module and `id.rs` (whose `DocId` names the source documents the
/// canonical readers refuse) may use them; the canonical records may not.
fn canonical_model(path: &str) -> bool {
    path.starts_with("next/crates/dr-model/src/")
        && !path.starts_with("next/crates/dr-model/src/import_v1")
        && path != "next/crates/dr-model/src/id.rs"
}
/// The places that may name the built-in novel template (`kernel-v4.md`
/// §9, §11): the template itself, the 0.1 import, the sample books, the
/// testkit and `project.create`. Tests (here and as `is_test_path`) and
/// examples, which only drive synthetic seeds in development, may too.
fn may_name_novel_template(path: &str) -> bool {
    [
        "next/crates/dr-doc/src/v3/novel.rs",
        "next/crates/dr-workspace/src/commands/v3/novel_book.rs",
    ]
    .contains(&path)
        || [
            "next/crates/dr-import-v1/",
            "next/crates/dr-samples/",
            "next/crates/dr-testkit/",
        ]
        .iter()
        .any(|prefix| path.starts_with(prefix))
        || path.split('/').any(|seg| seg == "examples")
}
/// Naming the novel template from product code: a `"tpl-` id, or the novel
/// module (`novel::…`) and the names `dr_doc::v3` re-exports from it.
fn novel_template() -> Regex {
    Regex::new(r#""tpl-|\bnovel::|\bv3::novel\b|\b(?:NOVEL_PROJECT_TEMPLATE_(?:ID|VERSION)|NovelRootEntries|TPL_ACT_TRACK|act_track_template|apply_novel_project_template(?:_with)?|find_novel_roots|novel_project_templates)\b"#)
        .expect("novel template pattern")
}
/// The files a product file declares as test-only modules:
/// `#[cfg(test)]`, maybe a `#[path = "…"]`, then `mod name;`. They are
/// compiled only with the tests, like a `#[cfg(test)] mod tests { … }`.
fn test_modules(path: &str, text: &str) -> Vec<String> {
    let dir = path.rsplit_once('/').map_or("", |(d, _)| d);
    let file = path.rsplit_once('/').map_or(path, |(_, f)| f);
    let own_dir = if ["mod.rs", "lib.rs", "main.rs"].contains(&file) {
        dir.to_owned()
    } else {
        format!("{dir}/{}", file.trim_end_matches(".rs"))
    };
    let decl = Regex::new(r"^(?:pub(?:\([a-z]+\))?\s+)?mod\s+([a-z0-9_]+)\s*;").unwrap();
    let path_attr = Regex::new(r#"^#\[path\s*=\s*"([^"]+)"\]"#).unwrap();
    let mut out = Vec::new();
    let mut lines = text.lines().map(str::trim).peekable();
    while let Some(line) = lines.next() {
        if line != "#[cfg(test)]" {
            continue;
        }
        let mut at = None;
        while let Some(next) = lines.peek().copied() {
            if let Some(c) = path_attr.captures(next) {
                at = Some(format!("{dir}/{}", &c[1]));
                lines.next();
            } else if next.starts_with("#[") {
                lines.next();
            } else {
                break;
            }
        }
        if let Some(c) = lines.peek().and_then(|l| decl.captures(l)) {
            out.extend(at.map(|p| vec![p]).unwrap_or_else(|| {
                vec![
                    format!("{own_dir}/{}.rs", &c[1]),
                    format!("{own_dir}/{}/mod.rs", &c[1]),
                ]
            }));
        }
    }
    out
}
fn old_command() -> Regex {
    Regex::new(r#"\"(?:book\.create|history\.(?:agent_changes|undo_agent)|level\.(?:get|list)|(?:act|chapter|idea|idea_group|element|category|storyline|category_template|chapter_template|storyline_template|plot_grid|time_pin)\.[a-z_]+)\""#).expect("cutover pattern")
}
pub fn run(repo: &Repo) -> Result<Outcome, String> {
    let mut out = Outcome::default();
    let commands = old_command();
    let imports = Regex::new(r"dr_(?:doc|model)::(?:\{[^}]*\b)?import_v1\b").unwrap();
    let model_uses = Regex::new(r"\bcrate::import_v1\b").unwrap();
    let novel = novel_template();
    let mut checked = 0;
    let rust: Vec<_> = repo
        .files(&["next/crates", "next/app"])?
        .into_iter()
        .filter(|f| f.path.ends_with(".rs"))
        .collect();
    let test_only: std::collections::BTreeSet<String> = rust
        .iter()
        .filter_map(|f| Some(test_modules(&f.path, &repo.text(&f.path)?)))
        .flatten()
        .collect();
    for f in repo.files(&["next/crates", "next/app"])? {
        if !f.path.ends_with(".rs") || is_test_path(&f.path) || source_adapter(&f.path) {
            continue;
        }
        let Some(text) = repo.text(&f.path) else {
            continue;
        };
        // Unit contracts can name refused source values; product code before
        // them cannot import the adapter or call a retired fixed-domain API.
        let product = text.split("#[cfg(test)]").next().unwrap_or(&text);
        for (label, re) in [
            ("retired command", &commands),
            ("source adapter import", &imports),
        ] {
            if let Some(hit) = re.find(product) {
                out.fail(format!(
                    "{}:{}: {label}: {}",
                    f.path,
                    product[..hit.start()].matches('\n').count() + 1,
                    hit.as_str()
                ));
            }
        }
        if !may_name_novel_template(&f.path) && !test_only.contains(&f.path) {
            let mut reexport = false;
            for (n, line) in product.lines().enumerate() {
                let code = line.trim_start();
                // `dr_doc::v3` re-exporting its own novel module.
                if code.starts_with("pub use novel::") {
                    reexport = !code.ends_with(';');
                    continue;
                }
                if reexport {
                    reexport = !code.ends_with(';');
                    continue;
                }
                if code.starts_with("//") {
                    continue;
                }
                // A name inside a string (a description) is not a use; a
                // `"tpl-` literal is.
                let hit = novel.find_iter(line).find(|m| {
                    m.as_str().starts_with('"') || line[..m.start()].matches('"').count() % 2 == 0
                });
                if let Some(hit) = hit {
                    out.fail(format!(
                        "{}:{}: product code names the built-in novel template: {}",
                        f.path,
                        n + 1,
                        hit.as_str()
                    ));
                }
            }
        }
        if canonical_model(&f.path) {
            for (n, line) in product.lines().enumerate() {
                if !line.trim_start().starts_with("//") && model_uses.is_match(line) {
                    out.fail(format!(
                        "{}:{}: canonical model uses a source-format type: {}",
                        f.path,
                        n + 1,
                        line.trim()
                    ));
                }
            }
        }
        checked += 1;
    }
    for file in [
        "next/crates/dr-model/src/book.rs",
        "next/crates/dr-model/src/legacy.rs",
        "next/crates/dr-doc/src/book/mod.rs",
        "next/crates/dr-workspace/src/cache.rs",
        "next/crates/dr-workspace/src/commands/chapter.rs",
        "next/crates/dr-workspace/src/commands/idea.rs",
        "next/crates/dr-workspace/src/commands/element.rs",
        "next/crates/dr-view-ideas/Cargo.toml",
    ] {
        if repo.path(file).is_file() {
            out.fail(format!("retired product path returned: {file}"));
        }
    }
    for f in repo.files(&["next/crates", "next/app"])? {
        if !f.path.ends_with(".json") || !f.path.contains("/scenarios/") {
            continue;
        }
        let Some(text) = repo.text(&f.path) else {
            continue;
        };
        if let Some(hit) = commands.find(&text) {
            out.fail(format!(
                "{}: scenario calls retired command {}",
                f.path,
                hit.as_str()
            ));
        }
    }
    out.summary = format!(
        "{checked} product Rust files; source replay imports, built-in template ids, retired commands, paths and scenarios checked"
    );
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_retired_product_names_are_blocked() {
        for name in [
            "book.create",
            "history.undo_agent",
            "history.agent_changes",
            "chapter.create",
            "element.list",
            "act.update",
            "plot_grid.get",
            "level.get",
            "level.list",
        ] {
            assert!(old_command().is_match(&format!("\"{name}\"")));
        }
        for name in [
            "project.create",
            "entry.create",
            "entry_template.list",
            "module.put_grid",
            "memory.add",
            "fact.put",
            "relation.create",
            "entry.set_level",
        ] {
            assert!(!old_command().is_match(&format!("\"{name}\"")));
        }
        assert!(source_adapter("next/crates/dr-import-v1/src/run.rs"));
        assert!(!source_adapter("next/crates/dr-shell/src/book.rs"));
        assert!(canonical_model("next/crates/dr-model/src/v3.rs"));
        assert!(canonical_model("next/crates/dr-model/src/kind.rs"));
        assert!(!canonical_model("next/crates/dr-model/src/id.rs"));
        assert!(!canonical_model("next/crates/dr-model/src/import_v1.rs"));
        assert!(!canonical_model(
            "next/crates/dr-model/src/import_v1/ids.rs"
        ));
        assert!(!canonical_model("next/crates/dr-doc/src/catalog/fields.rs"));
    }
    #[test]
    fn test_only_module_files_are_found_from_their_declarations() {
        let text = "fn a() {}\n#[cfg(test)]\n#[path = \"v3_tests.rs\"]\npub(crate) mod tests;\n#[cfg(test)]\nmod guarded;\nmod real;\n";
        assert_eq!(
            test_modules("next/crates/x/src/v3.rs", text),
            [
                "next/crates/x/src/v3_tests.rs",
                "next/crates/x/src/v3/guarded.rs",
                "next/crates/x/src/v3/guarded/mod.rs"
            ]
        );
        assert_eq!(
            test_modules("next/crates/x/src/lib.rs", "#[cfg(test)]\nmod tests;\n"),
            [
                "next/crates/x/src/tests.rs",
                "next/crates/x/src/tests/mod.rs"
            ]
        );
    }
    #[test]
    fn only_the_novel_template_its_importers_and_project_create_name_it() {
        let re = novel_template();
        for hit in [
            r#"let t = "tpl-chapter";"#,
            "use dr_doc::v3::novel;",
            "novel::TPL_CHAPTER",
            "dr_doc::v3::act_track_template()",
            "dr_doc::v3::find_novel_roots(&view)",
            "let roots = dr_doc::v3::NovelRootEntries::new();",
        ] {
            assert!(re.is_match(hit), "{hit}");
        }
        for fine in [
            "let t = template.id.clone();",
            r#"format!("template:{book}")"#,
            "TPL_SOMETHING_ELSE",
            "fn novelty()",
        ] {
            assert!(!re.is_match(fine), "{fine}");
        }
        for path in [
            "next/crates/dr-doc/src/v3/novel.rs",
            "next/crates/dr-workspace/src/commands/v3/novel_book.rs",
            "next/crates/dr-import-v1/src/v3.rs",
            "next/crates/dr-samples/src/v3/catalog.rs",
            "next/crates/dr-testkit/src/seed.rs",
            "next/crates/dr-editor/examples/edit.rs",
            "next/app/drifting/examples/agent-acceptance.rs",
        ] {
            assert!(may_name_novel_template(path), "{path}");
        }
        for path in [
            "next/crates/dr-doc/src/v3/read.rs",
            "next/crates/dr-workspace/src/commands/v3/entry.rs",
            "next/crates/dr-shell/src/book/v3.rs",
            "next/app/drifting/src/main.rs",
        ] {
            assert!(!may_name_novel_template(path), "{path}");
        }
    }
}
