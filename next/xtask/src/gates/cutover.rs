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
fn old_command() -> Regex {
    Regex::new(r#"\"(?:book\.create|history\.(?:agent_changes|undo_agent)|level\.(?:get|list)|(?:act|chapter|idea|idea_group|element|category|storyline|category_template|chapter_template|storyline_template|plot_grid|time_pin)\.[a-z_]+)\""#).expect("cutover pattern")
}
pub fn run(repo: &Repo) -> Result<Outcome, String> {
    let mut out = Outcome::default();
    let commands = old_command();
    let imports = Regex::new(r"dr_(?:doc|model)::(?:\{[^}]*\b)?import_v1\b").unwrap();
    let model_uses = Regex::new(r"\bcrate::import_v1\b").unwrap();
    let mut checked = 0;
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
        "{checked} product Rust files; source replay imports, retired commands, paths and scenarios checked"
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
}
