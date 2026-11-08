//! Where each chapter and idea lives in a book's folder (the 0.1 client's
//! `readable-markdown-projection.ts`, for the files an author may edit):
//!
//! - `正文/<NN 幕名>/<NNN 章名>.md` for a chapter in an act, `正文/<NNN
//!   章名>.md` otherwise; NNN is the chapter's place in reading order;
//! - `构想/<分组>/<子分组>/<标题>.md` for an idea.
//!
//! Names are made safe as file names and Markdown link targets
//! ([`stem`]); two that would collide (ignoring case) get ` (<8 hex>)`, a
//! hash of the entity, so the suffix does not move when others change.

use std::collections::{HashMap, HashSet};

use dr_workspace::commands::chapter::{ActList, ChapterList};
use dr_workspace::commands::idea::{IdeaGroupList, IdeaList, IdeaListIn};
use dr_workspace::commands::{BookIn, ListIn};
use dr_workspace::{Actor, Workspace};

/// Chapters and ideas.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Chapter,
    Idea,
}

/// One file of a book's folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub kind: EntryKind,
    /// The node id.
    pub id: String,
    /// `node:<id>`.
    pub doc: String,
    pub title: String,
    pub status: String,
    pub summary: String,
    /// Inside the book's folder, `/`-separated.
    pub path: String,
}

const CHAPTERS: &str = "正文";
const IDEAS: &str = "构想";
/// Names 0.1 kept for its other files; never an author file's.
const RESERVED: [&str; 11] = [
    "开始阅读.md",
    "正文/目录.md",
    "注释与待办.md",
    "导出说明.md",
    "正文",
    "构想",
    "要素",
    "故事线",
    "素材",
    "素材/附件",
    ".drifting",
];

/// A title as a file or folder name (0.1's `readableFileStem`): NFKC
/// first; `<>:"/\|?*#^%[]`, control and format characters become `-`;
/// runs of dots or dashes shrink to one `-`; white space to one space; no
/// leading or trailing dot or space; at most 120 bytes; Windows' reserved
/// device names get a `_`. `未命名` when nothing is left.
pub fn stem(value: &str) -> String {
    let nfkc = icu_normalizer::ComposingNormalizerBorrowed::new_nfkc().normalize(value);
    let mut s: String = nfkc
        .chars()
        .map(|c| {
            if matches!(
                c,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '#' | '^' | '%' | '[' | ']'
            ) || c.is_control()
                || is_format(c)
            {
                '-'
            } else {
                c
            }
        })
        .collect();
    s = collapse(&s, '.', "-");
    s = collapse(&s, '-', "-");
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = s.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let base = if trimmed.is_empty() {
        "未命名"
    } else {
        trimmed
    };
    let mut out = String::new();
    for c in base.chars() {
        if out.len() + c.len_utf8() > 120 {
            break;
        }
        out.push(c);
    }
    let out = out.trim_end_matches(['.', ' ']).to_owned();
    let out = if out.is_empty() {
        "未命名".to_owned()
    } else {
        out
    };
    let lower = out.to_ascii_lowercase();
    let device = lower.split('.').next().unwrap_or("");
    let reserved = matches!(device, "con" | "prn" | "aux" | "nul")
        || ((device.starts_with("com") || device.starts_with("lpt"))
            && device.len() == 4
            && device.as_bytes()[3].is_ascii_digit()
            && device.as_bytes()[3] != b'0');
    if reserved { format!("_{out}") } else { out }
}

/// Unicode format characters 0.1 replaced (`\p{Cf}`), the common ones.
fn is_format(c: char) -> bool {
    matches!(c, '\u{00AD}' | '\u{0600}'..='\u{0605}' | '\u{061C}' | '\u{06DD}' | '\u{070F}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206F}' | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}')
}

/// Runs of two or more `c` become `with`.
fn collapse(s: &str, c: char, with: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == c {
            let n = chars[i..].iter().take_while(|&&x| x == c).count();
            if n >= 2 {
                out.push_str(with);
            } else {
                out.push(c);
            }
            i += n;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// FNV-1a 64 of `value`, first 8 hex digits (0.1's `shortId`).
pub fn short_id(value: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in value.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")[..8].to_owned()
}

/// Paths claimed so far in one book's folder.
struct Paths {
    used: HashSet<String>,
}

impl Paths {
    fn new() -> Paths {
        Paths {
            used: RESERVED.iter().map(|p| p.to_lowercase()).collect(),
        }
    }

    fn claim(&mut self, parent: &str, title: &str, identity: &str, ext: &str) -> String {
        let stem = stem(title);
        let mut suffix = String::new();
        let mut attempt = 0;
        loop {
            let path = if parent.is_empty() {
                format!("{stem}{suffix}{ext}")
            } else {
                format!("{parent}/{stem}{suffix}{ext}")
            };
            if self.used.insert(path.to_lowercase()) {
                return path;
            }
            attempt += 1;
            suffix = if attempt == 1 {
                format!(" ({})", short_id(identity))
            } else {
                format!(" ({}-{})", short_id(identity), attempt)
            };
        }
    }
}

/// The book's chapters and ideas and where each goes.
pub fn entries(ws: &Workspace, book: &str) -> dr_workspace::Result<Vec<Entry>> {
    let actor = Actor::Mirror;
    let list_in = || ListIn {
        book: book.to_owned(),
        trashed: false,
    };
    let chapters = ws.run::<ChapterList>(&actor, list_in())?.output;
    let acts = ws
        .run::<ActList>(
            &actor,
            BookIn {
                book: book.to_owned(),
            },
        )?
        .output;
    let ideas = ws
        .run::<IdeaList>(
            &actor,
            IdeaListIn {
                book: book.to_owned(),
                group: None,
                trashed: false,
            },
        )?
        .output;
    let groups = ws
        .run::<IdeaGroupList>(
            &actor,
            BookIn {
                book: book.to_owned(),
            },
        )?
        .output;

    let mut paths = Paths::new();
    let mut out = Vec::new();
    // Acts are folders, numbered in book order.
    let live: Vec<_> = chapters.iter().filter(|c| !c.trashed).collect();
    let act_width = acts.len().to_string().len().max(2);
    let mut act_dir: HashMap<&str, String> = HashMap::new();
    for (i, act) in acts.iter().enumerate() {
        if act.chapters.is_empty() {
            continue;
        }
        let dir = paths.claim(
            CHAPTERS,
            &format!("{:0act_width$} {}", i + 1, act.name),
            &format!("act:{}", act.id),
            "",
        );
        for c in &act.chapters {
            act_dir.insert(c.as_str(), dir.clone());
        }
    }
    let width = live.len().to_string().len().max(3);
    for (i, c) in live.iter().enumerate() {
        let parent = act_dir
            .get(c.id.as_str())
            .cloned()
            .unwrap_or_else(|| CHAPTERS.to_owned());
        let path = paths.claim(
            &parent,
            &format!("{:0width$} {}", i + 1, stem(&c.title)),
            &format!("node:{}", c.id),
            ".md",
        );
        out.push(Entry {
            kind: EntryKind::Chapter,
            id: c.id.clone(),
            doc: format!("node:{}", c.id),
            title: c.title.clone(),
            status: c.status.clone(),
            summary: c.summary.clone(),
            path,
        });
    }
    // Idea groups are folders under 构想, nested.
    let by_id: HashMap<&str, &dr_workspace::dto::GroupInfo> =
        groups.iter().map(|g| (g.id.as_str(), g)).collect();
    let mut group_dir: HashMap<String, String> = HashMap::new();
    let mut sorted: Vec<&dr_workspace::dto::GroupInfo> = groups.iter().collect();
    sorted.sort_by(|a, b| a.id.cmp(&b.id));
    for g in sorted {
        group_path(
            g.id.as_str(),
            &by_id,
            &mut group_dir,
            &mut paths,
            &mut Vec::new(),
        );
    }
    let mut ideas: Vec<_> = ideas.into_iter().filter(|i| !i.trashed).collect();
    ideas.sort_by(|a, b| a.id.cmp(&b.id));
    for idea in ideas {
        let parent = idea
            .group
            .as_ref()
            .and_then(|g| group_dir.get(g).cloned())
            .unwrap_or_else(|| IDEAS.to_owned());
        let path = paths.claim(&parent, &idea.title, &format!("node:{}", idea.id), ".md");
        out.push(Entry {
            kind: EntryKind::Idea,
            id: idea.id.clone(),
            doc: format!("node:{}", idea.id),
            title: idea.title,
            status: idea.status,
            summary: idea.summary,
            path,
        });
    }
    Ok(out)
}

fn group_path(
    id: &str,
    by_id: &HashMap<&str, &dr_workspace::dto::GroupInfo>,
    done: &mut HashMap<String, String>,
    paths: &mut Paths,
    visiting: &mut Vec<String>,
) -> String {
    if let Some(p) = done.get(id) {
        return p.clone();
    }
    let Some(g) = by_id.get(id) else {
        return IDEAS.to_owned();
    };
    if visiting.iter().any(|v| v == id) {
        // A cycle (damaged data): stop at the top.
        return IDEAS.to_owned();
    }
    visiting.push(id.to_owned());
    let parent = match &g.parent {
        Some(p) => group_path(p, by_id, done, paths, visiting),
        None => IDEAS.to_owned(),
    };
    visiting.pop();
    let path = paths.claim(&parent, &g.name, &format!("drift-group:{id}"), "");
    done.insert(id.to_owned(), path.clone());
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stems_are_safe_names() {
        assert_eq!(stem("第一章：雨夜/钟楼?"), "第一章-雨夜-钟楼-");
        assert_eq!(stem("  ..a...b  "), "-a-b");
        assert_eq!(stem(""), "未命名");
        assert_eq!(stem("con"), "_con");
        assert_eq!(stem("COM1.txt"), "_COM1.txt");
        assert_eq!(stem("a\u{200B}b"), "a-b");
        assert!(stem(&"字".repeat(100)).len() <= 120);
    }

    #[test]
    fn collisions_get_a_stable_suffix() {
        let mut p = Paths::new();
        assert_eq!(p.claim("构想", "雨", "node:a", ".md"), "构想/雨.md");
        let second = p.claim("构想", "雨", "node:b", ".md");
        assert_eq!(second, format!("构想/雨 ({}).md", short_id("node:b")));
        assert_eq!(
            p.claim("", "要素", "x", ""),
            format!("要素 ({})", short_id("x"))
        );
    }
}
