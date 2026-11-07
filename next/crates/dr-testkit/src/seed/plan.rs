//! What a synthetic book holds, decided once: names, sizes, text, who links
//! to whom, where comments sit. Two writers consume a plan:
//!
//! - the **direct** writer ([`super::build::write_direct`]) writes dr-doc
//!   documents with deterministic ids, peers and timestamps (fast, byte for
//!   byte reproducible);
//! - the **command** writer ([`super::commands::write`]) runs F3's commands,
//!   so the command layer's invariants check the seed too.
//!
//! [`super::digest`] reads either result back into the same canonical form,
//! so the two can be compared.

use dr_model::Day;
use dr_model::id::*;
use dr_model::kind::NodeStatus;

use super::build::{day_before_t0, id};
use super::preset::{Budget, Spec, allocate};
use crate::rng::Rng;
use crate::text::{self, BodyShape, Para};

pub(crate) const COLORS: &[&str] = &[
    "#9B6A4F", "#5C7FA3", "#6E8B5E", "#7A6A96", "#B07A3B", "#9B4D5A", "#5F7D74", "#8A7F4E",
];
const CATEGORY_NAMES: &[&str] = &[
    "人物", "地点", "物件", "组织", "事件", "传闻", "船只", "文书", "天气", "职位", "家族", "街巷",
    "器物", "记号", "岛屿", "航线",
];
const STORYLINE_NAMES: &[&str] = &["灯塔", "档案", "返航", "旧案", "潮汐", "来信"];
const ACT_NAMES: &[&str] = &["第一幕", "第二幕", "第三幕", "第四幕", "第五幕", "第六幕"];

pub(crate) const BOOK_SUMMARY: &str =
    "合成的测试书：文字由固定句库按随机种子拼成，不含任何真实书稿。";
pub(crate) const STORYLINE_SUMMARY: &str = "一条贯穿全书的线索。";
pub(crate) const CHAPTER_SUMMARY: &str = "本章梗概：一次寻访，一份尚待核对的记录。";
pub(crate) const MEMORY: &str = "人名和地名以要素为准；叙述保持安静克制。";
pub(crate) const RELATION_TYPE: (&str, &str, &str) = ("影响", "影响者", "被影响者");

pub(crate) struct Named {
    pub name: String,
    pub color: String,
    pub summary: String,
    pub body: Vec<Para>,
}

pub(crate) struct Element {
    pub id: ElementId,
    pub name: String,
    pub summary: String,
    pub category: usize,
    pub aliases: Vec<String>,
    /// (key, value)
    pub facts: Vec<(String, String)>,
    pub body: Vec<Para>,
}

pub(crate) struct Chapter {
    pub id: NodeId,
    pub title: String,
    pub status: NodeStatus,
    /// The first is the primary storyline.
    pub storylines: Vec<usize>,
    /// Links point at elements by index.
    pub body: Vec<Para>,
}

pub(crate) struct Idea {
    pub id: NodeId,
    pub title: String,
    pub status: NodeStatus,
    pub group: Option<usize>,
    pub x: f64,
    pub y: f64,
    pub body: Vec<Para>,
}

pub(crate) struct Material {
    pub id: MaterialId,
    pub title: String,
    pub folder: Option<usize>,
    pub task_todos: bool,
    pub body: Vec<Para>,
}

pub(crate) struct Comment {
    pub id: CommentId,
    pub todo: bool,
    pub chapter: usize,
    /// The paragraph it sits on, by index in the chapter.
    pub para: usize,
    /// Characters `[from, to)` of the chapter's text.
    pub range: (usize, usize),
    pub quote: String,
    pub snapshot: String,
    pub body: String,
    pub resolved: bool,
    /// `low`, `med`, `high` (TODOs).
    pub priority: Option<&'static str>,
}

/// One synthetic book.
pub(crate) struct Plan {
    pub book: BookId,
    pub name: String,
    pub word_target: i64,
    pub daily_word_target: i64,
    /// (key, value)
    pub facts: Vec<(String, String)>,
    pub storylines: Vec<(StorylineId, Named)>,
    pub categories: Vec<(CategoryId, Named)>,
    pub elements: Vec<Element>,
    pub relation_type: RelationTypeId,
    /// (id, from, to): element indexes.
    pub relations: Vec<(RelationId, usize, usize)>,
    /// (id, name, first chapter index); the first act starts at the head.
    pub acts: Vec<(ActId, String, usize)>,
    pub chapters: Vec<Chapter>,
    /// (id, narrative order, label)
    pub time_pins: Vec<(TimePinId, f64, String)>,
    pub idea_groups: Vec<(DriftGroupId, String)>,
    pub ideas: Vec<Idea>,
    pub folders: Vec<(MaterialFolderId, String)>,
    pub materials: Vec<Material>,
    pub comments: Vec<Comment>,
    pub device: DeviceKey,
    pub writing_days: Vec<(Day, i64)>,
    pub memory: Vec<(MemoryId, String)>,
}

impl Plan {
    /// Book order of chapter `i`: 10, 20, 30, …
    pub fn order(i: usize) -> f64 {
        (i as f64 + 1.0) * 10.0
    }
}

macro_rules! typed_id {
    ($name:ident, $ty:ty) => {
        pub(crate) fn $name(seed: u64, book: &str, index: usize) -> $ty {
            <$ty>::parse(&id(seed, book, stringify!($name), index)).expect("valid id")
        }
    };
}
typed_id!(node_id, NodeId);
typed_id!(drift_id, NodeId);
typed_id!(element_id, ElementId);
typed_id!(storyline_id, StorylineId);
typed_id!(category_id, CategoryId);
typed_id!(material_id, MaterialId);
typed_id!(comment_id, CommentId);
typed_id!(relation_id, RelationId);
typed_id!(act_id, ActId);
typed_id!(time_pin_id, TimePinId);
typed_id!(memory_id, MemoryId);

/// The plan of a synthetic preset's book. Every random choice comes from
/// its own labelled stream (`Rng::stream`), so adding a kind of entity
/// leaves the others unchanged.
pub(crate) fn synthetic(spec: &Spec, preset: &str, seed: u64) -> Plan {
    let key = format!("{preset}/0");
    let bk = key.as_str();
    let lengths = |name: &str, budget: &Budget| {
        allocate(
            budget,
            &mut Rng::stream(seed, &format!("{bk}/lengths/{name}"), 0),
        )
    };
    let body = |label: &str, i: usize, words: usize, shape: BodyShape<'_>| {
        text::body(
            &mut Rng::stream(seed, &format!("{bk}/{label}"), i as u64),
            words,
            shape,
        )
    };

    let storyline_lengths = lengths("storylines", &spec.storylines);
    let storylines = (0..spec.storylines.count)
        .map(|i| {
            (
                storyline_id(seed, bk, i),
                Named {
                    name: STORYLINE_NAMES[i % STORYLINE_NAMES.len()].into(),
                    color: COLORS[i % COLORS.len()].into(),
                    summary: STORYLINE_SUMMARY.into(),
                    body: body("storylines", i, storyline_lengths[i], BodyShape::default()),
                },
            )
        })
        .collect();
    let category_lengths = lengths("categories", &spec.categories);
    let categories = (0..spec.categories.count)
        .map(|i| {
            (
                category_id(seed, bk, i),
                Named {
                    name: CATEGORY_NAMES[i % CATEGORY_NAMES.len()].into(),
                    color: COLORS[(i + 3) % COLORS.len()].into(),
                    summary: String::new(),
                    body: body("categories", i, category_lengths[i], BodyShape::default()),
                },
            )
        })
        .collect();
    let names = text::person_names(
        &mut Rng::stream(seed, &format!("{bk}/names"), 0),
        spec.elements.count,
    );
    let name_refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let element_lengths = lengths("elements", &spec.elements);
    let elements = (0..spec.elements.count)
        .map(|i| Element {
            id: element_id(seed, bk, i),
            name: names[i].clone(),
            summary: format!("{}的要素小传。", names[i]),
            category: i % spec.categories.count,
            aliases: if i.is_multiple_of(3) {
                vec![format!("{}君", names[i])]
            } else {
                Vec::new()
            },
            facts: if i.is_multiple_of(4) {
                vec![(
                    "初次出场".into(),
                    format!("第{}章", i % spec.chapters.count + 1),
                )]
            } else {
                Vec::new()
            },
            body: body("elements", i, element_lengths[i], BodyShape::default()),
        })
        .collect();

    let mut rel_rng = Rng::stream(seed, &format!("{bk}/relations"), 0);
    let mut pairs = std::collections::BTreeSet::new();
    let n = spec.elements.count;
    while pairs.len() < spec.relations.min(n * (n - 1)) {
        let a = rel_rng.below(n as u64) as usize;
        let z = rel_rng.below(n as u64) as usize;
        if a != z {
            pairs.insert((a, z));
        }
    }

    let per_act = spec.chapters.count.div_ceil(spec.acts.max(1));
    let acts = (0..spec.acts)
        .map(|a| {
            (
                act_id(seed, bk, a),
                ACT_NAMES[a % ACT_NAMES.len()].to_string(),
                a * per_act,
            )
        })
        .collect();
    let chapter_lengths = lengths("chapters", &spec.chapters);
    let mut chapter_rng = Rng::stream(seed, &format!("{bk}/chapter-meta"), 0);
    let ns = spec.storylines.count;
    let chapters: Vec<Chapter> = (0..spec.chapters.count)
        .map(|i| {
            let mut lines = vec![i % ns];
            if i.is_multiple_of(3) && ns > 1 {
                lines.push((i + 1) % ns);
            }
            Chapter {
                id: node_id(seed, bk, i),
                title: format!("第{}章　{}", i + 1, chapter_rng.pick(text::HEADINGS)),
                status: if i < spec.chapters.count / 5 {
                    NodeStatus::Finished
                } else {
                    NodeStatus::Draft
                },
                storylines: lines,
                body: body(
                    "chapters",
                    i,
                    chapter_lengths[i],
                    BodyShape {
                        names: &name_refs,
                        ..BodyShape::default()
                    },
                ),
            }
        })
        .collect();
    let time_pins = (0..spec.time_pins)
        .map(|p| {
            (
                time_pin_id(seed, bk, p),
                (p * spec.chapters.count / spec.time_pins.max(1)) as f64 * 10.0 + 5.0,
                format!("{}年前", spec.time_pins - p),
            )
        })
        .collect();

    let idea_groups: Vec<(DriftGroupId, String)> = (0..spec.idea_groups)
        .map(|g| {
            (
                DriftGroupId::parse(&id(seed, bk, "drift-group", g)).expect("valid id"),
                format!("构想组{}", g + 1),
            )
        })
        .collect();
    let idea_lengths = lengths("ideas", &spec.ideas);
    let mut idea_rng = Rng::stream(seed, &format!("{bk}/idea-meta"), 0);
    let ideas = (0..spec.ideas.count)
        .map(|i| Idea {
            id: drift_id(seed, bk, i),
            title: format!("构想{}　{}", i + 1, idea_rng.pick(text::HEADINGS)),
            status: if i % 4 == 3 {
                NodeStatus::Resting
            } else {
                NodeStatus::Drifting
            },
            group: (!idea_groups.is_empty()).then(|| i % idea_groups.len()),
            x: (i % 10) as f64 * 240.0,
            y: (i / 10) as f64 * 160.0,
            body: body(
                "ideas",
                i,
                idea_lengths[i],
                BodyShape {
                    names: &name_refs,
                    ..BodyShape::default()
                },
            ),
        })
        .collect();

    let folders: Vec<(MaterialFolderId, String)> = (0..spec.material_folders)
        .map(|f| {
            (
                MaterialFolderId::parse(&id(seed, bk, "material-folder", f)).expect("valid id"),
                format!("素材夹{}", f + 1),
            )
        })
        .collect();
    let note_lengths = lengths("materialNotes", &spec.material_notes);
    let materials = (0..spec.material_notes.count)
        .map(|i| Material {
            id: material_id(seed, bk, i),
            title: format!("笔记{}", i + 1),
            folder: (!folders.is_empty()).then(|| i % folders.len()),
            task_todos: i.is_multiple_of(2),
            body: body(
                "materialNotes",
                i,
                note_lengths[i],
                BodyShape {
                    tasks: true,
                    ..BodyShape::default()
                },
            ),
        })
        .collect();

    // Comments and TODOs on a random passage of a random chapter.
    let todo_lengths = lengths("todos", &spec.todos);
    let comment_lengths = lengths("comments", &spec.comments);
    let mut anchor_rng = Rng::stream(seed, &format!("{bk}/anchors"), 0);
    let mut comments = Vec::new();
    for (k, (todo, len)) in todo_lengths
        .iter()
        .map(|l| (true, *l))
        .chain(comment_lengths.iter().map(|l| (false, *l)))
        .enumerate()
    {
        let group = if todo { "todos" } else { "comments" };
        let ci = anchor_rng.below(chapters.len() as u64) as usize;
        let paras = &chapters[ci].body;
        let pi = anchor_rng.below(paras.len() as u64) as usize;
        let start: usize = paras[..pi].iter().map(|p| p.text.chars().count() + 1).sum();
        let para: Vec<char> = paras[pi].text.chars().collect();
        let (from, to) = if para.len() > 2 {
            let n = anchor_rng.range(2, para.len().min(12));
            let from = anchor_rng.range(0, para.len() - n);
            (from, from + n)
        } else {
            (0, 0)
        };
        // A comment body is plain text: the generated heading, a colon,
        // then the paragraphs (the colon is no word, so the size is exact).
        let b = body(group, k, len, BodyShape::default());
        let rest: Vec<&str> = b[1..].iter().map(|p| p.text.as_str()).collect();
        let text = format!("{}：{}", b[0].text, rest.join("\n"));
        debug_assert_eq!(text::words(&text), len);
        comments.push(Comment {
            id: comment_id(seed, bk, k),
            todo,
            chapter: ci,
            para: pi,
            range: (start + from, start + to),
            quote: para[from..to].iter().collect(),
            snapshot: paras[pi].text.clone(),
            body: text,
            resolved: k % 5 == 4,
            priority: todo.then(|| ["low", "med", "high"][k % 3]),
        });
    }

    let mut day_rng = Rng::stream(seed, &format!("{bk}/writing-days"), 0);
    let mut writing_days = Vec::new();
    for d in 0..spec.writing_days {
        if day_rng.chance(0.3) {
            continue;
        }
        writing_days.push((day_before_t0(d as i64), day_rng.range(200, 4_000) as i64));
    }

    Plan {
        book: BookId::parse(&id(seed, bk, "book", 0)).expect("valid id"),
        name: spec.book_name.into(),
        word_target: spec.chapters.total as i64,
        daily_word_target: 1_500,
        facts: vec![("背景".into(), "海边小镇，灯塔与档案室".into())],
        storylines,
        categories,
        elements,
        relation_type: RelationTypeId::parse(&id(seed, bk, "relation-type", 0)).expect("valid id"),
        relations: pairs
            .into_iter()
            .enumerate()
            .map(|(k, (a, z))| (relation_id(seed, bk, k), a, z))
            .collect(),
        acts,
        chapters,
        time_pins,
        idea_groups,
        ideas,
        folders,
        materials,
        comments,
        device: DeviceKey::from_installation_id("dr-testkit-seed-device"),
        writing_days,
        memory: vec![(memory_id(seed, bk, 0), MEMORY.into())],
    }
}
