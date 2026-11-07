//! Terminology (rule 7).
//!
//! - Drift is 构想 in Chinese and Ideas in English: the two retired Chinese
//!   labels appear nowhere in `next/`, the English "inspiration" in no
//!   product string.
//! - H1, H2 and H3 are called H1, H2 and H3 only (AGENTS.md "UI rules"):
//!   no product string, Agent prompt or export template calls a heading
//!   level a scene or a beat, in English or Chinese.
//!
//! "Product strings" are the string literals of Rust code outside tests,
//! fixtures and benchmarks, plus locale, prompt and template files. Comments
//! and docs are free to explain the rule.

use regex::Regex;

use super::{Outcome, is_test_path};
use crate::repo::{Repo, rust_literals};

const SELF: &str = "next/xtask/src/gates/terms.rs";

/// Retired Chinese labels for a Drift, anywhere.
fn retired_labels() -> Vec<String> {
    vec![["灵", "感"].concat(), ["浮", "缀"].concat()]
}

/// (rule, pattern) for product strings.
pub fn string_rules() -> Vec<(&'static str, Regex)> {
    vec![
        (
            "a Drift is an idea (Ideas / 构想), not an inspiration",
            Regex::new(&format!(r"(?i)\b{}s?\b", ["inspir", "ation"].concat())).expect("regex"),
        ),
        (
            "H1/H2/H3 are only H1/H2/H3, never scenes or beats",
            Regex::new(&format!(
                r"(?i)\b{}s?\b|\b{}s?\b|{}|{}",
                ["sce", "ne"].concat(),
                ["be", "at"].concat(),
                ["场", "景"].concat(),
                ["节", "拍"].concat()
            ))
            .expect("regex"),
        ),
    ]
}

/// Locale, prompt and template files: their whole text is product copy.
fn is_copy_file(path: &str) -> bool {
    let in_dir = |d: &str| path.split('/').any(|seg| seg == d);
    (in_dir("locales") || in_dir("prompts") || in_dir("templates"))
        && [".json", ".ftl", ".md", ".txt", ".toml", ".hbs", ".tera"]
            .iter()
            .any(|e| path.ends_with(e))
}

pub fn check_strings(path: &str, text: &str, o: &mut Outcome) -> usize {
    let rules = string_rules();
    let strings: Vec<(usize, String)> = if path.ends_with(".rs") {
        rust_literals(text)
            .into_iter()
            .map(|l| (l.line, l.text))
            .collect()
    } else if is_copy_file(path) {
        text.lines()
            .enumerate()
            .map(|(i, l)| (i + 1, l.to_string()))
            .collect()
    } else {
        return 0;
    };
    for (line, s) in &strings {
        for (rule, re) in &rules {
            if let Some(m) = re.find(s) {
                o.fail(format!("{path}:{line}: {rule} ({:?})", m.as_str()));
            }
        }
    }
    strings.len()
}

pub fn run(repo: &Repo) -> Result<Outcome, String> {
    let mut o = Outcome::default();
    let files = repo.files(&["next"])?;
    let labels = retired_labels();
    let mut strings = 0;
    for f in &files {
        if f.path == SELF {
            continue;
        }
        let Some(text) = repo.text(&f.path) else {
            continue;
        };
        for l in &labels {
            if let Some(at) = text.find(l.as_str()) {
                let line = text[..at].matches('\n').count() + 1;
                o.fail(format!("{}:{line}: a Drift is 构想 in Chinese", f.path));
            }
        }
        if !is_test_path(&f.path) {
            strings += check_strings(&f.path, &text, &mut o);
        }
    }
    o.summary = format!("{} files, {strings} product strings", files.len());
    Ok(o)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fails(path: &str, text: &str) -> usize {
        let mut o = Outcome::default();
        check_strings(path, text, &mut o);
        o.failures.len()
    }

    #[test]
    fn heading_levels_are_never_scenes_or_beats() {
        let scene = ["Sce", "ne"].concat();
        let beat = ["be", "ats"].concat();
        let zh = ["场", "景"].concat();
        assert_eq!(fails("a.rs", &format!("let s = \"New {scene}\";")), 1);
        assert_eq!(fails("a.rs", &format!("let s = \"H2 {beat}\";")), 1);
        assert_eq!(fails("a.rs", &format!("let s = r#\"{zh}\"#;")), 1);
        assert_eq!(
            fails(
                "crates/x/locales/en.json",
                &format!("{{\"h1\": \"{scene}\"}}")
            ),
            1
        );
        // Comments, other words and other files are fine.
        assert_eq!(
            fails("a.rs", &format!("// {scene}\nlet h = \"heartbeat\";")),
            0
        );
        assert_eq!(fails("a.rs", "let s = gpui::Scene::new();"), 0);
        assert_eq!(fails("notes.md", &scene), 0);
    }

    #[test]
    fn drifts_are_ideas() {
        let word = ["Inspir", "ations"].concat();
        assert_eq!(fails("a.rs", &format!("t(\"{word}\")")), 1);
        assert_eq!(fails("a.rs", "t(\"Ideas\")"), 0);
    }
}
