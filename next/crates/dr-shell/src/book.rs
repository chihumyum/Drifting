//! The open book as the shell reads it: F3's queries (`dr-workspace`), one
//! snapshot the panels, the dock and the pages read every frame.
//!
//! - [`Book::load`] runs the list queries (chapters in reading order,
//!   storylines, categories and elements, idea groups and ideas, material
//!   folders and materials) off the main thread; the workspace swaps the
//!   whole snapshot in when it arrives and again after every change F3
//!   reports for the book (`WsEvent::Book`).
//! - [`PageText::load`] reads one document's prose (`prose.read`): plain text
//!   and heading level per paragraph, for the read-only page until the
//!   editor (dr-editor) takes the page over.
//! - The location-link [`Catalog`] is F3's `BookCatalog`; [`target`] maps
//!   F3's `NavTarget` (removals, link lookups) to the shell's [`Target`].

use std::collections::HashMap;

use dr_ui::{sand, tokens::Rgb};
use dr_workspace::{
    Actor, BookCatalog, LinkGroup, NavTarget, Workspace as Library, WsError,
    commands::{
        BookIn, ListIn,
        book::{BookGet, BookList, ListBooksIn},
        chapter::{ActList, ChapterList},
        element::{CategoryList, ElementList, ElementListIn},
        idea::{IdeaGroupList, IdeaList, IdeaListIn},
        material::{FolderList, MaterialList, MaterialListIn},
        prose::{ProseRead, ProseReadIn},
        storyline::StorylineList,
    },
    dto::{
        ActInfo, CategoryInfo, ChapterInfo, ElementInfo, GroupInfo, IdeaInfo, MaterialInfo,
        StorylineInfo,
    },
};

use crate::nav::Target;
use crate::nav::location::{Catalog, Group};

/// How a target shows in a list, a pill and on its page.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub title: String,
    pub mark: sand::Kind,
    /// Its storyline's or category's colour, as the author chose it.
    pub color: Option<Rgb>,
}

/// One book's lists, as F3 returned them.
#[derive(Default)]
pub struct Book {
    pub id: String,
    pub name: String,
    pub storylines: Vec<StorylineInfo>,
    /// Reading order.
    pub chapters: Vec<ChapterInfo>,
    /// Reading order, each with its chapters.
    pub acts: Vec<ActInfo>,
    pub categories: Vec<CategoryInfo>,
    pub elements: Vec<ElementInfo>,
    /// Parents before children.
    pub idea_groups: Vec<GroupInfo>,
    pub ideas: Vec<IdeaInfo>,
    pub folders: Vec<GroupInfo>,
    pub materials: Vec<MaterialInfo>,
    index: HashMap<String, Entry>,
}

/// `#RRGGBB` as the author chose it; anything else has no colour.
pub fn color_of(hex: &str) -> Option<Rgb> {
    let digits = hex.trim().strip_prefix('#')?;
    if digits.len() != 6 {
        return None;
    }
    u32::from_str_radix(digits, 16).ok().map(Rgb::hex)
}

/// The seal a chapter presses, always the same one for the same chapter
/// (the 0.1 client's `sealOf`: a 31-hash of the id, UTF-16 units, modulo 6).
pub fn seal_of(id: &str) -> u8 {
    let mut hash: i32 = 0;
    for unit in id.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    ((hash as i64).abs() % 6) as u8
}

impl Book {
    /// Reads `book` through F3's queries. Call it off the main thread: the
    /// first read of a book opens its document.
    pub fn load(lib: &Library, book: &str) -> Result<Book, WsError> {
        let me = &Actor::User;
        let list = || ListIn {
            book: book.to_owned(),
            trashed: false,
        };
        let book_in = || BookIn {
            book: book.to_owned(),
        };
        let detail = lib.run::<BookGet>(me, book_in())?.output;
        if detail.info.trashed {
            return Err(WsError::NotFound {
                what: "book",
                id: book.to_owned(),
            });
        }
        let mut b = Book {
            id: book.to_owned(),
            name: detail.info.name,
            storylines: lib.run::<StorylineList>(me, list())?.output,
            chapters: lib.run::<ChapterList>(me, list())?.output,
            categories: lib.run::<CategoryList>(me, list())?.output,
            elements: lib
                .run::<ElementList>(
                    me,
                    ElementListIn {
                        book: book.to_owned(),
                        category: None,
                        trashed: false,
                    },
                )?
                .output,
            idea_groups: lib.run::<IdeaGroupList>(me, book_in())?.output,
            ideas: lib
                .run::<IdeaList>(
                    me,
                    IdeaListIn {
                        book: book.to_owned(),
                        group: None,
                        trashed: false,
                    },
                )?
                .output,
            acts: lib.run::<ActList>(me, book_in())?.output,
            folders: lib.run::<FolderList>(me, book_in())?.output,
            materials: lib
                .run::<MaterialList>(
                    me,
                    MaterialListIn {
                        book: book.to_owned(),
                        folder: None,
                    },
                )?
                .output,
            index: HashMap::new(),
        };
        b.reindex();
        Ok(b)
    }

    /// Opens `preferred` if it can, else the library's first book that is
    /// not in the trash. `Ok(None)`: the library has no book.
    pub fn load_any(lib: &Library, preferred: Option<&str>) -> Result<Option<Book>, WsError> {
        if let Some(id) = preferred {
            match Book::load(lib, id) {
                Ok(b) => return Ok(Some(b)),
                Err(e) => log::info!("book {id} not opened: {e}"),
            }
        }
        let books = lib
            .run::<BookList>(&Actor::User, ListBooksIn { trashed: false })?
            .output;
        match books.into_iter().find(|b| Some(b.id.as_str()) != preferred) {
            Some(b) => Book::load(lib, &b.id).map(Some),
            None => Ok(None),
        }
    }

    /// The chapters' ids and titles in reading order.
    pub fn chapter_titles(&self) -> Vec<(String, String)> {
        self.chapters
            .iter()
            .map(|c| (c.id.clone(), c.title.clone()))
            .collect()
    }

    fn reindex(&mut self) {
        let mut index = HashMap::new();
        let storyline_color: HashMap<&str, Option<Rgb>> = self
            .storylines
            .iter()
            .map(|s| (s.id.as_str(), color_of(&s.color)))
            .collect();
        let category_color: HashMap<&str, Option<Rgb>> = self
            .categories
            .iter()
            .map(|c| (c.id.as_str(), color_of(&c.color)))
            .collect();
        let mut put = |key: String, title: &str, mark: sand::Kind, color: Option<Rgb>| {
            index.insert(
                key,
                Entry {
                    title: title.to_owned(),
                    mark,
                    color,
                },
            );
        };
        for s in &self.storylines {
            put(
                format!("storyline:{}", s.id),
                &s.name,
                sand::Kind::Storyline,
                color_of(&s.color),
            );
        }
        for c in &self.chapters {
            let storyline = c.primary_storyline.as_ref().or(c.storylines.first());
            let color = storyline
                .and_then(|s| storyline_color.get(s.as_str()))
                .copied()
                .flatten();
            put(
                format!("chapter:{}", c.id),
                &c.title,
                sand::Kind::Chapter(seal_of(&c.id)),
                color,
            );
        }
        for c in &self.categories {
            put(
                format!("category:{}", c.id),
                &c.name,
                sand::Kind::Category,
                color_of(&c.color),
            );
        }
        for e in &self.elements {
            let color = e
                .category
                .as_ref()
                .and_then(|c| category_color.get(c.as_str()))
                .copied()
                .flatten();
            put(
                format!("element:{}", e.id),
                &e.name,
                sand::Kind::Element,
                color,
            );
        }
        for i in &self.ideas {
            put(
                format!("idea:{}", i.id),
                &i.title,
                sand::Kind::Drift {
                    loose: i.group.is_none(),
                },
                None,
            );
        }
        for m in &self.materials {
            put(
                format!("material:{}", m.id),
                &m.title,
                sand::Kind::Material,
                None,
            );
        }
        self.index = index;
    }

    /// Nothing open: no library, or the book could not be read.
    pub fn is_empty(&self) -> bool {
        self.id.is_empty()
    }

    pub fn entry(&self, target: &Target) -> Option<&Entry> {
        self.index.get(&target.key())
    }

    /// The name a tab or a page shows for `target` (the book's own name for
    /// [`Target::Book`]); `None` when it is gone.
    pub fn title(&self, target: &Target) -> Option<&str> {
        match target {
            Target::Book => (!self.is_empty()).then_some(self.name.as_str()),
            t => self.entry(t).map(|e| e.title.as_str()),
        }
    }

    pub fn exists(&self, target: &Target) -> bool {
        match target {
            Target::Book => !self.is_empty(),
            t => self.index.contains_key(&t.key()),
        }
    }

    /// The kind mark and colour of `target`.
    pub fn mark(&self, target: &Target) -> (sand::Kind, Option<Rgb>) {
        if let Some(e) = self.entry(target) {
            return (e.mark, e.color);
        }
        let kind = match target {
            Target::Chapter(id) => sand::Kind::Chapter(seal_of(id.as_str())),
            Target::Idea(_) => sand::Kind::Drift { loose: true },
            Target::Storyline(_) => sand::Kind::Storyline,
            Target::Element(_) => sand::Kind::Element,
            Target::Category(_) => sand::Kind::Category,
            Target::Material(_) => sand::Kind::Material,
            Target::Book => sand::Kind::All,
        };
        (kind, None)
    }

    /// Chapters in reading order that belong to no storyline (未归属).
    pub fn unaffiliated(&self) -> impl Iterator<Item = &ChapterInfo> {
        self.chapters.iter().filter(|c| c.storylines.is_empty())
    }

    /// The chapters of a storyline, in reading order.
    pub fn chapters_of<'a>(&'a self, storyline: &'a str) -> impl Iterator<Item = &'a ChapterInfo> {
        self.chapters
            .iter()
            .filter(move |c| c.storylines.iter().any(|s| s == storyline))
    }
}

/// The prose document a target's page shows (F1's `DocId` string).
pub fn doc_of(target: &Target) -> Option<String> {
    Some(match target {
        Target::Chapter(id) | Target::Idea(id) => format!("node:{id}"),
        Target::Element(id) => format!("element:{id}"),
        Target::Storyline(id) => format!("storyline:{id}"),
        Target::Category(id) => format!("category:{id}"),
        Target::Material(id) => format!("material:{id}"),
        Target::Book => return None,
    })
}

/// One paragraph of a page: its plain text and heading level (0 for body
/// text, 1–3 for H1–H3).
#[derive(Clone, Debug, PartialEq)]
pub struct Paragraph {
    pub heading: u8,
    pub text: String,
}

/// The prose a page shows, read-only.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PageText {
    /// Per chapter for the whole book (title, paragraphs); one unnamed
    /// section otherwise.
    pub sections: Vec<(Option<String>, Vec<Paragraph>)>,
}

impl PageText {
    /// Reads every paragraph of `doc`. A document that was never written
    /// (an element without a body) reads as no paragraphs.
    pub fn read_doc(lib: &Library, doc: &str) -> Result<Vec<Paragraph>, WsError> {
        let out = lib.run::<ProseRead>(
            &Actor::User,
            ProseReadIn {
                doc: doc.to_owned(),
                from: 0,
                limit: Some(usize::MAX),
            },
        );
        match out {
            Ok(o) => Ok(o
                .output
                .paragraphs
                .into_iter()
                .map(|p| Paragraph {
                    heading: p.heading.min(3),
                    text: p.text,
                })
                .collect()),
            Err(e) if e.code() == "not_found" => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    /// Reads the page of `target` (off the main thread). The whole book
    /// reads `chapters` (id, title) in reading order.
    pub fn load(
        lib: &Library,
        target: &Target,
        chapters: &[(String, String)],
    ) -> Result<PageText, WsError> {
        match target {
            Target::Book => {
                let mut sections = Vec::with_capacity(chapters.len());
                for (id, title) in chapters {
                    let paragraphs = PageText::read_doc(lib, &format!("node:{id}"))?;
                    sections.push((Some(title.clone()), paragraphs));
                }
                Ok(PageText { sections })
            }
            t => {
                let doc = doc_of(t).expect("only the book has no document");
                Ok(PageText {
                    sections: vec![(None, PageText::read_doc(lib, &doc)?)],
                })
            }
        }
    }

    pub fn paragraphs(&self) -> usize {
        self.sections.iter().map(|(_, p)| p.len()).sum()
    }
}

/// The shell's target as F3 names it (for the view modules).
pub fn nav_target(t: &Target) -> NavTarget {
    match t {
        Target::Book => NavTarget::Book,
        Target::Chapter(id) => NavTarget::Chapter(id.clone()),
        Target::Idea(id) => NavTarget::Idea(id.clone()),
        Target::Storyline(id) => NavTarget::Storyline(id.clone()),
        Target::Element(id) => NavTarget::Element(id.clone()),
        Target::Category(id) => NavTarget::Category(id.clone()),
        Target::Material(id) => NavTarget::Material(id.clone()),
    }
}

/// F3's target as the shell names it.
pub fn target(t: NavTarget) -> Target {
    match t {
        NavTarget::Book => Target::Book,
        NavTarget::Chapter(id) => Target::Chapter(id),
        NavTarget::Idea(id) => Target::Idea(id),
        NavTarget::Storyline(id) => Target::Storyline(id),
        NavTarget::Element(id) => Target::Element(id),
        NavTarget::Category(id) => Target::Category(id),
        NavTarget::Material(id) => Target::Material(id),
    }
}

fn group(g: Group) -> LinkGroup {
    LinkGroup::from_segment(g.segment()).expect("the same five groups")
}

impl Catalog for BookCatalog {
    fn book_id(&self) -> Option<&str> {
        Some(BookCatalog::book_id(self))
    }

    fn by_name(&self, g: Group, name: &str) -> Vec<Target> {
        BookCatalog::by_name(self, group(g), name)
            .into_iter()
            .map(target)
            .collect()
    }

    fn by_id(&self, g: Group, id: &str) -> Option<Target> {
        BookCatalog::by_id(self, group(g), id).map(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seals_match_the_0_1_client() {
        // `sealOf` in src/renderer/components/ui/kind-mark.ts, run in node.
        assert_eq!(seal_of(""), 0);
        assert_eq!(seal_of("a"), 97 % 6);
        assert_eq!(seal_of("ab"), ((97 * 31 + 98) % 6) as u8);
        // The hash wraps like JavaScript's `| 0`.
        let long = "019a5f3e-7c1d-7000-8000-000000000001";
        let mut h: i64 = 0;
        for u in long.encode_utf16() {
            h = ((h * 31 + u as i64) as i32) as i64;
        }
        assert_eq!(seal_of(long) as i64, h.abs() % 6);
    }

    #[test]
    fn colours_are_the_authors_hex() {
        assert_eq!(color_of("#9B6A4F"), Some(Rgb::hex(0x9B6A4F)));
        assert_eq!(color_of("9B6A4F"), None);
        assert_eq!(color_of("#abc"), None);
        assert_eq!(color_of(""), None);
    }
}
