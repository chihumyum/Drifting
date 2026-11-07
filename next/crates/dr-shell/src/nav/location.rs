//! Location links: an address for a passage of prose, as in the 0.1 client
//! (`src/renderer/lib/location-link.ts`, docs/location-links.md).
//!
//! ```text
//! drifting:chapters/<title | id-<id>>/prose.md#L12-L18        in documents and Agent replies
//! <scheme>://open/<book id>/chapters/id-<id>/prose.md#L12     from the operating system
//! ../../chapters/id-<id>/prose.md#L5-7                        relative to the Markdown projection
//! ```
//!
//! Every prose entity has a canonical `prose.md` view whose block N (from 0)
//! starts on line 2N+1. The document form always uses `drifting:`; the
//! operating-system form uses the build's own scheme (`drifting-next-dev`
//! in development builds), so a link reaches the build that registered it.
//!
//! Parsing is pure; [`resolve`] finds the entity through a [`Catalog`].

use crate::nav::{Lines, Target};

/// The scheme of the document form.
pub const DOCUMENT_SCHEME: &str = "drifting";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Group {
    Chapters,
    Drifts,
    Elements,
    Categories,
    Storylines,
}

impl Group {
    pub const ALL: [Group; 5] = [
        Group::Chapters,
        Group::Drifts,
        Group::Elements,
        Group::Categories,
        Group::Storylines,
    ];

    pub fn segment(self) -> &'static str {
        match self {
            Group::Chapters => "chapters",
            Group::Drifts => "drifts",
            Group::Elements => "elements",
            Group::Categories => "categories",
            Group::Storylines => "storylines",
        }
    }

    fn from_segment(s: &str) -> Option<Group> {
        Group::ALL.into_iter().find(|g| g.segment() == s)
    }
}

/// How a link names its entity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reference {
    /// The title (unique in its group), decoded.
    Name(String),
    /// `id-<id>`: the stable id, decoded.
    Id(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocationLink {
    /// Only the operating-system form names a book.
    pub book: Option<String>,
    pub group: Group,
    pub reference: Reference,
    pub lines: Option<Lines>,
    /// Written with a scheme, as opposed to a projection-relative path.
    pub explicit: bool,
}

/// Parses any of the three forms; `os_scheme` is this build's scheme for the
/// operating-system form. `None` when `href` is not a location link.
pub fn parse(href: &str, os_scheme: &str) -> Option<LocationLink> {
    let raw = href.trim();
    if raw.is_empty() {
        return None;
    }
    let (explicit, mut rest, os_form) = match raw.split_once(':') {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case(DOCUMENT_SCHEME) => {
            let os = rest.starts_with("//open/");
            (true, rest, os)
        }
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case(os_scheme) => {
            if !rest.starts_with("//open/") {
                return None;
            }
            (true, rest, true)
        }
        Some((scheme, _))
            if !scheme.is_empty()
                && scheme
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)) =>
        {
            return None;
        }
        _ => (false, raw, false),
    };
    let fragment = match rest.split_once('#') {
        Some((path, fragment)) => {
            rest = path;
            fragment
        }
        None => "",
    };
    if rest.contains('?') {
        return None;
    }
    let mut segments: Vec<&str> = rest
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    if !explicit {
        while segments.first() == Some(&"..") {
            segments.remove(0);
        }
    }
    if segments.contains(&"..") {
        return None;
    }
    let mut book = None;
    if os_form {
        if segments.first() != Some(&"open") || segments.len() < 2 {
            return None;
        }
        book = Some(decode(segments[1]));
        segments.drain(..2);
    }
    if segments.first() == Some(&"project") {
        segments.remove(0);
    }
    let group = Group::from_segment(segments.first()?)?;
    let mut middle = &segments[1..];
    let body_file = |s: &str| {
        let lower = s.to_ascii_lowercase();
        ["prose.md", "body.md", "index.md"].contains(&lower.as_str())
    };
    match middle.last() {
        Some(last) if body_file(last) => middle = &middle[..middle.len() - 1],
        _ if !explicit => return None, // a bare relative folder is not a projection file
        _ => {}
    }
    let allowed = if group == Group::Elements {
        1..=2
    } else {
        1..=1
    };
    if !allowed.contains(&middle.len()) {
        return None;
    }
    let segment = middle[middle.len() - 1];
    let lines = if fragment.is_empty() {
        None
    } else {
        Some(parse_lines(fragment)?)
    };
    let reference = match segment.strip_prefix("id-") {
        Some(id) => Reference::Id(decode(id)),
        None => Reference::Name(decode(segment)),
    };
    Some(LocationLink {
        book,
        group,
        reference,
        lines,
        explicit,
    })
}

/// `L12`, `L12-L18`, `l5-7`.
fn parse_lines(fragment: &str) -> Option<Lines> {
    let body = fragment.strip_prefix(['L', 'l'])?;
    let (start, end) = match body.split_once('-') {
        Some((a, b)) => (a, Some(b.strip_prefix(['L', 'l']).unwrap_or(b))),
        None => (body, None),
    };
    let number = |s: &str| -> Option<u32> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        s.parse().ok()
    };
    let start = number(start)?;
    if start < 1 {
        return None;
    }
    let end = match end {
        Some(e) => {
            let e = number(e)?;
            if e < start {
                return None;
            }
            (e > start).then_some(e)
        }
        None => None,
    };
    Some(Lines { start, end })
}

/// Percent-decoding; invalid escapes are kept as written.
fn decode(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2]))
        {
            out.push(h * 16 + l);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| segment.to_owned())
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Block index (from 0) a line falls in; blank separator lines snap up.
pub fn line_to_block(line: u32) -> u32 {
    line.div_ceil(2).saturating_sub(1)
}

/// Finds entities by group and reference.
pub trait Catalog {
    /// The book the catalog belongs to.
    fn book_id(&self) -> Option<&str>;
    /// Every target in `group` named `name` (trimmed), so a duplicate shows.
    fn by_name(&self, group: Group, name: &str) -> Vec<Target>;
    fn by_id(&self, group: Group, id: &str) -> Option<Target>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkError {
    OtherBook(String),
    NotFound(Group, String),
    Ambiguous(Group, String, usize),
}

/// The target a link opens, and its lines.
pub fn resolve(
    link: &LocationLink,
    catalog: &dyn Catalog,
) -> Result<(Target, Option<Lines>), LinkError> {
    if let (Some(book), Some(ours)) = (&link.book, catalog.book_id())
        && book != ours
    {
        return Err(LinkError::OtherBook(book.clone()));
    }
    let target = match &link.reference {
        Reference::Id(id) => match catalog.by_id(link.group, id) {
            Some(target) => target,
            // An id-shaped title: try it as a name.
            None => by_name(catalog, link.group, &format!("id-{id}"))?,
        },
        Reference::Name(name) => by_name(catalog, link.group, name)?,
    };
    Ok((target, link.lines))
}

fn by_name(catalog: &dyn Catalog, group: Group, name: &str) -> Result<Target, LinkError> {
    let mut found = catalog.by_name(group, name.trim());
    match found.len() {
        0 => Err(LinkError::NotFound(group, name.to_owned())),
        1 => Ok(found.remove(0)),
        n => Err(LinkError::Ambiguous(group, name.to_owned(), n)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_model::id::{ElementId, NodeId};

    const OS: &str = "drifting-next-dev";

    #[test]
    fn parses_the_document_operating_system_and_relative_forms() {
        let link = parse("drifting:chapters/雨夜/prose.md#L12-L18", OS).unwrap();
        assert_eq!(link.group, Group::Chapters);
        assert_eq!(link.reference, Reference::Name("雨夜".into()));
        assert_eq!(
            link.lines,
            Some(Lines {
                start: 12,
                end: Some(18)
            })
        );
        assert!(link.explicit && link.book.is_none());

        let link = parse(
            "drifting-next-dev://open/book-1/chapters/id-node-rain/prose.md#L3",
            OS,
        )
        .unwrap();
        assert_eq!(link.book.as_deref(), Some("book-1"));
        assert_eq!(link.reference, Reference::Id("node-rain".into()));
        assert_eq!(
            link.lines,
            Some(Lines {
                start: 3,
                end: None
            })
        );
        // The release scheme's operating-system form still parses as ours.
        assert!(parse("drifting://open/b/drifts/id-a/prose.md", OS).is_some());

        let link = parse("../../chapters/id-node%2Drain/prose.md#L5-7", OS).unwrap();
        assert_eq!(link.reference, Reference::Id("node-rain".into()));
        assert_eq!(link.lines.unwrap().end, Some(7));
        assert!(!link.explicit);

        let link = parse("/elements/人物/伊莱亚斯/body.md", OS).unwrap();
        assert_eq!(link.reference, Reference::Name("伊莱亚斯".into()));
        assert!(parse("project/storylines/id-s1/index.md", OS).is_some());
        let link = parse("drifting:chapters/%E9%9B%A8%E5%A4%9C/prose.md#l4", OS).unwrap();
        assert_eq!(link.reference, Reference::Name("雨夜".into()));
        assert_eq!(link.lines.unwrap().start, 4);
        // Equal ends collapse to one line.
        let link = parse("drifting:chapters/a/prose.md#L3-L3", OS).unwrap();
        assert_eq!(link.lines.unwrap().end, None);
    }

    #[test]
    fn rejects_ordinary_and_malformed_links() {
        for href in [
            "https://example.test/chapters/x/prose.md",
            "人物.md#伊莱亚斯",
            "chapters/雨夜",
            "drifting:chapters/雨夜/prose.md#第三段",
            "drifting:chapters/雨夜/prose.md#L5-L3",
            "drifting:chapters/雨夜/prose.md#L0",
            "drifting:comments/x/index.md",
            "drifting:chapters/a/b/prose.md",
            "drifting:chapters/../elements/x/prose.md",
            "drifting-next-dev:chapters/a/prose.md",
            "drifting:chapters/a/prose.md?x=1",
            "",
        ] {
            assert_eq!(parse(href, OS), None, "{href}");
        }
    }

    #[test]
    fn lines_map_to_blocks_like_the_projection() {
        let blocks: Vec<u32> = (1..=5).map(line_to_block).collect();
        assert_eq!(blocks, [0, 0, 1, 1, 2]);
    }

    struct Book;

    impl Catalog for Book {
        fn book_id(&self) -> Option<&str> {
            Some("book-1")
        }
        fn by_name(&self, group: Group, name: &str) -> Vec<Target> {
            let chapter = |id: &str| Target::Chapter(NodeId::parse(id).unwrap());
            match (group, name) {
                (Group::Chapters, "雨夜") => vec![chapter("rain")],
                (Group::Chapters, "双生") => vec![chapter("a"), chapter("b")],
                _ => vec![],
            }
        }
        fn by_id(&self, group: Group, id: &str) -> Option<Target> {
            (group == Group::Elements && id == "elias")
                .then(|| Target::Element(ElementId::parse("elias").unwrap()))
        }
    }

    #[test]
    fn resolves_names_and_ids_and_says_why_not() {
        let rain = parse("drifting:chapters/雨夜/prose.md#L3", OS).unwrap();
        let (target, lines) = resolve(&rain, &Book).unwrap();
        assert_eq!(target, Target::Chapter(NodeId::parse("rain").unwrap()));
        assert_eq!(lines.unwrap().start, 3);
        let elias = parse("drifting:elements/id-elias/prose.md", OS).unwrap();
        assert!(matches!(
            resolve(&elias, &Book),
            Ok((Target::Element(_), None))
        ));
        let twins = parse("drifting:chapters/双生/prose.md", OS).unwrap();
        assert_eq!(
            resolve(&twins, &Book),
            Err(LinkError::Ambiguous(Group::Chapters, "双生".into(), 2))
        );
        let none = parse("drifting:chapters/晴天/prose.md", OS).unwrap();
        assert!(matches!(
            resolve(&none, &Book),
            Err(LinkError::NotFound(..))
        ));
        let other = parse(&format!("{OS}://open/other/chapters/雨夜/prose.md"), OS).unwrap();
        assert_eq!(
            resolve(&other, &Book),
            Err(LinkError::OtherBook("other".into()))
        );
    }
}
