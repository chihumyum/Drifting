//! What the Stats tab knows of the page in front (M20): read off the main
//! thread through F3's queries, by the 0.1 client's `features/stats`.
//!
//! - a chapter or idea: its storyline, place and last change; paragraphs,
//!   sentences and dialogue; the elements its prose mentions;
//! - a storyline: its chapters by writing status, the elements its chapters
//!   mention most;
//! - an element: what mentions it and what its own text mentions;
//! - a category: how many of its elements appear in the prose, in how many
//!   chapters on average, which do not, and over which storylines;
//! - a material: a note's words and checklist or a file's type, size and
//!   dimensions, open comments, the materials it embeds, its relations;
//! - the whole book: the acts' share, chapters by writing status, every
//!   chapter's length.
//!
//! Mentions are the entity links in prose (`mention.list`); names come from
//! the book's lists, so a row always names something live.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use dr_workspace::commands::chapter::{ActList, ChapterList};
use dr_workspace::commands::comment::{CommentList, CommentListIn};
use dr_workspace::commands::element::{CategoryList, ElementList, ElementListIn};
use dr_workspace::commands::idea::{IdeaList, IdeaListIn};
use dr_workspace::commands::material::{AssetGet, AssetInfo, MaterialList, MaterialListIn};
use dr_workspace::commands::mention::{
    MentionInfo, MentionList, MentionListIn, ProseShapeIn, ProseShapeOp, ProseShapeOut,
};
use dr_workspace::commands::relation::{RelationList, RelationListIn};
use dr_workspace::commands::storyline::StorylineList;
use dr_workspace::commands::{BookIn, EntityIn, ListIn};
use dr_workspace::dto::{ActInfo, ChapterInfo, Target};
use dr_workspace::{Actor, NavTarget, Op, Workspace};

/// Elements a storyline's list shows before 「还有 N 个」.
pub const CORE_ELEMENTS: usize = 8;
/// Elements a category's 「未出场」 list shows.
pub const UNAPPEARED: usize = 20;

/// A row that opens what it names.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub target: NavTarget,
    pub name: String,
    /// Separate spans (mentions), or what the row counts.
    pub count: u32,
    /// Paragraphs that carry them.
    pub blocks: u32,
}

/// A chapter's or idea's readings.
#[derive(Clone, Debug, PartialEq)]
pub struct PageDetail {
    /// Its primary storyline.
    pub storyline: Option<(NavTarget, String)>,
    /// 1-based place in reading order (a chapter).
    pub number: Option<u32>,
    /// Its last change (Unix seconds).
    pub updated_at: Option<i64>,
    pub shape: ProseShapeOut,
    /// The elements its prose mentions, the most mentioned first.
    pub elements: Vec<Row>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StorylineDetail {
    pub chapters: u32,
    pub updated_at: Option<i64>,
    pub finished: u32,
    pub draft: u32,
    pub discarded: u32,
    /// The elements its chapters mention, the most mentioned first.
    pub core: Vec<Row>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ElementDetail {
    pub category: Option<(NavTarget, String)>,
    pub updated_at: Option<i64>,
    /// What mentions it (被引用).
    pub incoming: Vec<Row>,
    /// What its own text mentions (引用其他).
    pub outgoing: Vec<Row>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CategoryDetail {
    pub elements: u32,
    /// Elements mentioned from a chapter's or idea's prose.
    pub appeared: u32,
    /// Chapters and ideas per appeared element, on average.
    pub average: f32,
    pub unappeared: Vec<Row>,
    /// Appeared elements per primary storyline (`None`: outside every
    /// storyline), the most first.
    pub storylines: Vec<(Option<(NavTarget, String)>, u32)>,
}

/// A note material's own readings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoteShape {
    pub words: u64,
    pub tasks: u32,
    pub done: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MaterialDetail {
    /// `text`, `image` or `pdf`.
    pub kind: String,
    pub updated_at: Option<i64>,
    pub note: Option<NoteShape>,
    pub file: Option<AssetInfo>,
    pub open_comments: u32,
    /// Embedded materials: the row and its kind.
    pub embeds: Vec<(Row, String)>,
    pub related: Vec<Row>,
}

/// An act's share of the book.
#[derive(Clone, Debug, PartialEq)]
pub struct ActRow {
    pub id: String,
    pub name: String,
    /// Its stored colour (`#rrggbb`).
    pub color: Option<String>,
    /// Its chapters, in reading order.
    pub chapters: Vec<String>,
}

/// Chapters by writing status, as 0.1 derived it: a finished chapter is
/// done, a draft with no words is still to write.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Statuses {
    pub done: u32,
    pub draft: u32,
    pub todo: u32,
    pub discarded: u32,
}

impl Statuses {
    /// Chapters that are not discarded.
    pub fn active(&self) -> u32 {
        self.done + self.draft + self.todo
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct BookDetail {
    pub acts: Vec<ActRow>,
    pub statuses: Statuses,
    /// Live chapters in reading order: id and title.
    pub chapters: Vec<(String, String)>,
}

/// What [`load`] read: the page's name, its prose document (for its
/// snapshot history) and its readings.
#[derive(Clone, Debug, PartialEq)]
pub struct Loaded {
    pub name: String,
    pub doc: Option<String>,
    pub detail: Detail,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Detail {
    Page(PageDetail),
    Storyline(StorylineDetail),
    Element(ElementDetail),
    Category(CategoryDetail),
    Material(MaterialDetail),
    Book(BookDetail),
}

fn run<O: Op>(ws: &Workspace, input: O::Input) -> dr_workspace::Result<O::Output> {
    ws.run::<O>(&Actor::User, input).map(|o| o.output)
}

fn list() -> impl Fn(&str) -> ListIn {
    |book| ListIn {
        book: book.to_owned(),
        trashed: false,
    }
}

/// The last change of a prose document (Unix seconds).
fn edited(ws: &Workspace, doc: &str) -> Option<i64> {
    ws.library()
        .head(doc)
        .ok()
        .flatten()
        .map(|h| h.ts.div_euclid(1000))
}

/// Names of a book's live things, by entity reference.
struct Names {
    chapters: Vec<ChapterInfo>,
    ideas: HashMap<String, String>,
    elements: HashMap<String, (String, Option<String>)>,
    storylines: HashMap<String, String>,
    categories: HashMap<String, String>,
    materials: HashMap<String, (String, String)>,
}

impl Names {
    fn load(ws: &Workspace, book: &str) -> dr_workspace::Result<Names> {
        let l = list();
        let chapters = run::<ChapterList>(ws, l(book))?;
        let ideas = run::<IdeaList>(
            ws,
            IdeaListIn {
                book: book.to_owned(),
                group: None,
                trashed: false,
            },
        )?
        .into_iter()
        .map(|i| (i.id, i.title))
        .collect();
        let elements = run::<ElementList>(
            ws,
            ElementListIn {
                book: book.to_owned(),
                category: None,
                trashed: false,
            },
        )?
        .into_iter()
        .map(|e| (e.id, (e.name, e.category)))
        .collect();
        let storylines = run::<StorylineList>(ws, l(book))?
            .into_iter()
            .map(|s| (s.id, s.name))
            .collect();
        let categories = run::<CategoryList>(ws, l(book))?
            .into_iter()
            .map(|c| (c.id, c.name))
            .collect();
        let materials = run::<MaterialList>(
            ws,
            MaterialListIn {
                book: book.to_owned(),
                folder: None,
            },
        )?
        .into_iter()
        .map(|m| (m.id, (m.title, m.kind)))
        .collect();
        Ok(Names {
            chapters,
            ideas,
            elements,
            storylines,
            categories,
            materials,
        })
    }

    /// The page an entity reference opens and its name.
    fn named(&self, t: &Target) -> Option<(NavTarget, String)> {
        let id = t.id.as_str();
        Some(match t.kind.as_str() {
            "node" => match self.chapters.iter().find(|c| c.id == id) {
                Some(c) => (NavTarget::Chapter(id.parse().ok()?), c.title.clone()),
                None => (
                    NavTarget::Idea(id.parse().ok()?),
                    self.ideas.get(id)?.clone(),
                ),
            },
            "element" => (
                NavTarget::Element(id.parse().ok()?),
                self.elements.get(id)?.0.clone(),
            ),
            "storyline" => (
                NavTarget::Storyline(id.parse().ok()?),
                self.storylines.get(id)?.clone(),
            ),
            "category" => (
                NavTarget::Category(id.parse().ok()?),
                self.categories.get(id)?.clone(),
            ),
            "material" => (
                NavTarget::Material(id.parse().ok()?),
                self.materials.get(id)?.0.clone(),
            ),
            _ => return None,
        })
    }

    fn storyline(&self, id: Option<&str>) -> Option<(NavTarget, String)> {
        let id = id?;
        Some((
            NavTarget::Storyline(id.parse().ok()?),
            self.storylines.get(id)?.clone(),
        ))
    }
}

/// Rows by one end of the mentions (`to`: the targets, else the sources),
/// merged per row and the most mentioned first.
fn rows(names: &Names, mentions: &[MentionInfo], to: bool) -> Vec<Row> {
    let mut by: BTreeMap<String, Row> = BTreeMap::new();
    for m in mentions.iter().filter(|m| m.kind == "link") {
        let end = if to { &m.to } else { &m.from };
        let Some((target, name)) = names.named(end) else {
            continue;
        };
        let row = by.entry(target.key()).or_insert(Row {
            target,
            name,
            count: 0,
            blocks: 0,
        });
        row.count += m.count;
        row.blocks += m.blocks;
    }
    let mut out: Vec<Row> = by.into_values().collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then(a.name.cmp(&b.name)));
    out
}

fn mentions(
    ws: &Workspace,
    book: &str,
    from: Option<Target>,
    to: Option<Target>,
    to_kind: Option<&str>,
) -> dr_workspace::Result<Vec<MentionInfo>> {
    run::<MentionList>(
        ws,
        MentionListIn {
            book: book.to_owned(),
            from,
            to,
            to_kind: to_kind.map(str::to_owned),
            limit: None,
        },
    )
}

fn entity(kind: &str, id: &str) -> Target {
    Target {
        kind: kind.to_owned(),
        id: id.to_owned(),
    }
}

fn shape(ws: &Workspace, doc: &str) -> dr_workspace::Result<ProseShapeOut> {
    run::<ProseShapeOp>(
        ws,
        ProseShapeIn {
            doc: doc.to_owned(),
        },
    )
}

/// Chapters by derived status.
pub fn statuses<'a>(chapters: impl IntoIterator<Item = &'a ChapterInfo>) -> Statuses {
    let mut s = Statuses::default();
    for c in chapters {
        match c.status.as_str() {
            "finished" => s.done += 1,
            "discarded" => s.discarded += 1,
            _ if c.words == 0 => s.todo += 1,
            _ => s.draft += 1,
        }
    }
    s
}

/// The entity reference of a page (`None`: the whole book).
fn entity_of(target: &NavTarget) -> Option<Target> {
    Some(match target {
        NavTarget::Book => return None,
        NavTarget::Chapter(id) | NavTarget::Idea(id) => entity("node", id.as_str()),
        NavTarget::Storyline(id) => entity("storyline", id.as_str()),
        NavTarget::Element(id) => entity("element", id.as_str()),
        NavTarget::Category(id) => entity("category", id.as_str()),
        NavTarget::Material(id) => entity("material", id.as_str()),
    })
}

/// Reads what the Stats tab shows of `target` (call off the main thread).
/// `None` when the page is gone (or a file material's record is).
pub fn load(
    ws: &Workspace,
    book: &str,
    target: &NavTarget,
) -> dr_workspace::Result<Option<Loaded>> {
    let names = Names::load(ws, book)?;
    let entity = entity_of(target);
    let (name, doc) = match &entity {
        Some(e) => match names.named(e) {
            Some((_, name)) => (name, Some(format!("{}:{}", e.kind, e.id))),
            None => return Ok(None),
        },
        None => (String::new(), None),
    };
    let Some(detail) = read(ws, book, target, &names)? else {
        return Ok(None);
    };
    // A file material has no prose of its own (no history).
    let doc = doc.filter(|_| !matches!(&detail, Detail::Material(m) if m.kind != "text"));
    Ok(Some(Loaded { name, doc, detail }))
}

fn read(
    ws: &Workspace,
    book: &str,
    target: &NavTarget,
    names: &Names,
) -> dr_workspace::Result<Option<Detail>> {
    Ok(Some(match target {
        NavTarget::Chapter(id) | NavTarget::Idea(id) => {
            let id = id.to_string();
            let doc = format!("node:{id}");
            let chapter = names.chapters.iter().find(|c| c.id == id);
            let all = mentions(ws, book, Some(target_node(&id)), None, Some("element"))?;
            Detail::Page(PageDetail {
                storyline: names.storyline(chapter.and_then(|c| c.primary_storyline.as_deref())),
                number: chapter.and_then(|c| c.number),
                updated_at: chapter
                    .and_then(|c| c.updated_at)
                    .or_else(|| edited(ws, &doc)),
                shape: shape(ws, &doc)?,
                elements: rows(names, &all, true),
            })
        }
        NavTarget::Storyline(id) => {
            let id = id.to_string();
            let members: Vec<&ChapterInfo> = names
                .chapters
                .iter()
                .filter(|c| c.storylines.iter().any(|s| s == &id))
                .collect();
            let ids: BTreeSet<&str> = members.iter().map(|c| c.id.as_str()).collect();
            let s = statuses(members.iter().copied());
            // One indexed read per chapter (the book's whole reference table
            // is far more).
            let mut all: Vec<MentionInfo> = Vec::new();
            for id in &ids {
                all.extend(mentions(
                    ws,
                    book,
                    Some(entity("node", id)),
                    None,
                    Some("element"),
                )?);
            }
            Detail::Storyline(StorylineDetail {
                chapters: members.len() as u32,
                updated_at: edited(ws, &format!("storyline:{id}")),
                finished: s.done,
                draft: s.draft + s.todo,
                discarded: s.discarded,
                core: rows(names, &all, true),
            })
        }
        NavTarget::Element(id) => {
            let id = id.to_string();
            let category = names.elements.get(&id).and_then(|(_, c)| c.clone());
            let incoming = mentions(ws, book, None, Some(entity("element", &id)), None)?;
            let outgoing = mentions(ws, book, Some(entity("element", &id)), None, None)?;
            Detail::Element(ElementDetail {
                category: category.and_then(|c| {
                    Some((
                        NavTarget::Category(c.parse().ok()?),
                        names.categories.get(&c)?.clone(),
                    ))
                }),
                updated_at: edited(ws, &format!("element:{id}")),
                incoming: rows(names, &incoming, false),
                outgoing: rows(names, &outgoing, true),
            })
        }
        NavTarget::Category(id) => {
            let id = id.to_string();
            let members: Vec<(&String, &String)> = {
                let mut v: Vec<(&String, &String)> = names
                    .elements
                    .iter()
                    .filter(|(_, (_, c))| c.as_deref() == Some(id.as_str()))
                    .map(|(e, (name, _))| (e, name))
                    .collect();
                v.sort_by(|a, b| a.1.cmp(b.1).then(a.0.cmp(b.0)));
                v
            };
            let ids: BTreeSet<&str> = members.iter().map(|(e, _)| e.as_str()).collect();
            let primary: HashMap<&str, Option<&str>> = names
                .chapters
                .iter()
                .map(|c| (c.id.as_str(), c.primary_storyline.as_deref()))
                .collect();
            // Element → the chapters and ideas that mention it.
            let mut sources: BTreeMap<&str, BTreeSet<String>> = BTreeMap::new();
            // One indexed read per element.
            let mut all: Vec<MentionInfo> = Vec::new();
            for e in &ids {
                all.extend(mentions(ws, book, None, Some(entity("element", e)), None)?);
            }
            for m in all
                .iter()
                .filter(|m| m.kind == "link" && m.from.kind == "node")
            {
                if let Some(e) = ids.get(m.to.id.as_str()) {
                    sources.entry(e).or_default().insert(m.from.id.clone());
                }
            }
            let mut by_line: BTreeMap<Option<&str>, BTreeSet<&str>> = BTreeMap::new();
            for (e, nodes) in &sources {
                for n in nodes {
                    let line = primary.get(n.as_str()).copied().flatten();
                    by_line.entry(line).or_default().insert(e);
                }
            }
            let mut storylines: Vec<(Option<(NavTarget, String)>, u32)> = by_line
                .into_iter()
                .filter_map(|(line, els)| {
                    let named = match line {
                        Some(l) => Some(names.storyline(Some(l))?),
                        None => None,
                    };
                    Some((named, els.len() as u32))
                })
                .collect();
            storylines.sort_by_key(|l| std::cmp::Reverse(l.1));
            let appeared = sources.len() as u32;
            let unappeared = members
                .iter()
                .filter(|(e, _)| !sources.contains_key(e.as_str()))
                .filter_map(|(e, name)| {
                    Some(Row {
                        target: NavTarget::Element(e.parse().ok()?),
                        name: (*name).clone(),
                        count: 0,
                        blocks: 0,
                    })
                })
                .collect();
            Detail::Category(CategoryDetail {
                elements: members.len() as u32,
                appeared,
                average: if appeared > 0 {
                    sources.values().map(|s| s.len()).sum::<usize>() as f32 / appeared as f32
                } else {
                    0.0
                },
                unappeared,
                storylines,
            })
        }
        NavTarget::Material(id) => {
            let id = id.to_string();
            let info = run::<MaterialList>(
                ws,
                MaterialListIn {
                    book: book.to_owned(),
                    folder: None,
                },
            )?
            .into_iter()
            .find(|m| m.id == id);
            let Some(info) = info else {
                return Ok(None);
            };
            let doc = format!("material:{id}");
            let text = info.kind == "text";
            let shaped = if text { Some(shape(ws, &doc)?) } else { None };
            let note = shaped.as_ref().map(|s| NoteShape {
                words: ws
                    .library()
                    .doc_stats(&doc)
                    .ok()
                    .flatten()
                    .map_or(0, |d| d.words),
                tasks: s.tasks,
                done: s.done,
            });
            let file = match &info.asset {
                Some(a) => run::<AssetGet>(
                    ws,
                    EntityIn {
                        book: book.to_owned(),
                        id: a.clone(),
                    },
                )
                .ok(),
                None => None,
            };
            let open_comments = run::<CommentList>(
                ws,
                CommentListIn {
                    book: book.to_owned(),
                    kind: None,
                    status: Some("open".into()),
                    target: Some(entity("material", &id)),
                },
            )?
            .len() as u32;
            let embeds = shaped
                .iter()
                .flat_map(|s| &s.embeds)
                .filter_map(|m| {
                    let (title, kind) = names.materials.get(m)?;
                    Some((
                        Row {
                            target: NavTarget::Material(m.parse().ok()?),
                            name: title.clone(),
                            count: 1,
                            blocks: 1,
                        },
                        kind.clone(),
                    ))
                })
                .collect();
            let mut seen = BTreeSet::new();
            let related = run::<RelationList>(
                ws,
                RelationListIn {
                    book: book.to_owned(),
                    entity: Some(entity("material", &id)),
                    relation_type: None,
                },
            )?
            .into_iter()
            .filter(|r| r.from.kind == "material" && r.from.id == id && r.to.kind != "patch")
            .filter_map(|r| {
                let (target, name) = names.named(&r.to)?;
                seen.insert(target.key()).then_some(Row {
                    target,
                    name,
                    count: 0,
                    blocks: 0,
                })
            })
            .collect();
            Detail::Material(MaterialDetail {
                kind: info.kind,
                updated_at: if text { edited(ws, &doc) } else { None },
                note,
                file,
                open_comments,
                embeds,
                related,
            })
        }
        NavTarget::Book => {
            let acts: Vec<ActInfo> = run::<ActList>(
                ws,
                BookIn {
                    book: book.to_owned(),
                },
            )?;
            Detail::Book(BookDetail {
                acts: acts
                    .into_iter()
                    .map(|a| ActRow {
                        id: a.id,
                        name: a.name,
                        color: a.color,
                        chapters: a.chapters,
                    })
                    .collect(),
                statuses: statuses(&names.chapters),
                chapters: names
                    .chapters
                    .iter()
                    .map(|c| (c.id.clone(), c.title.clone()))
                    .collect(),
            })
        }
    }))
}

fn target_node(id: &str) -> Target {
    entity("node", id)
}
