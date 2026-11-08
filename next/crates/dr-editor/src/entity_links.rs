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
//! The rule itself is F3's ([`dr_workspace::autolink::plan`], which only
//! computes): the editor gives it a paragraph's text and links and writes
//! what comes back as the author, so the commands and the editor link by
//! one rule.
//!
//! Changed on purpose: the editor only links what the author typed. The
//! 0.1 client also scanned whole documents when they opened and after an
//! Agent's or a sync's write, as the author, which put links into the
//! author's undo history for text they did not type. Linking other writers'
//! text belongs to their commands, and so does linking a name the book has
//! just gained in the text already written (`element.create` / `update`,
//! `chapter.*`, `idea.*`: F3's `autolink`, with the command's origin, so
//! an editor open on the document shows the links as someone else's write,
//! outside the author's ⌘Z, and the command's own undo takes them back).

use std::collections::{HashMap, HashSet};

use dr_doc::book::BookReader;
use dr_model::id::BookId;
use dr_model::kind::EntityKind;
use dr_store::OpenDoc;
use dr_text::autolink::{LinkMatcher, LinkName, LinkTarget, book_link_names};
use dr_workspace::Workspace;
pub use dr_workspace::autolink::{LinkEdit, LinkRun};
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
    /// The pinyin initials of each of the matcher's names, in its order.
    initials: Vec<crate::pinyin::Initials>,
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
        let matcher = LinkMatcher::new(names);
        let initials = matcher
            .names()
            .iter()
            .map(|n| crate::pinyin::Initials::of(&n.name))
            .collect();
        NameIndex {
            matcher,
            initials,
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

    /// Names that contain `query` (case-insensitive) or whose pinyin
    /// initials it spells ([`crate::pinyin`]: `yg` for 约格), grouped
    /// (elements, then chapters, then ideas); within a group the names that
    /// contain it first, then by pinyin: the @ picker's rows. Each row is
    /// `(name, target, group)`; an alias is a row of its own.
    pub fn search(&self, query: &str, limit: usize) -> Vec<(String, LinkTarget, NameGroup)> {
        let q = query.to_lowercase();
        let mut rows: Vec<(bool, String, LinkTarget, NameGroup)> = self
            .matcher
            .names()
            .iter()
            .zip(&self.initials)
            .filter_map(|(n, initials)| {
                let contains = n.name.to_lowercase().contains(&q);
                (contains || initials.matches(&q)).then(|| {
                    (
                        contains,
                        n.name.clone(),
                        n.target.clone(),
                        self.group(&n.target),
                    )
                })
            })
            .collect();
        rows.sort_by(|a, b| {
            a.3.cmp(&b.3)
                .then_with(|| b.0.cmp(&a.0))
                .then_with(|| compare_names(&a.1, &b.1))
        });
        rows.truncate(limit);
        rows.into_iter().map(|(_, n, t, g)| (n, t, g)).collect()
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

/// The automatic links paragraph `text` gains, given its link `runs`: F3's
/// rule ([`dr_workspace::autolink::plan`]) over the whole paragraph.
pub fn autolink(text: &str, runs: &[LinkRun], index: &NameIndex) -> Vec<LinkEdit> {
    dr_workspace::autolink::plan(text, runs, &index.matcher, 0..text.chars().count())
}

/// The text of each link run of a paragraph: `(target id, text)`.
pub fn run_texts(text: &str, runs: &[LinkRun]) -> Vec<(String, String)> {
    runs.iter()
        .map(|run| {
            let t: String = text
                .chars()
                .skip(run.range.start)
                .take(run.range.len())
                .collect();
            (run.target.clone(), t)
        })
        .collect()
}

/// The links the author's edit at `caret` broke. A link run touching the
/// caret comes off when its text before the edit (`before`: the
/// paragraph's runs then, from [`run_texts`]) was a name or alias of its
/// target and its text now is not (deleting 格 from 约格). A link whose
/// text was not a current name before the edit is left alone: one on
/// pasted or arbitrary text, and one on an old name after its target was
/// renamed (the link is by id, so a rename breaks nothing; the 0.1
/// client's `repairEditedLinks`).
pub fn repairs(
    text: &str,
    runs: &[LinkRun],
    caret: usize,
    index: &NameIndex,
    before: &[(String, String)],
) -> Vec<LinkEdit> {
    runs.iter()
        .filter(|run| run.range.start <= caret && caret <= run.range.end)
        .filter(|run| {
            let now: String = text
                .chars()
                .skip(run.range.start)
                .take(run.range.len())
                .collect();
            if index.is_name_of(&now, &run.target) {
                return false;
            }
            // Its text before the edit: a run of the same target that the
            // edit changed, and that was a name then.
            let same: Vec<&(String, String)> =
                before.iter().filter(|(t, _)| *t == run.target).collect();
            !same.iter().any(|(_, was)| *was == now)
                && same
                    .iter()
                    .any(|(_, was)| index.is_name_of(was, &run.target))
        })
        .map(|run| LinkEdit::Unlink {
            range: run.range.clone(),
            target: run.target.clone(),
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
            LinkEdit::Unlink { range, target } => doc.unmark(
                start + range.start..start + range.end,
                &gpui_prose::schema::inline::entity_key(target),
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
    use std::ops::Range;

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
                    target: "e1".into()
                },
                link(0..3, EntityKind::Element, "e2")
            ]
        );
        // Someone else's link reaching past the name: left alone.
        assert_eq!(autolink("叶青知道", &[run(0..4, "e9")], &ix), []);
        // Someone else's link on exactly the name (renamed away, the name
        // taken since): the link stays.
        assert_eq!(autolink("叶青知", &[run(0..3, "e9")], &ix), []);
    }

    #[test]
    fn a_broken_name_loses_its_link() {
        let ix = index();
        let was = |t: &str| vec![("e3".to_owned(), t.to_owned())];
        // 约格 → 约 (格 deleted, caret after 约).
        assert_eq!(
            repairs("约来了", &[run(0..1, "e3")], 1, &ix, &was("约格")),
            [LinkEdit::Unlink {
                range: 0..1,
                target: "e3".into()
            }]
        );
        // Another alias of the same target keeps it.
        assert_eq!(
            repairs("老约来了", &[run(0..2, "e3")], 2, &ix, &was("约格")),
            []
        );
        // A link away from the caret is not checked.
        assert_eq!(
            repairs("约来了", &[run(0..1, "e3")], 3, &ix, &was("约格")),
            []
        );
        // A link on text that was never a name of a known target stays.
        assert_eq!(repairs("某某", &[run(0..2, "zz")], 2, &ix, &[]), []);
        // Renamed: the link's text is an old name (not a name now); typing
        // inside it does not take the link off.
        assert_eq!(
            repairs("约克先生", &[run(0..2, "e3")], 1, &ix, &was("约克")),
            []
        );
        // Nothing known about the text before: left alone.
        assert_eq!(repairs("约来了", &[run(0..1, "e3")], 1, &ix, &[]), []);
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
    fn the_picker_finds_names_by_their_pinyin_initials() {
        let ix = index();
        let rows: Vec<String> = ix.search("yg", 30).into_iter().map(|r| r.0).collect();
        assert_eq!(rows, ["约格"]);
        let rows: Vec<String> = ix.search("YQ", 30).into_iter().map(|r| r.0).collect();
        assert_eq!(rows, ["叶青", "叶青知"]);
        // A name that holds the query comes before one that only spells it.
        let ix = NameIndex::new(vec![
            LinkName::new("林雨", LinkTarget::new(EntityKind::Element, "e1")),
            LinkName::new("Lynn", LinkTarget::new(EntityKind::Element, "e2")),
        ]);
        let rows: Vec<String> = ix.search("ly", 30).into_iter().map(|r| r.0).collect();
        assert_eq!(rows, ["Lynn", "林雨"]);
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
