//! Entity links the editor writes on its own (人物链接): automatic links
//! while the author types, and repairing a link the author's edit broke.
//!
//! The 0.1 client's rules (`entity-link.ts`, `entity-link-name-runs.ts`,
//! `entity-link-repair.ts`), with dr-text's matcher (`dr_text::autolink`):
//!
//! - **Automatic links** (the setting `editor.auto_entity_links`, on by
//!   default): half a second after the author stops typing, the paragraphs
//!   they typed in are matched against every element name and alias and
//!   every chapter and idea title (verbatim, leftmost-longest, a document
//!   never links to itself). A name already linked to its target is left
//!   alone; a name partly linked to it is linked whole (a split link heals);
//!   a shorter name inside it linked to someone else gives way to the
//!   longer one. The links are part of the typing's undo step: one ⌘Z takes
//!   back the typing and its links.
//! - **Repair**: when the author's edit turns a link's text into something
//!   that is no longer a name or alias of its target (deleting 格 from
//!   约格), the link comes off the whole run; another alias of the same
//!   target keeps it. Only the link at the caret is checked, so links on
//!   text that never was a name stay.
//!
//! Changed on purpose: the editor only links what the author typed. The
//! 0.1 client also scanned whole documents when they opened and after an
//! Agent's or a sync's write, as the author, which put links into the
//! author's undo history for text they did not type; linking other writers'
//! text belongs to their commands (F3 / M12, see m03-page.md).

use std::collections::{HashMap, HashSet};
use std::ops::Range;

use dr_doc::book::BookReader;
use dr_model::id::BookId;
use dr_model::kind::EntityKind;
use dr_store::OpenDoc;
use dr_text::autolink::{LinkMatcher, LinkName, LinkTarget, book_link_names};
use dr_workspace::Workspace;
use gpui_prose::text::{Line, ProseDoc};
use loro::LoroValue;

/// Which group of the @ picker a name is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum NameGroup {
    /// Element names and aliases (要素).
    Element,
    /// Chapter titles (章节).
    Chapter,
    /// Idea titles (构想).
    Idea,
    Other,
}

impl NameGroup {
    /// The group's heading in the picker.
    pub fn label(self) -> &'static str {
        match self {
            NameGroup::Element => "要素",
            NameGroup::Chapter => "章节",
            NameGroup::Idea => "构想",
            NameGroup::Other => "其他",
        }
    }
}

/// Compares names as Chinese readers sort them: by pinyin (ICU's zh
/// collation), Latin letters alongside.
pub fn compare_names(a: &str, b: &str) -> std::cmp::Ordering {
    use std::sync::OnceLock;
    static COLLATOR: OnceLock<Option<icu_collator::CollatorBorrowed<'static>>> = OnceLock::new();
    let collator = COLLATOR.get_or_init(|| {
        let zh = icu_locale_core::locale!("zh");
        icu_collator::Collator::try_new((&zh).into(), Default::default()).ok()
    });
    match collator {
        Some(c) => c.compare(a, b).then_with(|| a.cmp(b)),
        None => a.cmp(b),
    }
}

/// Every name a link can point at, compiled.
pub struct NameIndex {
    matcher: LinkMatcher<LinkTarget>,
    /// The names of each target id.
    names: HashMap<String, HashSet<String>>,
    /// The group of each target id that is not an element.
    groups: HashMap<String, NameGroup>,
}

impl NameIndex {
    pub fn new(names: Vec<LinkName<LinkTarget>>) -> NameIndex {
        let mut by_target: HashMap<String, HashSet<String>> = HashMap::new();
        for n in &names {
            by_target
                .entry(n.target.id.clone())
                .or_default()
                .insert(n.name.trim().to_owned());
        }
        NameIndex {
            matcher: LinkMatcher::new(names),
            names: by_target,
            groups: HashMap::new(),
        }
    }

    /// Says which targets are chapters and which are ideas (both are nodes
    /// to the matcher).
    pub fn with_groups(mut self, groups: HashMap<String, NameGroup>) -> NameIndex {
        self.groups = groups;
        self
    }

    /// The picker's group of `target`.
    pub fn group(&self, target: &LinkTarget) -> NameGroup {
        match target.kind {
            EntityKind::Element => NameGroup::Element,
            _ => self
                .groups
                .get(&target.id)
                .copied()
                .unwrap_or(NameGroup::Other),
        }
    }

    /// The names of `book` (elements, their aliases, chapter and idea
    /// titles), leaving out document `exclude` (`node:<id>`, …: a document
    /// never links to itself). Read on the book document's holder thread.
    pub fn load(ws: &Workspace, book: &str, exclude: &[&str]) -> Result<NameIndex, String> {
        let book_id = BookId::parse(book).map_err(|e| e.to_string())?;
        let handle = ws
            .library()
            .open_doc(&format!("book:{book}"), OpenDoc::Existing)
            .map_err(|e| e.to_string())?;
        let exclude: Vec<String> = exclude
            .iter()
            .map(|d| d.split_once(':').map_or(*d, |(_, id)| id).to_owned())
            .collect();
        let (names, groups) = handle
            .read(move |d| {
                let reader = BookReader::from_loro(book_id, d)?;
                let view = reader.view();
                let excluded: Vec<&str> = exclude.iter().map(String::as_str).collect();
                let mut groups = HashMap::new();
                for n in view.chapters() {
                    groups.insert(n.id.to_string(), NameGroup::Chapter);
                }
                for n in view.drifts() {
                    groups.insert(n.id.to_string(), NameGroup::Idea);
                }
                Ok::<_, dr_doc::DocError>((book_link_names(&view, &excluded), groups))
            })
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        Ok(NameIndex::new(names).with_groups(groups))
    }

    pub fn is_empty(&self) -> bool {
        self.matcher.is_empty()
    }

    /// Whether `text` is a name or alias of target `id`.
    pub fn is_name_of(&self, text: &str, id: &str) -> bool {
        self.names
            .get(id)
            .is_some_and(|names| names.contains(text.trim()))
    }

    /// Names that contain `query` (case-insensitive), grouped (elements,
    /// then chapters, then ideas) and sorted by pinyin within a group: the
    /// @ picker's rows. Each row is `(name, target, group)`; an alias is a
    /// row of its own.
    pub fn search(&self, query: &str, limit: usize) -> Vec<(String, LinkTarget, NameGroup)> {
        let q = query.to_lowercase();
        let mut rows: Vec<(String, LinkTarget, NameGroup)> = self
            .matcher
            .names()
            .iter()
            .filter(|n| n.name.to_lowercase().contains(&q))
            .map(|n| (n.name.clone(), n.target.clone(), self.group(&n.target)))
            .collect();
        rows.sort_by(|a, b| a.2.cmp(&b.2).then_with(|| compare_names(&a.0, &b.0)));
        rows.truncate(limit);
        rows
    }

    /// Whether an element is called `name` exactly (case-insensitive), for
    /// the picker's 「创建要素」 row.
    pub fn has_element_named(&self, name: &str) -> bool {
        let name = name.to_lowercase();
        self.matcher
            .names()
            .iter()
            .any(|n| n.target.kind == EntityKind::Element && n.name.to_lowercase() == name)
    }
}

/// A link to put on or take off, in characters of one paragraph.
#[derive(Clone, Debug, PartialEq)]
pub enum LinkEdit {
    Link {
        range: Range<usize>,
        target: LinkTarget,
    },
    Unlink {
        range: Range<usize>,
        /// The mark key (`entity:<id>`).
        key: String,
    },
}

/// A run of one entity link on a paragraph, in characters.
#[derive(Clone, Debug, PartialEq)]
pub struct LinkRun {
    pub range: Range<usize>,
    /// The target id.
    pub target: String,
}

/// The entity-link runs of a paragraph (adjacent spans of one target
/// joined), in characters.
pub fn link_runs(line: &Line) -> Vec<LinkRun> {
    let text = line.text.as_ref();
    let char_of = |byte: usize| text[..byte].chars().count();
    let mut runs: Vec<LinkRun> = Vec::new();
    for span in line.spans.iter() {
        let range = char_of(span.range.start)..char_of(span.range.end);
        for (target, _) in span.marks.entities() {
            match runs
                .iter_mut()
                .rev()
                .find(|r| r.target == target && r.range.end == range.start)
            {
                Some(run) => run.range.end = range.end,
                None => runs.push(LinkRun {
                    range: range.clone(),
                    target: target.to_owned(),
                }),
            }
        }
    }
    runs.sort_by_key(|r| (r.range.start, r.range.end));
    runs
}

/// The automatic links paragraph `text` gains, given its link `runs`.
pub fn autolink(text: &str, runs: &[LinkRun], index: &NameIndex) -> Vec<LinkEdit> {
    let mut edits = Vec::new();
    for m in index.matcher.find(text) {
        let target = index.matcher.target(&m);
        let r = m.range.clone();
        let overlapping: Vec<&LinkRun> = runs
            .iter()
            .filter(|run| run.range.start < r.end && r.start < run.range.end)
            .collect();
        // Linked to its target all the way already.
        let covered = |at: usize| {
            overlapping
                .iter()
                .any(|run| run.target == target.id && run.range.contains(&at))
        };
        if r.clone().all(covered) {
            continue;
        }
        // Someone else's link reaching outside the name: leave both alone
        // rather than cross them.
        if overlapping.iter().any(|run| {
            run.target != target.id && (run.range.start < r.start || run.range.end > r.end)
        }) {
            continue;
        }
        for run in overlapping.iter().filter(|run| run.target != target.id) {
            edits.push(LinkEdit::Unlink {
                range: run.range.clone(),
                key: gpui_prose::schema::inline::entity_key(&run.target),
            });
        }
        edits.push(LinkEdit::Link {
            range: r,
            target: target.clone(),
        });
    }
    edits
}

/// The links the author's edit at `caret` broke: a link run touching the
/// caret whose text is no longer a name or alias of its target comes off.
pub fn repairs(text: &str, runs: &[LinkRun], caret: usize, index: &NameIndex) -> Vec<LinkEdit> {
    runs.iter()
        .filter(|run| run.range.start <= caret && caret <= run.range.end)
        .filter(|run| {
            let name: String = text
                .chars()
                .skip(run.range.start)
                .take(run.range.len())
                .collect();
            index.names.contains_key(&run.target) && !index.is_name_of(&name, &run.target)
        })
        .map(|run| LinkEdit::Unlink {
            range: run.range.clone(),
            key: gpui_prose::schema::inline::entity_key(&run.target),
        })
        .collect()
}

/// The value dr-doc stores on an entity link to `target` (no deep link).
pub fn link_value(target: &LinkTarget) -> LoroValue {
    crate::convert::entity_value(&dr_model::prose::EntityLink {
        target: target.id.clone(),
        kind: target.kind.clone(),
        block: None,
        end_block: None,
    })
}

/// Applies `edits` on paragraph `line_ix` of `doc` as the author.
pub fn apply(doc: &mut ProseDoc, line_ix: usize, edits: &[LinkEdit]) {
    let start = doc.line_start(line_ix);
    for edit in edits {
        match edit {
            LinkEdit::Unlink { range, key } => doc.unmark(
                start + range.start..start + range.end,
                key,
                gpui_prose::text::ORIGIN_USER,
            ),
            LinkEdit::Link { range, target } => doc.mark(
                start + range.start..start + range.end,
                &gpui_prose::schema::inline::entity_key(&target.id),
                link_value(target),
                gpui_prose::text::ORIGIN_USER,
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index() -> NameIndex {
        let el =
            |name: &str, id: &str| LinkName::new(name, LinkTarget::new(EntityKind::Element, id));
        NameIndex::new(vec![
            el("叶青", "e1"),
            el("叶青知", "e2"),
            el("约格", "e3"),
            el("老约", "e3"),
            LinkName::new("码头", LinkTarget::new(EntityKind::Node, "c1")),
        ])
    }

    fn run(range: Range<usize>, target: &str) -> LinkRun {
        LinkRun {
            range,
            target: target.to_owned(),
        }
    }

    fn link(range: Range<usize>, kind: EntityKind, id: &str) -> LinkEdit {
        LinkEdit::Link {
            range,
            target: LinkTarget::new(kind, id),
        }
    }

    #[test]
    fn names_link_longest_first_and_once() {
        let ix = index();
        assert_eq!(
            autolink("叶青知到达码头。", &[], &ix),
            [
                link(0..3, EntityKind::Element, "e2"),
                link(5..7, EntityKind::Node, "c1")
            ]
        );
        // Already linked: nothing.
        assert_eq!(autolink("叶青知", &[run(0..3, "e2")], &ix), []);
        // Partly linked to the same target: linked whole (a split heals).
        assert_eq!(
            autolink("叶青知", &[run(0..1, "e2"), run(2..3, "e2")], &ix),
            [link(0..3, EntityKind::Element, "e2")]
        );
    }

    #[test]
    fn a_longer_name_takes_over_a_shorter_link() {
        let ix = index();
        // 叶青 was linked as typed; 知 completes 叶青知.
        assert_eq!(
            autolink("叶青知", &[run(0..2, "e1")], &ix),
            [
                LinkEdit::Unlink {
                    range: 0..2,
                    key: "entity:e1".into()
                },
                link(0..3, EntityKind::Element, "e2")
            ]
        );
        // Someone else's link reaching past the name: left alone.
        assert_eq!(autolink("叶青知道", &[run(0..4, "e9")], &ix), []);
    }

    #[test]
    fn a_broken_name_loses_its_link() {
        let ix = index();
        // 约格 → 约 (格 deleted, caret after 约).
        assert_eq!(
            repairs("约来了", &[run(0..1, "e3")], 1, &ix),
            [LinkEdit::Unlink {
                range: 0..1,
                key: "entity:e3".into()
            }]
        );
        // Another alias of the same target keeps it.
        assert_eq!(repairs("老约来了", &[run(0..2, "e3")], 2, &ix), []);
        // A link away from the caret is not checked.
        assert_eq!(repairs("约来了", &[run(0..1, "e3")], 3, &ix), []);
        // A link on text that was never a name of a known target stays.
        assert_eq!(repairs("某某", &[run(0..2, "zz")], 2, &ix), []);
    }

    #[test]
    fn the_picker_searches_names_and_aliases() {
        let ix = index();
        let rows: Vec<String> = ix.search("约", 30).into_iter().map(|r| r.0).collect();
        // Pinyin order: lǎo before yuē.
        assert_eq!(rows, ["老约", "约格"]);
        let rows: Vec<String> = ix.search("", 30).into_iter().map(|r| r.0).collect();
        assert_eq!(
            rows.last().map(String::as_str),
            Some("码头"),
            "elements first"
        );
        assert!(ix.has_element_named("约格") && !ix.has_element_named("约"));
    }

    #[test]
    fn the_picker_groups_elements_chapters_and_ideas() {
        let node =
            |name: &str, id: &str| LinkName::new(name, LinkTarget::new(EntityKind::Node, id));
        let el =
            |name: &str, id: &str| LinkName::new(name, LinkTarget::new(EntityKind::Element, id));
        let ix = NameIndex::new(vec![
            node("潮水", "i1"),
            node("码头", "c1"),
            el("周阿婆", "e1"),
            node("灯塔", "c2"),
            el("安娜", "e2"),
        ])
        .with_groups(HashMap::from([
            ("c1".to_owned(), NameGroup::Chapter),
            ("c2".to_owned(), NameGroup::Chapter),
            ("i1".to_owned(), NameGroup::Idea),
        ]));
        let rows: Vec<(String, NameGroup)> = ix
            .search("", 30)
            .into_iter()
            .map(|(n, _, g)| (n, g))
            .collect();
        // Elements, chapters, ideas; pinyin within each (ān before zhōu,
        // dēng before mǎ).
        assert_eq!(
            rows,
            [
                ("安娜".to_owned(), NameGroup::Element),
                ("周阿婆".to_owned(), NameGroup::Element),
                ("灯塔".to_owned(), NameGroup::Chapter),
                ("码头".to_owned(), NameGroup::Chapter),
                ("潮水".to_owned(), NameGroup::Idea),
            ]
        );
    }
}
