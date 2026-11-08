//! What the relations views show, worked out from F3's lists and the shell's
//! book snapshot, without GPUI: an entity's rows, the picker's candidates,
//! which relation types a pair of ends may take, the words for a type, and
//! a type's colour.

use dr_model::book::{EntityRef, RelationType, normalize_relation_type_name};
use dr_model::check::relation_ends;
use dr_model::id::RelationTypeId;
use dr_model::kind::{EntityKind, RelationOrientation};
use dr_shell::book::Book;
use dr_shell::nav::Target;
use dr_ui::sand;
use dr_ui::tokens::Rgb;
use dr_workspace::dto::{RelationInfo, RelationTypeInfo, Target as End};

/// The picker's candidates at most (0.1: `slice(0, 50)`).
pub const MAX_CANDIDATES: usize = 50;

/// One end of a relation: an F3 target (`node`, `element`, `category`,
/// `storyline`, `patch`, `comment`, `material`).
pub fn end(kind: &str, id: &str) -> End {
    End {
        kind: kind.to_owned(),
        id: id.to_owned(),
    }
}

fn same(a: &End, b: &End) -> bool {
    a.kind == b.kind && a.id == b.id
}

/// One relation as an entity's 「关联」 shows it: the other end, and
/// whether this entity is where it starts.
#[derive(Clone, Debug)]
pub struct Row {
    pub id: String,
    pub other: End,
    /// This entity → the other.
    pub outgoing: bool,
    pub relation_type: String,
}

impl Row {
    /// The relation's ends as stored (`from`, `to`).
    pub fn ends(&self, owner: &End) -> (End, End) {
        if self.outgoing {
            (owner.clone(), self.other.clone())
        } else {
            (self.other.clone(), owner.clone())
        }
    }
}

/// `owner`'s relations, newest first (ids are time-ordered, as in 0.1); a
/// relation from the entity to itself shows once, outgoing.
pub fn rows(owner: &End, relations: &[RelationInfo]) -> Vec<Row> {
    let mut out: Vec<Row> = relations
        .iter()
        .filter_map(|r| {
            if same(&r.from, owner) {
                Some(Row {
                    id: r.id.clone(),
                    other: r.to.clone(),
                    outgoing: true,
                    relation_type: r.relation_type.clone(),
                })
            } else if same(&r.to, owner) {
                Some(Row {
                    id: r.id.clone(),
                    other: r.from.clone(),
                    outgoing: false,
                    relation_type: r.relation_type.clone(),
                })
            } else {
                None
            }
        })
        .collect();
    out.sort_by(|a, b| b.id.cmp(&a.id));
    out
}

/// The kinds the picker filters by (0.1: 全部 / 要素 / 章节 / 分类 / 故事线;
/// 章节 holds the ideas too, both are `node`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Filter {
    #[default]
    All,
    Element,
    Node,
    Category,
    Storyline,
}

impl Filter {
    pub const ALL: [Filter; 5] = [
        Filter::All,
        Filter::Element,
        Filter::Node,
        Filter::Category,
        Filter::Storyline,
    ];

    fn takes(self, kind: &str) -> bool {
        match self {
            Filter::All => true,
            Filter::Element => kind == "element",
            Filter::Node => kind == "node",
            Filter::Category => kind == "category",
            Filter::Storyline => kind == "storyline",
        }
    }
}

/// How an end shows: the shell's page for it, its name, mark and colour.
#[derive(Clone, Debug, PartialEq)]
pub struct Shown {
    /// The page it opens; `None` for a kind without one here (a patch, a
    /// comment) or an end that is gone.
    pub target: Option<Target>,
    /// Its name; empty when it has none (the view says 「无标题章节」…).
    pub title: String,
    pub mark: sand::Kind,
    pub color: Option<Rgb>,
    /// Whether the book still has it.
    pub live: bool,
    /// An idea, not a chapter (both are `node`).
    pub idea: bool,
}

/// The shell's page for `end`: a node is a chapter or an idea, whichever
/// the book has.
pub fn target_of(book: &Book, end: &End) -> Option<Target> {
    let id = end.id.as_str();
    match end.kind.as_str() {
        "element" => id.parse().ok().map(Target::Element),
        "category" => id.parse().ok().map(Target::Category),
        "storyline" => id.parse().ok().map(Target::Storyline),
        "material" => id.parse().ok().map(Target::Material),
        "node" => {
            let chapter = id.parse().ok().map(Target::Chapter)?;
            if book.exists(&chapter) {
                return Some(chapter);
            }
            id.parse().ok().map(Target::Idea)
        }
        _ => None,
    }
}

/// How `end` shows on the page.
pub fn shown(book: &Book, end: &End) -> Shown {
    let target = target_of(book, end);
    let entry = target.as_ref().and_then(|t| book.entry(t));
    let idea = matches!(target, Some(Target::Idea(_)));
    match (&target, entry) {
        (Some(t), Some(e)) => Shown {
            target: Some(t.clone()),
            title: e.title.clone(),
            mark: e.mark,
            color: e.color,
            live: true,
            idea,
        },
        _ => {
            let mark = match target.as_ref() {
                Some(t) => book.mark(t).0,
                None if end.kind == "patch" => sand::Kind::Element,
                None => sand::Kind::All,
            };
            Shown {
                target: None,
                title: String::new(),
                mark,
                color: None,
                live: false,
                idea,
            }
        }
    }
}

/// One entity the picker offers.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub end: End,
    pub shown: Shown,
}

/// What the picker offers for `owner`: the book's elements, chapters and
/// ideas, categories and storylines (in that order, as 0.1), filtered by
/// kind and by a name containing `query` (any case), leaving out `owner`
/// and what it is already related to; at most [`MAX_CANDIDATES`].
pub fn candidates(
    book: &Book,
    owner: &End,
    linked: &[Row],
    filter: Filter,
    query: &str,
) -> Vec<Candidate> {
    let q = query.trim().to_lowercase();
    let mut all: Vec<End> = Vec::new();
    all.extend(book.elements.iter().map(|e| end("element", &e.id)));
    all.extend(book.chapters.iter().map(|c| end("node", &c.id)));
    all.extend(book.ideas.iter().map(|i| end("node", &i.id)));
    all.extend(book.categories.iter().map(|c| end("category", &c.id)));
    all.extend(book.storylines.iter().map(|s| end("storyline", &s.id)));
    all.into_iter()
        .filter(|e| filter.takes(&e.kind))
        .filter(|e| !same(e, owner) && !linked.iter().any(|r| same(&r.other, e)))
        .map(|e| Candidate {
            shown: shown(book, &e),
            end: e,
        })
        .filter(|c| q.is_empty() || c.shown.title.to_lowercase().contains(&q))
        .take(MAX_CANDIDATES)
        .collect()
}

/// `info` as dr-model's relation type, for its checks.
pub fn as_model(info: &RelationTypeInfo) -> Option<RelationType> {
    let kinds = |v: &[String]| v.iter().map(|k| EntityKind::parse(k)).collect::<Vec<_>>();
    Some(RelationType {
        id: RelationTypeId::parse(&info.id).ok()?,
        name: info.name.clone(),
        normalized_name: normalize_relation_type_name(&info.name),
        description: info.description.clone(),
        orientation: RelationOrientation::parse(&info.orientation),
        system_key: None,
        locked: info.locked,
        source_role: info.source_role.clone(),
        target_role: info.target_role.clone(),
        color: info.color.clone(),
        source_kinds: kinds(&info.source_kinds),
        target_kinds: kinds(&info.target_kinds),
    })
}

fn entity_ref(e: &End) -> EntityRef {
    EntityRef::new(EntityKind::parse(&e.kind), e.id.clone())
}

/// Whether a relation of type `t` may go from `from` to `to` (F3's own
/// check, dr-model's `relation_ends`).
pub fn fits(t: &RelationTypeInfo, from: &End, to: &End) -> bool {
    as_model(t).is_some_and(|m| relation_ends(&m, entity_ref(from), entity_ref(to)).is_ok())
}

/// The types a new relation between `owner` and `other` may take: from
/// `owner` to `other`, or the other way round when `reversed`.
pub fn options_for_pair<'a>(
    types: &'a [RelationTypeInfo],
    owner: &End,
    other: &End,
    reversed: bool,
) -> Vec<&'a RelationTypeInfo> {
    let (from, to) = if reversed {
        (other, owner)
    } else {
        (owner, other)
    };
    types.iter().filter(|t| fits(t, from, to)).collect()
}

/// The types `row` may change to: those its ends fit either way round.
pub fn options_for_row<'a>(
    types: &'a [RelationTypeInfo],
    owner: &End,
    row: &Row,
) -> Vec<&'a RelationTypeInfo> {
    let (from, to) = row.ends(owner);
    types
        .iter()
        .filter(|t| fits(t, &from, &to) || fits(t, &to, &from))
        .collect()
}

/// Whether changing `row` to type `t` turns it round (its ends fit `t` only
/// the other way).
pub fn needs_swap(t: &RelationTypeInfo, owner: &End, row: &Row) -> bool {
    let (from, to) = row.ends(owner);
    !fits(t, &from, &to) && fits(t, &to, &from)
}

/// Whether `row` can be turned round as it is: a directed type its ends fit
/// the other way too.
pub fn can_swap(t: &RelationTypeInfo, owner: &End, row: &Row) -> bool {
    let (from, to) = row.ends(owner);
    t.orientation == "directed" && fits(t, &to, &from)
}

/// The words a type shows: authored types verbatim, the built-in one in
/// the reader's language (0.1's `useRelationTypePresentation`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Words {
    pub name: String,
    pub source_role: String,
    pub target_role: String,
}

/// `t`'s words; `builtin` holds the reader's words for the built-in type.
pub fn words(t: &RelationTypeInfo, builtin: &Words) -> Words {
    if t.locked {
        builtin.clone()
    } else {
        Words {
            name: t.name.clone(),
            source_role: t.source_role.clone(),
            target_role: t.target_role.clone(),
        }
    }
}

/// The line under a type's name: 「源 → 目标」, or the symmetric one's
/// role through `symmetric` (「对称 · {{role}}」).
pub fn summary(t: &RelationTypeInfo, w: &Words, symmetric: impl Fn(&str) -> String) -> String {
    if t.orientation == "symmetric" {
        symmetric(&w.source_role)
    } else {
        format!("{} → {}", w.source_role, w.target_role)
    }
}

/// A relation type's colour as stored (the 0.1 picker's tokens, or any
/// `#RRGGBB`), resolved in the theme.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Paint {
    /// `hsl(var(--story-N))`, N 1–6 (index 0–5).
    Story(usize),
    /// `hsl(var(--ink-3))`.
    Ink3,
    Hex(u32),
}

/// The palette the colour row offers (0.1's `RELATION_TYPE_PALETTE`).
pub const PALETTE: [Paint; 7] = [
    Paint::Story(0),
    Paint::Story(1),
    Paint::Story(2),
    Paint::Story(3),
    Paint::Story(4),
    Paint::Story(5),
    Paint::Ink3,
];

impl Paint {
    /// The stored form (the 0.1 tokens, so a picked colour follows the
    /// theme and reads the same in 0.1's data).
    pub fn stored(self) -> String {
        match self {
            Paint::Story(i) => format!("hsl(var(--story-{}))", i + 1),
            Paint::Ink3 => "hsl(var(--ink-3))".to_owned(),
            Paint::Hex(v) => format!("#{v:06x}"),
        }
    }

    /// A stored colour; anything else is no colour.
    pub fn parse(stored: &str) -> Option<Paint> {
        let s: String = stored.chars().filter(|c| !c.is_whitespace()).collect();
        if let Some(hex) = s.strip_prefix('#') {
            return (hex.len() == 6)
                .then(|| u32::from_str_radix(hex, 16).ok())
                .flatten()
                .map(Paint::Hex);
        }
        let inner = s.strip_prefix("hsl(var(--")?.strip_suffix("))")?;
        if inner == "ink-3" {
            return Some(Paint::Ink3);
        }
        let n: usize = inner.strip_prefix("story-")?.parse().ok()?;
        (1..=6).contains(&n).then_some(Paint::Story(n - 1))
    }
}

/// The colour a type without one of its own takes, the same in every view
/// (0.1's `defaultRelationTypeColor`: a djb2-xor hash of the id's UTF-16
/// units over [`PALETTE`]).
pub fn default_paint(id: &str) -> Paint {
    let mut hash: i32 = 5381;
    for unit in id.encode_utf16() {
        hash = (hash.wrapping_shl(5)).wrapping_add(hash) ^ unit as i32;
    }
    PALETTE[(hash as i64).unsigned_abs() as usize % PALETTE.len()]
}

/// `t`'s colour: its own, or the default for its id.
pub fn paint_of(t: &RelationTypeInfo) -> Paint {
    t.color
        .as_deref()
        .and_then(Paint::parse)
        .unwrap_or_else(|| default_paint(&t.id))
}

/// How many relations each type has in the book.
pub fn usage(relations: &[RelationInfo], type_id: &str) -> usize {
    relations
        .iter()
        .filter(|r| r.relation_type == type_id)
        .count()
}

/// The entity kinds a type may start from, in the editor's order (0.1's
/// `ALL_ENTITY_KINDS`), and those it may end at (`STRUCTURAL_ENTITY_KINDS`).
pub const SOURCE_KINDS: [&str; 7] = [
    "node",
    "element",
    "patch",
    "category",
    "storyline",
    "comment",
    "material",
];
pub const TARGET_KINDS: [&str; 5] = ["node", "element", "patch", "category", "storyline"];

/// A type as the editor holds it while it is written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Draft {
    pub name: String,
    pub description: String,
    pub symmetric: bool,
    pub source_role: String,
    pub target_role: String,
    pub source_kinds: Vec<String>,
    pub target_kinds: Vec<String>,
}

impl Draft {
    /// A new type: directed, the default roles, every kind allowed (or the
    /// kinds of a pair being related).
    pub fn new(
        source_role: &str,
        target_role: &str,
        sources: Option<&[&str]>,
        targets: Option<&[&str]>,
    ) -> Draft {
        Draft {
            name: String::new(),
            description: String::new(),
            symmetric: false,
            source_role: source_role.to_owned(),
            target_role: target_role.to_owned(),
            source_kinds: sources
                .unwrap_or(&SOURCE_KINDS)
                .iter()
                .map(|k| k.to_string())
                .collect(),
            target_kinds: targets
                .unwrap_or(&TARGET_KINDS)
                .iter()
                .map(|k| k.to_string())
                .collect(),
        }
    }

    /// `t` as the editor starts it.
    pub fn of(t: &RelationTypeInfo) -> Draft {
        Draft {
            name: t.name.clone(),
            description: t.description.clone(),
            symmetric: t.orientation == "symmetric",
            source_role: t.source_role.clone(),
            target_role: t.target_role.clone(),
            source_kinds: t.source_kinds.clone(),
            target_kinds: t.target_kinds.clone(),
        }
    }

    /// Switch the direction (0.1: turning symmetric keeps the structural
    /// kinds either side had, on both sides).
    pub fn set_symmetric(&mut self, symmetric: bool) {
        self.symmetric = symmetric;
        if symmetric {
            let shared: Vec<String> = TARGET_KINDS
                .iter()
                .filter(|k| {
                    self.source_kinds.iter().any(|s| s == *k)
                        || self.target_kinds.iter().any(|s| s == *k)
                })
                .map(|k| k.to_string())
                .collect();
            self.source_kinds = shared.clone();
            self.target_kinds = shared;
        }
    }

    fn toggle(list: &mut Vec<String>, kind: &str) {
        if let Some(i) = list.iter().position(|k| k == kind) {
            list.remove(i);
        } else {
            list.push(kind.to_owned());
        }
    }

    /// Allow or stop `kind` at the start (both ends of a symmetric type).
    pub fn toggle_source(&mut self, kind: &str) {
        Self::toggle(&mut self.source_kinds, kind);
        if self.symmetric {
            self.target_kinds = self
                .source_kinds
                .iter()
                .filter(|k| TARGET_KINDS.contains(&k.as_str()))
                .cloned()
                .collect();
        }
    }

    /// Allow or stop `kind` at the end (both ends of a symmetric type).
    pub fn toggle_target(&mut self, kind: &str) {
        Self::toggle(&mut self.target_kinds, kind);
        if self.symmetric {
            self.source_kinds = self.target_kinds.clone();
        }
    }

    /// The roles as saved: a symmetric type has one role on both ends.
    pub fn roles(&self) -> (String, String) {
        let target = if self.symmetric {
            &self.source_role
        } else {
            &self.target_role
        };
        (self.source_role.clone(), target.clone())
    }

    /// The kinds as saved, in the editor's order.
    pub fn kinds(&self) -> (Vec<String>, Vec<String>) {
        let order = |list: &[String], all: &[&str]| -> Vec<String> {
            all.iter()
                .filter(|k| list.iter().any(|s| s == *k))
                .map(|k| k.to_string())
                .collect()
        };
        let sources = order(&self.source_kinds, &SOURCE_KINDS);
        let targets = if self.symmetric {
            order(&self.source_kinds, &TARGET_KINDS)
        } else {
            order(&self.target_kinds, &TARGET_KINDS)
        };
        (sources, targets)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(id: &str, orientation: &str, sources: &[&str], targets: &[&str]) -> RelationTypeInfo {
        RelationTypeInfo {
            id: id.into(),
            name: id.into(),
            description: String::new(),
            orientation: orientation.into(),
            source_role: "甲".into(),
            target_role: "乙".into(),
            source_kinds: sources.iter().map(|s| s.to_string()).collect(),
            target_kinds: targets.iter().map(|s| s.to_string()).collect(),
            color: None,
            locked: false,
        }
    }

    const T1: &str = "01900000-0000-7000-8000-000000000071";
    const T2: &str = "01900000-0000-7000-8000-000000000072";
    const T3: &str = "01900000-0000-7000-8000-000000000073";

    fn rel(id: &str, from: End, to: End, t: &str) -> RelationInfo {
        RelationInfo {
            id: id.into(),
            from,
            to,
            relation_type: t.into(),
        }
    }

    #[test]
    fn rows_are_newest_first_and_a_self_relation_shows_once() {
        let me = end("element", "a");
        let rels = [
            rel("r1", me.clone(), end("element", "b"), T1),
            rel("r3", end("node", "c"), me.clone(), T2),
            rel("r2", me.clone(), me.clone(), T1),
            rel("r4", end("element", "x"), end("element", "y"), T1),
        ];
        let r = rows(&me, &rels);
        let ids: Vec<&str> = r.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["r3", "r2", "r1"]);
        assert!(!r[0].outgoing && r[1].outgoing && r[2].outgoing);
        let (from, to) = r[0].ends(&me);
        assert_eq!((from.id.as_str(), to.id.as_str()), ("c", "a"));
    }

    #[test]
    fn types_fit_by_direction_and_kinds() {
        let a = end("element", "01900000-0000-7000-8000-0000000000e1");
        let b = end("element", "01900000-0000-7000-8000-0000000000e2");
        let ch = end("node", "01900000-0000-7000-8000-0000000000c1");
        let types = [
            info(T1, "directed", &["element"], &["node"]),
            info(T2, "symmetric", &["element"], &["element"]),
            info(T3, "directed", &["element", "node"], &["element", "node"]),
        ];
        let ids = |v: Vec<&RelationTypeInfo>| v.iter().map(|t| t.id.clone()).collect::<Vec<_>>();
        // element → chapter: the first and the third; chapter → element: the third.
        assert_eq!(ids(options_for_pair(&types, &a, &ch, false)), [T1, T3]);
        assert_eq!(ids(options_for_pair(&types, &a, &ch, true)), [T3]);
        assert_eq!(ids(options_for_pair(&types, &a, &b, false)), [T2, T3]);
        // A row chapter → element may take the first type, turned round.
        let row = Row {
            id: "r".into(),
            other: ch.clone(),
            outgoing: false,
            relation_type: T3.into(),
        };
        assert_eq!(ids(options_for_row(&types, &a, &row)), [T1, T3]);
        assert!(needs_swap(&types[0], &a, &row));
        assert!(!needs_swap(&types[2], &a, &row));
        assert!(can_swap(&types[2], &a, &row));
        assert!(can_swap(&types[0], &a, &row), "it fits turned round");
        assert!(
            !can_swap(&types[1], &a, &row),
            "a symmetric type has no way round"
        );
        // Nothing relates an entity to itself.
        assert!(!fits(&types[1], &a, &a));
    }

    #[test]
    fn colours_read_the_0_1_tokens_and_hex_and_default_by_id() {
        assert_eq!(Paint::parse("hsl(var(--story-3))"), Some(Paint::Story(2)));
        assert_eq!(Paint::parse(" hsl( var(--ink-3) ) "), Some(Paint::Ink3));
        assert_eq!(Paint::parse("#AaBbCc"), Some(Paint::Hex(0xaabbcc)));
        assert_eq!(Paint::parse("hsl(var(--story-7))"), None);
        assert_eq!(Paint::parse("red"), None);
        for p in PALETTE {
            assert_eq!(Paint::parse(&p.stored()), Some(p));
        }
        // 0.1: hash = ((hash << 5) + hash) ^ code, |hash| % 7, from 5381.
        let js = |id: &str| {
            let mut h: i32 = 5381;
            for c in id.encode_utf16() {
                h = h.wrapping_shl(5).wrapping_add(h) ^ c as i32;
            }
            (h as i64).unsigned_abs() as usize % 7
        };
        for id in ["rt", T1, T2, "关系"] {
            assert_eq!(default_paint(id), PALETTE[js(id)]);
        }
        let mut t = info(T1, "directed", &["element"], &["element"]);
        assert_eq!(paint_of(&t), default_paint(T1));
        t.color = Some("hsl(var(--story-1))".into());
        assert_eq!(paint_of(&t), Paint::Story(0));
    }

    #[test]
    fn the_draft_keeps_symmetric_kinds_on_both_sides() {
        let mut d = Draft::new("源端", "目标端", None, None);
        assert_eq!(d.source_kinds.len(), 7);
        assert_eq!(d.target_kinds.len(), 5);
        d.toggle_source("node");
        d.toggle_target("element");
        d.set_symmetric(true);
        // Structural kinds either side had, on both sides (node was still a
        // target, element still a source); comment and material go.
        assert_eq!(
            d.kinds().0,
            ["node", "element", "patch", "category", "storyline"]
        );
        assert_eq!(d.kinds().0, d.kinds().1);
        d.toggle_target("patch");
        assert_eq!(d.kinds().1, ["node", "element", "category", "storyline"]);
        assert_eq!(d.source_kinds, d.target_kinds);
        d.source_role = "对手".into();
        d.target_role = "别的".into();
        assert_eq!(d.roles(), ("对手".to_string(), "对手".to_string()));
        d.set_symmetric(false);
        assert_eq!(d.roles().1, "别的");
    }

    #[test]
    fn words_show_the_built_in_type_in_the_readers_language() {
        let builtin = Words {
            name: "关联".into(),
            source_role: "关联项".into(),
            target_role: "对象".into(),
        };
        let mut t = info(T1, "directed", &["comment"], &["element"]);
        assert_eq!(words(&t, &builtin).name, T1);
        t.locked = true;
        assert_eq!(words(&t, &builtin), builtin);
        let w = words(&t, &builtin);
        assert_eq!(summary(&t, &w, |r| format!("对称 · {r}")), "关联项 → 对象");
        t.orientation = "symmetric".into();
        assert_eq!(summary(&t, &w, |r| format!("对称 · {r}")), "对称 · 关联项");
    }
}
