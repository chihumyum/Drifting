//! Search results as the panel shows them, without GPUI: hits grouped by
//! what they are in (book order kept), the highlighted part of each
//! snippet, and where a hit jumps to.

use std::ops::Range;

use dr_workspace::NavTarget;
use dr_workspace::commands::prose::SearchHitInfo;

/// Where in its owner a hit is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Field {
    Title,
    Summary,
    Body,
    Description,
    Patch,
}

impl Field {
    fn parse(s: &str) -> Field {
        match s {
            "title" => Field::Title,
            "summary" => Field::Summary,
            "description" => Field::Description,
            "patch" => Field::Patch,
            _ => Field::Body,
        }
    }
}

/// What owns a group's text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Owner {
    Chapter,
    Idea,
    Element,
    Storyline,
    Category,
    Material,
}

impl Owner {
    fn parse(s: &str) -> Option<Owner> {
        Some(match s {
            "chapter" => Owner::Chapter,
            "idea" => Owner::Idea,
            "element" => Owner::Element,
            "storyline" => Owner::Storyline,
            "category" => Owner::Category,
            "material" => Owner::Material,
            _ => return None,
        })
    }

    /// The location-link group of its prose (materials have none).
    fn link_group(self) -> Option<&'static str> {
        Some(match self {
            Owner::Chapter => "chapters",
            Owner::Idea => "drifts",
            Owner::Element => "elements",
            Owner::Storyline => "storylines",
            Owner::Category => "categories",
            Owner::Material => return None,
        })
    }
}

/// One hit, ready to draw.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub field: Field,
    pub snippet: String,
    /// The match in `snippet`, in bytes.
    pub highlight: Range<usize>,
    /// The prose paragraph (body hits).
    pub paragraph: Option<u32>,
}

/// The hits in one owner, in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Group {
    pub owner: Owner,
    pub id: String,
    pub title: String,
    pub target: NavTarget,
    pub rows: Vec<Row>,
}

/// Where a choice goes: the page, and the location link of the passage
/// when it has one (the shell opens it through its navigation model).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Jump {
    pub target: NavTarget,
    pub link: Option<String>,
}

/// Byte range of the characters `start..start + len` of `s`.
pub fn char_range(s: &str, start: usize, len: usize) -> Range<usize> {
    let mut idx = s
        .char_indices()
        .map(|(i, _)| i)
        .chain(std::iter::once(s.len()));
    let from = idx.by_ref().nth(start).unwrap_or(s.len());
    let to = if len == 0 {
        from
    } else {
        idx.nth(len - 1).unwrap_or(s.len())
    };
    from..to
}

fn target(owner: Owner, id: &str) -> Option<NavTarget> {
    Some(match owner {
        Owner::Chapter => NavTarget::Chapter(id.parse().ok()?),
        Owner::Idea => NavTarget::Idea(id.parse().ok()?),
        Owner::Element => NavTarget::Element(id.parse().ok()?),
        Owner::Storyline => NavTarget::Storyline(id.parse().ok()?),
        Owner::Category => NavTarget::Category(id.parse().ok()?),
        Owner::Material => NavTarget::Material(id.parse().ok()?),
    })
}

/// Hits (in `book.search`'s order) grouped by owner; an owner's hits stay
/// together and the groups keep the order of their first hit.
pub fn group(hits: Vec<SearchHitInfo>) -> Vec<Group> {
    let mut groups: Vec<Group> = Vec::new();
    for h in hits {
        let Some(owner) = Owner::parse(&h.kind) else {
            continue;
        };
        let row = Row {
            field: Field::parse(&h.field),
            highlight: char_range(&h.snippet, h.snippet_match, h.match_len),
            snippet: h.snippet,
            paragraph: h.paragraph,
        };
        match groups
            .iter_mut()
            .find(|g| g.owner == owner && g.id == h.owner)
        {
            Some(g) => g.rows.push(row),
            None => {
                let Some(t) = target(owner, &h.owner) else {
                    continue;
                };
                groups.push(Group {
                    owner,
                    id: h.owner,
                    title: h.title,
                    target: t,
                    rows: vec![row],
                });
            }
        }
    }
    groups
}

/// The jump for a group's header (`row: None`) or one of its rows: a prose
/// hit goes to its paragraph (block N starts on line 2N+1).
pub fn jump(group: &Group, row: Option<&Row>) -> Jump {
    let link = group.owner.link_group().map(|g| {
        let lines = row
            .and_then(|r| r.paragraph)
            .map(|n| format!("#L{}", 2 * n + 1))
            .unwrap_or_default();
        format!("drifting:{g}/id-{}/prose.md{lines}", group.id)
    });
    Jump {
        target: group.target.clone(),
        link,
    }
}

/// One line of the result list: a group's header or one of its rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Line {
    Header(usize),
    Hit(usize, usize),
}

/// The list's lines, in order.
pub fn lines(groups: &[Group]) -> Vec<Line> {
    let mut out = Vec::new();
    for (g, group) in groups.iter().enumerate() {
        out.push(Line::Header(g));
        out.extend((0..group.rows.len()).map(|r| Line::Hit(g, r)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(
        kind: &str,
        owner: &str,
        field: &str,
        snippet: &str,
        at: usize,
        para: Option<u32>,
    ) -> SearchHitInfo {
        SearchHitInfo {
            doc: format!("node:{owner}"),
            kind: kind.into(),
            owner: owner.into(),
            title: format!("T{owner}"),
            field: field.into(),
            block_id: None,
            paragraph: para,
            offset: at,
            snippet: snippet.into(),
            snippet_match: at,
            match_len: 2,
        }
    }

    #[test]
    fn hits_group_by_owner_in_order() {
        let groups = group(vec![
            hit("chapter", "a", "title", "灯塔", 0, None),
            hit("chapter", "a", "body", "她看见灯塔亮了", 3, Some(4)),
            hit("element", "e", "patch", "灯塔守", 0, None),
            hit("unknown", "x", "body", "灯塔", 0, None),
        ]);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].rows.len(), 2);
        assert_eq!(groups[0].rows[1].field, Field::Body);
        let s = &groups[0].rows[1].snippet;
        assert_eq!(&s[groups[0].rows[1].highlight.clone()], "灯塔");
        assert_eq!(groups[1].owner, Owner::Element);
        assert_eq!(
            lines(&groups),
            [
                Line::Header(0),
                Line::Hit(0, 0),
                Line::Hit(0, 1),
                Line::Header(1),
                Line::Hit(1, 0)
            ]
        );
    }

    #[test]
    fn a_prose_hit_jumps_to_its_paragraph_through_a_location_link() {
        let groups = group(vec![hit("chapter", "a", "body", "灯塔", 0, Some(4))]);
        let j = jump(&groups[0], groups[0].rows.first());
        assert_eq!(
            j.link.as_deref(),
            Some("drifting:chapters/id-a/prose.md#L9")
        );
        assert_eq!(j.target, NavTarget::Chapter("a".parse().unwrap()));
        assert_eq!(
            jump(&groups[0], None).link.as_deref(),
            Some("drifting:chapters/id-a/prose.md")
        );
        let m = group(vec![hit("material", "m", "description", "灯塔", 0, None)]);
        assert_eq!(jump(&m[0], m[0].rows.first()).link, None);
    }

    #[test]
    fn char_ranges_are_byte_ranges() {
        assert_eq!(char_range("ab灯塔c", 2, 2), 2..8);
        assert_eq!(char_range("abc", 3, 0), 3..3);
        assert_eq!(char_range("abc", 1, 9), 1..3);
    }
}
