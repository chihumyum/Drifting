//! Where names occur in text, for automatic entity links (人物自动链接).
//!
//! The rule of the 0.1 client (`crates/drifting-document/src/entity_links.rs`,
//! `src/renderer/lib/entity-link-names.ts`), kept:
//!
//! - every name is matched verbatim: case-sensitive, no word boundaries;
//! - at each position the longest name wins, matches never overlap, and the
//!   scan goes left to right (Aho–Corasick, leftmost-longest);
//! - the same name given twice: the later entry wins (a JavaScript `Map`),
//!   so chapter and idea titles, added after element names, take a name an
//!   element also has;
//! - a document never links to itself, nor a patch to its own element.
//!
//! Changed on purpose:
//!
//! - names are trimmed and a name that is empty after trimming is ignored
//!   (0.1 ignored only the empty string; a name of spaces would have matched
//!   every run of spaces);
//! - a name that two live elements share after a merge (dr-doc marks the
//!   later one with `name_conflict`) links only to the element that keeps it,
//!   so automatic links never guess between two people;
//! - matching runs over a paragraph's text, not one style run at a time, so a
//!   half-bold name is still found.
//!
//! This module only finds positions; writing links is the editor's and the
//! commands' job (M12).

use std::collections::{HashMap, HashSet};
use std::ops::Range;

use aho_corasick::{AhoCorasick, MatchKind};
use dr_doc::book::BookView;
use dr_doc::prose::{Paragraph, ProseView};
use dr_model::book::element_name_key;
use dr_model::id::BlockId;
use dr_model::kind::EntityKind;
use prose_metrics::is_js_whitespace;

/// What a name links to.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct LinkTarget {
    pub kind: EntityKind,
    pub id: String,
}

impl LinkTarget {
    pub fn new(kind: EntityKind, id: impl Into<String>) -> Self {
        Self {
            kind,
            id: id.into(),
        }
    }
}

/// One name and what it links to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkName<T> {
    pub name: String,
    pub target: T,
}

impl<T> LinkName<T> {
    pub fn new(name: impl Into<String>, target: T) -> Self {
        Self {
            name: name.into(),
            target,
        }
    }
}

/// One occurrence of a name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkMatch {
    /// Unicode-scalar range in the text searched.
    pub range: Range<usize>,
    /// Index into [`LinkMatcher::names`].
    pub name: usize,
}

/// A link a document could gain: where, and to what.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SuggestedLink<T> {
    /// The paragraph's block id (as readers see it).
    pub block: Option<BlockId>,
    /// Unicode-scalar range in the whole document.
    pub range: Range<usize>,
    pub target: T,
}

/// A compiled set of names.
pub struct LinkMatcher<T> {
    names: Vec<LinkName<T>>,
    automaton: Option<AhoCorasick>,
}

impl<T> LinkMatcher<T> {
    /// Compile `names`. Names are trimmed; empty ones are ignored; for a name
    /// given twice the later target replaces the earlier one, keeping the
    /// first one's place.
    pub fn new(names: impl IntoIterator<Item = LinkName<T>>) -> Self {
        let mut out: Vec<LinkName<T>> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        for n in names {
            let name = n.name.trim_matches(is_js_whitespace);
            if name.is_empty() {
                continue;
            }
            match index.get(name) {
                Some(&i) => out[i].target = n.target,
                None => {
                    index.insert(name.to_string(), out.len());
                    out.push(LinkName {
                        name: name.to_string(),
                        target: n.target,
                    });
                }
            }
        }
        let automaton = (!out.is_empty()).then(|| {
            AhoCorasick::builder()
                .match_kind(MatchKind::LeftmostLongest)
                .build(out.iter().map(|n| n.name.as_str()))
                .expect("names compile into an automaton")
        });
        Self {
            names: out,
            automaton,
        }
    }

    /// The names after trimming and de-duplication, in first-seen order.
    pub fn names(&self) -> &[LinkName<T>] {
        &self.names
    }

    pub fn is_empty(&self) -> bool {
        self.names.is_empty()
    }

    pub fn target(&self, m: &LinkMatch) -> &T {
        &self.names[m.name].target
    }

    /// Every occurrence in `text`: leftmost-longest, non-overlapping, in
    /// order. Ranges are in Unicode scalars.
    pub fn find(&self, text: &str) -> Vec<LinkMatch> {
        let Some(ac) = &self.automaton else {
            return Vec::new();
        };
        let mut out = Vec::new();
        // Byte offsets to scalar offsets, counted as the scan moves on.
        let mut byte = 0usize;
        let mut chars = 0usize;
        let mut to_chars = |b: usize| {
            chars += text[byte..b].chars().count();
            byte = b;
            chars
        };
        for m in ac.find_iter(text) {
            let start = to_chars(m.start());
            let end = to_chars(m.end());
            out.push(LinkMatch {
                range: start..end,
                name: m.pattern().as_usize(),
            });
        }
        out
    }
}

impl<T: PartialEq + Clone> LinkMatcher<T> {
    /// Occurrences in one paragraph that are not already linked to their
    /// target over their whole length. `link_target` reads the target of an
    /// existing link the way this matcher's targets are spelled. Ranges are
    /// in the whole document.
    pub fn suggest_in(
        &self,
        p: &Paragraph,
        link_target: impl Fn(&dr_model::prose::EntityLink) -> T,
    ) -> Vec<SuggestedLink<T>> {
        let text: String = p.runs.iter().map(|r| r.text.as_str()).collect();
        let found = self.find(&text);
        if found.is_empty() {
            return Vec::new();
        }
        // Each run's range in the paragraph and its links' targets.
        let mut runs: Vec<(Range<usize>, Vec<T>)> = Vec::with_capacity(p.runs.len());
        let mut at = 0usize;
        for r in &p.runs {
            let n = r.text.chars().count();
            runs.push((
                at..at + n,
                r.marks.entities.iter().map(&link_target).collect(),
            ));
            at += n;
        }
        found
            .into_iter()
            .filter(|m| {
                let target = self.target(m);
                // Linked already when every run under the match links there.
                !runs
                    .iter()
                    .filter(|(r, _)| r.start < m.range.end && m.range.start < r.end)
                    .all(|(_, links)| links.contains(target))
            })
            .map(|m| SuggestedLink {
                block: p.id.clone(),
                range: p.range.start + m.range.start..p.range.start + m.range.end,
                target: self.target(&m).clone(),
            })
            .collect()
    }
}

impl LinkMatcher<LinkTarget> {
    /// Occurrences in a whole document that are not linked yet.
    pub fn suggest(&self, view: &ProseView<'_>) -> Vec<SuggestedLink<LinkTarget>> {
        if self.is_empty() {
            return Vec::new();
        }
        view.paragraphs()
            .flat_map(|p| {
                self.suggest_in(&p, |l| LinkTarget::new(l.kind.clone(), l.target.clone()))
            })
            .collect()
    }
}

/// The names a body of `book` links automatically, in priority order (feed
/// them to [`LinkMatcher::new`]): every live element's name and aliases,
/// then every live chapter's and idea's title. `exclude` lists entity ids
/// that must not be linked: the document's own entity, and for a patch its
/// element.
///
/// An element dr-doc marks with `name_conflict` (it shares a name or alias
/// with an element created earlier) contributes only the names no other
/// live element keeps.
pub fn book_link_names(book: &BookView<'_>, exclude: &[&str]) -> Vec<LinkName<LinkTarget>> {
    let excluded: HashSet<&str> = exclude.iter().copied().collect();
    let elements: Vec<_> = book
        .elements()
        .into_iter()
        .filter(|e| e.deleted_at.is_none())
        .collect();
    // Name keys owned by the elements that keep their names.
    let mut owner: HashMap<String, &str> = HashMap::new();
    for e in elements.iter().filter(|e| e.name_conflict.is_none()) {
        for n in std::iter::once(&e.name).chain(e.aliases.iter()) {
            let key = element_name_key(n);
            if !key.is_empty() {
                owner.entry(key).or_insert(e.id.as_str());
            }
        }
    }
    let mut out = Vec::new();
    for e in &elements {
        if excluded.contains(e.id.as_str()) {
            continue;
        }
        for n in std::iter::once(&e.name).chain(e.aliases.iter()) {
            if e.name_conflict.is_some()
                && owner
                    .get(&element_name_key(n))
                    .is_some_and(|o| *o != e.id.as_str())
            {
                continue;
            }
            out.push(LinkName::new(
                n.clone(),
                LinkTarget::new(EntityKind::Element, e.id.as_str()),
            ));
        }
    }
    // Chapters in book order, then ideas by id: for a title two of them
    // share, the later one wins, as in the old `Map`.
    let mut ideas = book.drifts();
    ideas.sort_by(|a, b| a.id.cmp(&b.id));
    for n in book.chapters().into_iter().chain(ideas) {
        if excluded.contains(n.id.as_str()) {
            continue;
        }
        out.push(LinkName::new(
            n.title.clone(),
            LinkTarget::new(EntityKind::Node, n.id.as_str()),
        ));
    }
    out
}
