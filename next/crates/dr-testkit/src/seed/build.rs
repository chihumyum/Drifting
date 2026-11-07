//! Writing a seeded book through dr-doc: the book document and one prose
//! document per body, all with deterministic peers (dr-doc's import peer)
//! and commit timestamps, so the same preset and seed give byte-identical
//! documents.

use std::collections::BTreeMap;

use dr_doc::book::{BookDoc, BookTxn};
use dr_doc::peer::import_peer;
use dr_doc::prose::ProseDoc;
use dr_doc::{DocError, Result};
use dr_model::book::{BlockSnapshot, EntityRef, KvEntry};
use dr_model::id::*;
use dr_model::kind::*;
use dr_model::pos::PosKey;
use dr_model::prose::{BlockAttrs, EntityLink};
use dr_model::{Day, DocId, Origin, Timestamp};

use crate::rng::Rng;
use crate::text::{self, BodyShape, Para};

/// Seed time zero: 2025-11-01T12:26:40Z, in seconds (Loro's and the book
/// document's unit). Every timestamp of a seed is this plus a fixed offset.
pub const T0: i64 = 1_762_000_000;

/// One seeded book: its documents and what went into them.
pub struct SeededBook {
    pub book: BookDoc,
    /// Every prose document (chapters, ideas, element bodies, storyline and
    /// category descriptions, material notes), in creation order.
    pub prose: Vec<ProseDoc>,
    /// Body texts by group, in creation order (what the shape and the corpus
    /// fingerprint are computed from).
    pub(crate) groups: BTreeMap<&'static str, Vec<String>>,
    pub(crate) counters: Counters,
}

impl SeededBook {
    pub fn book_id(&self) -> &BookId {
        self.book.book_id()
    }
}

/// Things the shape reports besides body sizes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Counters {
    pub entity_links: usize,
    pub headings: [usize; 3],
    pub tasks: usize,
}

/// Builds one book: the book document plus prose documents.
pub(crate) struct Builder {
    pub book: BookDoc,
    pub prose: Vec<ProseDoc>,
    pub groups: BTreeMap<&'static str, Vec<String>>,
    pub counters: Counters,
    clock: i64,
}

impl Builder {
    pub fn new(book_id: BookId) -> Result<Self> {
        let doc_id = DocId::Book(book_id.clone()).to_string();
        Ok(Self {
            book: BookDoc::create(book_id, import_peer(&doc_id))?,
            prose: Vec::new(),
            groups: BTreeMap::new(),
            counters: Counters::default(),
            clock: T0,
        })
    }

    /// The next commit timestamp (one second apart).
    pub fn tick(&mut self) -> i64 {
        self.clock += 1;
        self.clock
    }

    /// One commit to the book document.
    pub fn edit_book(&mut self, f: impl FnOnce(&mut BookTxn<'_>) -> Result<()>) -> Result<()> {
        let ts = self.tick();
        let (r, _) = self.book.edit_at(Origin::Import, Some(ts), f);
        r
    }

    /// Write a prose document from paragraphs and record its text under
    /// `group`. `targets[i]` is what name `i` of the body links to.
    pub fn prose(
        &mut self,
        group: &'static str,
        doc_id: DocId,
        paras: &[Para],
        targets: &[EntityRef],
    ) -> Result<usize> {
        let ts = self.tick();
        let (doc, counters) = write_prose(doc_id, paras, targets, ts)?;
        self.counters.entity_links += counters.entity_links;
        for (a, b) in self.counters.headings.iter_mut().zip(counters.headings) {
            *a += b;
        }
        self.counters.tasks += counters.tasks;
        self.groups
            .entry(group)
            .or_default()
            .push(text::plain(paras));
        self.prose.push(doc);
        Ok(self.prose.len() - 1)
    }

    /// Record a body that lives in the book document (comments, TODOs).
    pub fn record(&mut self, group: &'static str, body: String) {
        self.groups.entry(group).or_default().push(body);
    }

    pub fn finish(self) -> SeededBook {
        SeededBook {
            book: self.book,
            prose: self.prose,
            groups: self.groups,
            counters: self.counters,
        }
    }
}

/// A prose document holding `paras`, written in one commit at `ts`.
pub(crate) fn write_prose(
    doc_id: DocId,
    paras: &[Para],
    targets: &[EntityRef],
    ts: i64,
) -> Result<(ProseDoc, Counters)> {
    let peer = import_peer(&doc_id.to_string());
    let mut doc = ProseDoc::create(doc_id, peer)?;
    let mut counters = Counters::default();
    let body = text::plain(paras);
    let (r, _) = doc.edit_at(Origin::Import, Some(ts), |t| {
        if body.is_empty() {
            return Ok(());
        }
        t.insert_paragraphs(0, &body)?;
        let blocks = t.view().blocks();
        let mut start = 0usize;
        for (p, b) in paras.iter().zip(&blocks) {
            if let Some(h) = p.heading {
                t.set_heading(b.newline, Some(h))?;
                counters.headings[h.level() as usize - 1] += 1;
            }
            if p.task.is_some() || p.list.is_some() || p.quote {
                t.set_block_attrs(
                    b.newline,
                    &BlockAttrs {
                        heading: p.heading,
                        quote: p.quote,
                        list: if p.task.is_some() {
                            Some(ListKind::Task)
                        } else {
                            p.list.clone()
                        },
                        checked: p.task.unwrap_or(false),
                        ..BlockAttrs::default()
                    },
                )?;
                counters.tasks += usize::from(p.task.is_some());
            }
            for (range, style) in &p.styles {
                t.set_style(start + range.start..start + range.end, style)?;
            }
            for l in &p.links {
                let target = targets.get(l.target).ok_or(DocError::Missing {
                    collection: "link targets",
                    id: l.target.to_string(),
                })?;
                t.link_entity(
                    start + l.start..start + l.start + l.len,
                    &EntityLink {
                        target: target.id.clone(),
                        kind: target.kind.clone(),
                        block: None,
                        end_block: None,
                    },
                )?;
                counters.entity_links += 1;
            }
            start += p.text.chars().count() + 1;
        }
        Ok(())
    });
    r?;
    Ok((doc, counters))
}

/// A deterministic id of `kind` number `index` in book `book`.
pub(crate) fn id(seed: u64, book: &str, kind: &str, index: usize) -> String {
    Rng::stream(seed, &format!("{book}/{kind}"), index as u64)
        .uuid7(((T0 + index as i64) * 1000) as u64)
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

/// The date `days` days before the seed's day zero, as `YYYY-MM-DD`.
pub(crate) fn day_before_t0(days: i64) -> Day {
    let z = T0.div_euclid(86_400) - days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    Day::parse(&format!("{y:04}-{m:02}-{d:02}")).expect("valid date")
}

/// `n` fractional positions in order.
pub(crate) fn positions(n: usize) -> Vec<PosKey> {
    let mut out = Vec::with_capacity(n);
    let mut k = PosKey::first();
    for _ in 0..n {
        out.push(k.clone());
        k = k.after();
    }
    out
}

const COLORS: &[&str] = &[
    "#9B6A4F", "#5C7FA3", "#6E8B5E", "#7A6A96", "#B07A3B", "#9B4D5A", "#5F7D74", "#8A7F4E",
];
const CATEGORY_NAMES: &[&str] = &[
    "人物", "地点", "物件", "组织", "事件", "传闻", "船只", "文书", "天气", "职位", "家族", "街巷",
    "器物", "记号", "岛屿", "航线",
];
const STORYLINE_NAMES: &[&str] = &["灯塔", "档案", "返航", "旧案", "潮汐", "来信"];
const ACT_NAMES: &[&str] = &["第一幕", "第二幕", "第三幕", "第四幕", "第五幕", "第六幕"];

/// A synthetic preset's book (everything but the showcase).
pub(crate) fn synthetic(spec: &super::Spec, preset: &str, seed: u64) -> Result<SeededBook> {
    use super::preset::allocate;
    let book_key = format!("{preset}/0");
    let book_id = BookId::parse(&id(seed, &book_key, "book", 0)).expect("valid id");
    let mut b = Builder::new(book_id.clone())?;
    let bk = book_key.as_str();
    let lengths = |name: &str, budget: &super::Budget| {
        allocate(
            budget,
            &mut Rng::stream(seed, &format!("{bk}/lengths/{name}"), 0),
        )
    };

    // Ids first: bodies link to elements, chapters name storylines.
    let storylines: Vec<StorylineId> = (0..spec.storylines.count)
        .map(|i| storyline_id(seed, bk, i))
        .collect();
    let categories: Vec<CategoryId> = (0..spec.categories.count)
        .map(|i| category_id(seed, bk, i))
        .collect();
    let elements: Vec<ElementId> = (0..spec.elements.count)
        .map(|i| element_id(seed, bk, i))
        .collect();
    let names = text::person_names(
        &mut Rng::stream(seed, &format!("{bk}/names"), 0),
        elements.len(),
    );
    let name_refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let element_refs: Vec<EntityRef> = elements
        .iter()
        .map(|e| EntityRef::new(EntityKind::Element, e.as_str()))
        .collect();
    let chapters: Vec<NodeId> = (0..spec.chapters.count)
        .map(|i| node_id(seed, bk, i))
        .collect();

    // Book meta, storylines, categories, elements.
    let meta_name = spec.book_name;
    b.edit_book(|t| {
        t.meta()
            .name(meta_name)?
            .summary("合成的测试书：文字由固定句库按随机种子拼成，不含任何真实书稿。")?
            .created_at(Some(Timestamp(T0)))?
            .word_target(Some(spec.chapters.total as i64))?
            .daily_word_target(Some(1_500))?;
        for (i, s) in storylines.iter().enumerate() {
            let pos = positions(storylines.len());
            t.storyline(s)?
                .name(STORYLINE_NAMES[i % STORYLINE_NAMES.len()])?
                .color(COLORS[i % COLORS.len()])?
                .summary("一条贯穿全书的线索。")?
                .pos(&pos[i])?;
        }
        for (i, c) in categories.iter().enumerate() {
            t.category(c)?
                .name(CATEGORY_NAMES[i % CATEGORY_NAMES.len()])?
                .color(COLORS[(i + 3) % COLORS.len()])?
                .layout(&CategoryLayout::Auto)?;
        }
        for (i, e) in elements.iter().enumerate() {
            let w = t.element(e)?;
            w.name(&names[i])?
                .summary(&format!("{}的要素小传。", names[i]))?
                .category(Some(&categories[i % categories.len()]))?
                .created_at(Some(Timestamp(T0 + i as i64)))?;
            if i.is_multiple_of(3) {
                w.add_alias(&format!("{}君", names[i]))?;
            }
            if i.is_multiple_of(4) {
                w.put_fact(&KvEntry {
                    id: KvEntryId::parse(&format!("fact-{i}")).expect("valid id"),
                    key: "初次出场".into(),
                    value: format!("第{}章", i % spec.chapters.count + 1),
                    pos: Some(PosKey::first()),
                })?;
            }
        }
        t.put_fact(&KvEntry {
            id: KvEntryId::parse("fact-book-setting").expect("valid id"),
            key: "背景".into(),
            value: "海边小镇，灯塔与档案室".into(),
            pos: Some(PosKey::first()),
        })?;
        Ok(())
    })?;

    for (i, s) in storylines.iter().enumerate() {
        let len = lengths("storylines", &spec.storylines)[i];
        let paras = text::body(
            &mut Rng::stream(seed, &format!("{bk}/storylines"), i as u64),
            len,
            BodyShape::default(),
        );
        b.prose("storylines", DocId::Storyline(s.clone()), &paras, &[])?;
    }
    let category_lengths = lengths("categories", &spec.categories);
    for (i, c) in categories.iter().enumerate() {
        let paras = text::body(
            &mut Rng::stream(seed, &format!("{bk}/categories"), i as u64),
            category_lengths[i],
            BodyShape::default(),
        );
        b.prose("categories", DocId::Category(c.clone()), &paras, &[])?;
    }
    let element_lengths = lengths("elements", &spec.elements);
    for (i, e) in elements.iter().enumerate() {
        let paras = text::body(
            &mut Rng::stream(seed, &format!("{bk}/elements"), i as u64),
            element_lengths[i],
            BodyShape::default(),
        );
        b.prose("elements", DocId::Element(e.clone()), &paras, &[])?;
    }

    // Relations between elements, one custom directed type.
    let rt = RelationTypeId::parse(&id(seed, bk, "relation-type", 0)).expect("valid id");
    let mut rel_rng = Rng::stream(seed, &format!("{bk}/relations"), 0);
    let mut pairs = std::collections::BTreeSet::new();
    let max_pairs = elements.len() * (elements.len() - 1);
    while pairs.len() < spec.relations.min(max_pairs) {
        let a = rel_rng.below(elements.len() as u64) as usize;
        let z = rel_rng.below(elements.len() as u64) as usize;
        if a != z {
            pairs.insert((a, z));
        }
    }
    b.edit_book(|t| {
        t.relation_type(&rt)?
            .name("影响")?
            .orientation(&RelationOrientation::Directed)?
            .source_role("影响者")?
            .target_role("被影响者")?
            .source_kinds(&[EntityKind::Element])?
            .target_kinds(&[EntityKind::Element])?;
        for (k, (a, z)) in pairs.iter().enumerate() {
            t.relation(&relation_id(seed, bk, k))?
                .ends(&element_refs[*a], &element_refs[*z])?
                .relation_type(&rt)?
                .created_at(Some(Timestamp(T0 + k as i64)))?;
        }
        Ok(())
    })?;

    // Acts and chapters, in book order 10, 20, 30, …
    let chapter_lengths = lengths("chapters", &spec.chapters);
    let per_act = spec.chapters.count.div_ceil(spec.acts.max(1));
    let mut chapter_rng = Rng::stream(seed, &format!("{bk}/chapter-meta"), 0);
    b.edit_book(|t| {
        for a in 0..spec.acts {
            let first = a * per_act;
            t.act(&act_id(seed, bk, a))?
                .name(ACT_NAMES[a % ACT_NAMES.len()])?
                .start_order((a > 0).then_some((first as f64 + 1.0) * 10.0 - 5.0))?;
        }
        for (i, c) in chapters.iter().enumerate() {
            let order = (i as f64 + 1.0) * 10.0;
            let s = &storylines[i % storylines.len()];
            let status = if i < spec.chapters.count / 5 {
                NodeStatus::Finished
            } else {
                NodeStatus::Draft
            };
            let w = t.node(c)?;
            w.kind(&NodeKind::Chapter)?
                .title(&format!(
                    "第{}章　{}",
                    i + 1,
                    chapter_rng.pick(text::HEADINGS)
                ))?
                .summary("本章梗概：一次寻访，一份尚待核对的记录。")?
                .book_order(Some(order))?
                .narrative_order(Some(order))?
                .status(&status)?
                .add_storyline(s)?
                .primary_storyline(Some(s))?
                .created_at(Some(Timestamp(T0 + i as i64)))?;
            if i.is_multiple_of(3) && storylines.len() > 1 {
                w.add_storyline(&storylines[(i + 1) % storylines.len()])?;
            }
        }
        for p in 0..spec.time_pins {
            let at = (p * spec.chapters.count / spec.time_pins.max(1)) as f64 * 10.0 + 5.0;
            t.time_pin(&time_pin_id(seed, bk, p))?
                .narrative_order(at)?
                .label(&format!("{}年前", spec.time_pins - p))?;
        }
        Ok(())
    })?;
    let first_chapter = b.prose.len();
    for (i, c) in chapters.iter().enumerate() {
        let paras = text::body(
            &mut Rng::stream(seed, &format!("{bk}/chapters"), i as u64),
            chapter_lengths[i],
            BodyShape {
                names: &name_refs,
                ..BodyShape::default()
            },
        );
        b.prose("chapters", DocId::Node(c.clone()), &paras, &element_refs)?;
    }

    // Ideas, in groups.
    let groups: Vec<DriftGroupId> = (0..spec.idea_groups)
        .map(|g| DriftGroupId::parse(&id(seed, bk, "drift-group", g)).expect("valid id"))
        .collect();
    let ideas: Vec<NodeId> = (0..spec.ideas.count)
        .map(|i| drift_id(seed, bk, i))
        .collect();
    let mut idea_rng = Rng::stream(seed, &format!("{bk}/idea-meta"), 0);
    b.edit_book(|t| {
        for (g, id) in groups.iter().enumerate() {
            t.drift_groups()
                .create(id.as_str(), None, &format!("构想组{}", g + 1))?;
        }
        for (i, n) in ideas.iter().enumerate() {
            let status = if i % 4 == 3 {
                NodeStatus::Resting
            } else {
                NodeStatus::Drifting
            };
            t.node(n)?
                .kind(&NodeKind::Drift)?
                .title(&format!("构想{}　{}", i + 1, idea_rng.pick(text::HEADINGS)))?
                .status(&status)?
                .group((!groups.is_empty()).then(|| &groups[i % groups.len()]))?
                .x((i % 10) as f64 * 240.0)?
                .y((i / 10) as f64 * 160.0)?
                .created_at(Some(Timestamp(T0 + i as i64)))?;
        }
        Ok(())
    })?;
    let idea_lengths = lengths("ideas", &spec.ideas);
    for (i, n) in ideas.iter().enumerate() {
        let paras = text::body(
            &mut Rng::stream(seed, &format!("{bk}/ideas"), i as u64),
            idea_lengths[i],
            BodyShape {
                names: &name_refs,
                ..BodyShape::default()
            },
        );
        b.prose("ideas", DocId::Node(n.clone()), &paras, &element_refs)?;
    }

    // Material notes, in folders.
    let folders: Vec<MaterialFolderId> = (0..spec.material_folders)
        .map(|f| MaterialFolderId::parse(&id(seed, bk, "material-folder", f)).expect("valid id"))
        .collect();
    let materials: Vec<MaterialId> = (0..spec.material_notes.count)
        .map(|i| material_id(seed, bk, i))
        .collect();
    let material_pos = positions(materials.len());
    b.edit_book(|t| {
        for (f, id) in folders.iter().enumerate() {
            t.material_folders()
                .create(id.as_str(), None, &format!("素材夹{}", f + 1))?;
        }
        for (i, m) in materials.iter().enumerate() {
            t.material(m)?
                .title(&format!("笔记{}", i + 1))?
                .kind(&MaterialKind::Text)?
                .folder((!folders.is_empty()).then(|| &folders[i % folders.len()]))?
                .pos(&material_pos[i])?
                .task_todos(i.is_multiple_of(2))?;
        }
        Ok(())
    })?;
    let note_lengths = lengths("materialNotes", &spec.material_notes);
    for (i, m) in materials.iter().enumerate() {
        let paras = text::body(
            &mut Rng::stream(seed, &format!("{bk}/materialNotes"), i as u64),
            note_lengths[i],
            BodyShape {
                tasks: true,
                ..BodyShape::default()
            },
        );
        b.prose("materialNotes", DocId::Material(m.clone()), &paras, &[])?;
    }

    // Comments and TODOs, anchored to chapter text.
    let todo_lengths = lengths("todos", &spec.todos);
    let comment_lengths = lengths("comments", &spec.comments);
    let mut anchor_rng = Rng::stream(seed, &format!("{bk}/anchors"), 0);
    let mut notes = Vec::new();
    for (k, (group, len)) in todo_lengths
        .iter()
        .map(|l| ("todos", *l))
        .chain(comment_lengths.iter().map(|l| ("comments", *l)))
        .enumerate()
    {
        let ci = anchor_rng.below(chapters.len() as u64) as usize;
        let view = b.prose[first_chapter + ci].view();
        let blocks = view.blocks();
        let block = &blocks[anchor_rng.below(blocks.len() as u64) as usize];
        let start = view.paragraph_start(block.newline);
        let para_len = block.newline - start;
        let (from, to) = if para_len > 2 {
            let n = anchor_rng.range(2, para_len.min(12));
            let from = start + anchor_rng.range(0, para_len - n);
            (from, from + n)
        } else {
            (start, start)
        };
        let quote = view.text_in(from..to)?;
        let snapshot = view.text_in(start..block.newline)?;
        let anchor = view.anchor(from..to);
        let paras = text::body(
            &mut Rng::stream(seed, &format!("{bk}/{group}"), k as u64),
            len,
            BodyShape::default(),
        );
        // A comment body is plain text: the generated heading, a colon,
        // then the paragraphs (the colon is no word, so the size is exact).
        let rest: Vec<&str> = paras[1..].iter().map(|p| p.text.as_str()).collect();
        let body = format!("{}：{}", paras[0].text, rest.join("\n"));
        debug_assert_eq!(text::words(&body), len);
        notes.push((
            group,
            chapters[ci].clone(),
            block.id.clone(),
            anchor,
            quote,
            snapshot,
            body,
        ));
    }
    let comment_ids: Vec<CommentId> = (0..notes.len()).map(|k| comment_id(seed, bk, k)).collect();
    b.edit_book(|t| {
        for (k, (group, chapter, block, anchor, quote, snapshot, body)) in notes.iter().enumerate()
        {
            let w = t.comment(&comment_ids[k])?;
            let kind = if *group == "todos" {
                CommentKind::Todo
            } else {
                CommentKind::Note
            };
            let resolved = k % 5 == 4;
            w.kind(&kind)?
                .author_kind(&CommentAuthorKind::User)?
                .status(if resolved {
                    &CommentStatus::Resolved
                } else {
                    &CommentStatus::Open
                })?
                .source(&CommentSource::Manual)?
                .target(Some(&EntityRef::new(EntityKind::Node, chapter.as_str())))?
                .target_block(block.as_ref())?
                .anchor(anchor.as_ref())?
                .quote(Some(quote))?
                .snapshots(&[BlockSnapshot {
                    block: block.clone(),
                    text: snapshot.clone(),
                }])?
                .body(body)?
                .created_at(Some(Timestamp(T0 + k as i64)))?
                .updated_at(Some(Timestamp(T0 + k as i64)))?
                .resolved_at(resolved.then_some(Timestamp(T0 + k as i64 + 60)))?;
            if *group == "todos" {
                w.priority(Some(
                    [
                        &CommentPriority::Low,
                        &CommentPriority::Med,
                        &CommentPriority::High,
                    ][k % 3],
                ))?;
            }
        }
        Ok(())
    })?;
    for (group, _, _, _, _, _, body) in notes {
        b.record(group, body);
    }

    // Writing days on one device, Project Memory.
    let device = DeviceKey::from_installation_id("dr-testkit-seed-device");
    let mut day_rng = Rng::stream(seed, &format!("{bk}/writing-days"), 0);
    b.edit_book(|t| {
        for d in 0..spec.writing_days {
            if day_rng.chance(0.3) {
                continue;
            }
            let words = day_rng.range(200, 4_000) as i64;
            t.writing_day(&device, &day_before_t0(d as i64), words)?;
        }
        t.memory(&memory_id(seed, bk, 0))?
            .kind(&MemoryKind::Preference)?
            .body("人名和地名以要素为准；叙述保持安静克制。")?
            .source(&MemorySource::Author)?
            .status(&MemoryStatus::Active)?;
        Ok(())
    })?;

    Ok(b.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_count_back_from_day_zero() {
        assert_eq!(day_before_t0(0).as_str(), "2025-11-01");
        assert_eq!(day_before_t0(1).as_str(), "2025-10-31");
        assert_eq!(day_before_t0(366).as_str(), "2024-10-31");
    }
}
