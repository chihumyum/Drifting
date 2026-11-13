//! Canonical v3 shell snapshot and prose reads.
use crate::nav::Target;
use dr_ui::{sand, tokens::Rgb};
use dr_workspace::{
    Actor, NavTarget, Workspace as Library, WsError,
    commands::{
        book::{BookList, ListBooksIn},
        prose::{ProseRead, ProseReadIn},
    },
    dto::{GroupInfo, MaterialInfo},
};
use std::collections::HashMap;
pub mod v3;
#[derive(Default)]
pub enum Snapshot {
    #[default]
    Empty,
    V3(Box<v3::BookV3>),
}
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub title: String,
    pub mark: sand::Kind,
    pub color: Option<Rgb>,
}
#[derive(Default)]
pub struct Book {
    pub id: String,
    pub name: String,
    pub snapshot: Snapshot,
    index: HashMap<String, Entry>,
}
pub fn color_of(hex: &str) -> Option<Rgb> {
    let digits = hex.trim().strip_prefix('#')?;
    if digits.len() != 6 {
        return None;
    }
    u32::from_str_radix(digits, 16).ok().map(Rgb::hex)
}
pub fn seal_of(id: &str) -> u8 {
    let mut hash: i32 = 0;
    for unit in id.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    ((hash as i64).abs() % 6) as u8
}
/// Lightweight entry admission. It reads the existing holder without repair,
/// creation, schema changes or a whole-book query. All UI entry points share it.
pub fn canonical(lib: &Library, book: &str) -> bool {
    lib.library()
        .open_doc(&format!("book:{book}"), dr_store::OpenDoc::Existing)
        .and_then(|handle| handle.read(dr_doc::v3::is_book_doc))
        .unwrap_or(false)
}
impl Book {
    pub fn load(lib: &Library, book: &str) -> Result<Book, WsError> {
        v3::load(lib, book)
    }
    pub fn load_any(lib: &Library, preferred: Option<&str>) -> Result<Option<Book>, WsError> {
        if let Some(id) = preferred {
            match Book::load(lib, id) {
                Ok(b) => return Ok(Some(b)),
                Err(e @ WsError::Conflict(_)) => return Err(e),
                Err(e) => log::info!("book {id} not opened: {e}"),
            }
        }
        let books = lib
            .run::<BookList>(&Actor::User, ListBooksIn { trashed: false })?
            .output;
        for b in books
            .into_iter()
            .filter(|b| Some(b.id.as_str()) != preferred)
        {
            match Book::load(lib, &b.id) {
                Ok(book) => return Ok(Some(book)),
                Err(e @ WsError::Conflict(_)) => return Err(e),
                Err(e) => log::info!("book {} not opened: {e}", b.id),
            }
        }
        Ok(None)
    }
    pub fn is_empty(&self) -> bool {
        self.id.is_empty()
    }
    pub fn entry(&self, target: &Target) -> Option<&Entry> {
        let key = match target {
            Target::Entry { id, .. } | Target::Book(id) => format!("entry:{id}"),
            _ => target.key(),
        };
        self.index.get(&key)
    }
    pub fn title(&self, target: &Target) -> Option<&str> {
        self.entry(target).map(|e| e.title.as_str())
    }
    pub fn v3(&self) -> Option<&v3::BookV3> {
        match &self.snapshot {
            Snapshot::V3(b) => Some(b),
            Snapshot::Empty => None,
        }
    }
    pub fn material_items(&self) -> &[MaterialInfo] {
        self.v3().map_or(&[], |b| b.materials.as_slice())
    }
    pub fn material_folders(&self) -> &[GroupInfo] {
        self.v3().map_or(&[], |b| b.material_folders.as_slice())
    }
    pub fn exists(&self, target: &Target) -> bool {
        self.v3().is_some_and(|b| b.exists(target))
    }
    pub fn mark(&self, target: &Target) -> (sand::Kind, Option<Rgb>) {
        if matches!(target, Target::Book(_)) {
            return (sand::Kind::All, self.entry(target).and_then(|e| e.color));
        }
        self.entry(target)
            .map(|e| (e.mark, e.color))
            .unwrap_or_else(|| {
                (
                    match target {
                        Target::Book(_) => sand::Kind::All,
                        Target::Material(_) => sand::Kind::Material,
                        _ => sand::Kind::Element,
                    },
                    None,
                )
            })
    }
}
pub fn doc_of(target: &Target) -> Option<String> {
    match target {
        Target::Entry {
            id,
            module: Some(module),
        } => Some(format!("body:{id}/{module}")),
        Target::Material(id) => Some(format!("material:{id}")),
        _ => None,
    }
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
    pub fn paragraphs(&self) -> usize {
        self.sections.iter().map(|(_, p)| p.len()).sum()
    }
}
pub fn nav_target(t: &Target) -> NavTarget {
    match t {
        Target::Book(id) => NavTarget::Entry {
            id: id.clone(),
            module: None,
        },
        Target::Entry { id, module } => NavTarget::Entry {
            id: id.clone(),
            module: module.clone(),
        },
        Target::Template(id) => NavTarget::Template(id.clone()),
        Target::Material(id) => NavTarget::Material(id.clone()),
    }
}
pub fn target(t: NavTarget) -> Option<Target> {
    Some(match t {
        NavTarget::Book => return None,
        NavTarget::Entry { id, module } => Target::Entry { id, module },
        NavTarget::Template(id) => Target::Template(id),
        NavTarget::Material(id) => Target::Material(id),
    })
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
