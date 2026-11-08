//! Laying a sample definition out as a book, as the 0.1 sample writer did.
//!
//! A definition is the 0.1 client's `SampleBook` exported as JSON, field
//! for field (`books/README.md`): chapters as blocks (a string is a
//! paragraph, an array of strings a letter set off as a block quote, `*…*`
//! italics, `**…**` bold), the outline around them, elements, relations,
//! notes and review items. Every id is fixed per sample ([`sample_id`]), so
//! the same sample is the same book in every library it is written into,
//! and the documents are byte-identical every time (dr-doc's import peer,
//! timestamps from [`crate::build::T0`]). Illustrations are listed in the
//! definitions but their image files are not copied yet.

use std::collections::{BTreeMap, BTreeSet};

use dr_doc::Result;
use dr_model::book::{EntityRef, KvEntry, canonical_symmetric};
use dr_model::id::*;
use dr_model::kind::*;
use dr_model::pos::PosKey;
use dr_model::prose::{Heading, InlineStyle};
use dr_model::{DocId, Timestamp};
use serde::Deserialize;

use crate::build::{self, Builder, SeededBook, T0};
use crate::para::{Link, Para};

/// A chapter block: a paragraph, or a letter set off as a block quote.
#[derive(Deserialize)]
#[serde(untagged)]
enum Block {
    Para(String),
    Quote(Vec<String>),
}

#[derive(Deserialize)]
struct Chapter {
    blocks: Vec<Block>,
}

#[derive(Deserialize)]
struct Fact {
    key: String,
    value: String,
}

#[derive(Deserialize)]
struct Plan {
    summary: String,
    storylines: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Volume {
    name: String,
    first_chapter: usize,
}

#[derive(Deserialize)]
struct Storyline {
    key: String,
    name: String,
    color: String,
    summary: String,
    body: Vec<String>,
}

#[derive(Deserialize)]
struct Category {
    key: String,
    name: String,
    color: String,
    body: Vec<String>,
}

#[derive(Deserialize)]
struct Element {
    key: String,
    category: String,
    name: String,
    aliases: Vec<String>,
    summary: String,
    facts: Vec<Fact>,
    body: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelationType {
    key: String,
    name: String,
    description: String,
    orientation: String,
    source_role: String,
    target_role: String,
    source_kinds: Vec<String>,
    target_kinds: Vec<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RelationEnd {
    Element(String),
    Chapter(usize),
}

#[derive(Deserialize)]
struct Relation {
    #[serde(rename = "type")]
    kind: String,
    from: String,
    to: RelationEnd,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimePin {
    before_chapter: usize,
    label: String,
}

#[derive(Deserialize)]
struct Idea {
    title: String,
    summary: String,
    body: Vec<String>,
}

#[derive(Deserialize)]
struct Comment {
    kind: String,
    chapter: Option<usize>,
    element: Option<String>,
    quotation: Option<String>,
    body: String,
    #[serde(default)]
    resolved: bool,
}

#[derive(Deserialize)]
struct ElementPatch {
    element: String,
    chapter: usize,
    quotation: String,
    title: String,
    body: String,
}

#[derive(Deserialize)]
struct PlotRow {
    label: String,
    cells: Vec<String>,
}

#[derive(Deserialize)]
struct PlotGrid {
    chapter: usize,
    columns: Vec<String>,
    rows: Vec<PlotRow>,
}

#[derive(Deserialize)]
struct MaterialNote {
    title: String,
    markdown: String,
}

#[derive(Deserialize)]
struct LinkForm {
    form: String,
    element: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SampleBook {
    name: String,
    summary: String,
    facts: Vec<Fact>,
    memory: Option<String>,
    chapters: Vec<Chapter>,
    chapter_titles: Vec<String>,
    chapter_plans: Vec<Plan>,
    volumes: Vec<Volume>,
    storylines: Vec<Storyline>,
    categories: Vec<Category>,
    elements: Vec<Element>,
    relation_types: Vec<RelationType>,
    relations: Vec<Relation>,
    timeline_pins: Vec<TimePin>,
    ideas: Vec<Idea>,
    comments: Vec<Comment>,
    element_patches: Vec<ElementPatch>,
    finished_chapters: Vec<usize>,
    plot_grid: Option<PlotGrid>,
    material_notes: Vec<MaterialNote>,
    link_forms: Vec<LinkForm>,
    link_boundaries: String,
}

fn parse<T: for<'de> Deserialize<'de>>(name: &str, json: &str) -> T {
    serde_json::from_str(json).unwrap_or_else(|e| panic!("{name}: {e}"))
}

/// Lay out the sample definition `json` (`name` is its file, for the panic
/// message) with ids fixed by `key` (`sample/<name>`). Panics when `json`
/// is not a sample definition: definitions are compiled in and tested.
pub fn from_json(name: &str, json: &str, key: &str) -> Result<SeededBook> {
    lay_out(&parse(name, json), key)
}

/// Id number `index` of `kind` in the sample keyed `key`: fixed, so the
/// same sample is the same book in every library it is written into.
pub fn sample_id(key: &str, kind: &str, index: usize) -> String {
    build::id(0, key, kind, index)
}

/// Split `*…*` (italic) and `**…**` (bold) markers out of `s`.
fn inline_marks(s: &str) -> (String, Vec<(std::ops::Range<usize>, InlineStyle)>) {
    let mut out = String::new();
    let mut styles = Vec::new();
    let mut open: Option<(usize, bool)> = None;
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    let mut n = 0usize;
    while i < chars.len() {
        if chars[i] == '*' {
            let bold = chars.get(i + 1) == Some(&'*');
            match open {
                Some((at, b)) if b == bold => {
                    let style = if bold {
                        InlineStyle::Bold
                    } else {
                        InlineStyle::Italic
                    };
                    if n > at {
                        styles.push((at..n, style));
                    }
                    open = None;
                }
                None => open = Some((n, bold)),
                Some(_) => {}
            }
            i += if bold { 2 } else { 1 };
            continue;
        }
        out.push(chars[i]);
        n += 1;
        i += 1;
    }
    (out, styles)
}

/// Link every occurrence of a form to its element: longest form first, no
/// overlaps; Latin forms only between word boundaries. A form whose element
/// is `None` matches (so a shorter form cannot link inside it) but links
/// nothing.
struct Linker {
    forms: Vec<(Vec<char>, Option<usize>)>,
    word_boundaries: bool,
}

impl Linker {
    fn new(forms: &[LinkForm], elements: &BTreeMap<String, usize>, word_boundaries: bool) -> Self {
        let mut forms: Vec<(Vec<char>, Option<usize>)> = forms
            .iter()
            .map(|f| {
                (
                    f.form.chars().collect(),
                    f.element.as_ref().and_then(|e| elements.get(e).copied()),
                )
            })
            .collect();
        forms.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.0.cmp(&b.0)));
        Self {
            forms,
            word_boundaries,
        }
    }

    fn links(&self, text: &str) -> Vec<Link> {
        let chars: Vec<char> = text.chars().collect();
        let word = |c: Option<&char>| c.is_some_and(|c| c.is_alphanumeric() && c.is_ascii());
        let mut out = Vec::new();
        let mut i = 0;
        'outer: while i < chars.len() {
            for (form, target) in &self.forms {
                if form.is_empty() || !chars[i..].starts_with(form) {
                    continue;
                }
                if self.word_boundaries
                    && (word(i.checked_sub(1).and_then(|j| chars.get(j)))
                        || word(chars.get(i + form.len())))
                {
                    continue;
                }
                if let Some(t) = target {
                    out.push(Link {
                        start: i,
                        len: form.len(),
                        target: *t,
                    });
                }
                i += form.len();
                continue 'outer;
            }
            i += 1;
        }
        out
    }
}

/// Paragraphs of plain lines.
fn plain_paras(lines: &[String]) -> Vec<Para> {
    lines
        .iter()
        .filter(|l| !l.is_empty())
        .map(|l| Para {
            text: l.clone(),
            ..Para::default()
        })
        .collect()
}

/// The material-note Markdown the samples use: `#`/`##`/`###` headings,
/// `-`/`1.` list items, `- [ ]` tasks, `**bold**`, blank-line paragraphs.
fn markdown_paras(md: &str) -> Vec<Para> {
    let mut out = Vec::new();
    for line in md
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty())
    {
        let mut p = Para::default();
        let mut rest = line;
        if let Some(h) = ["### ", "## ", "# "]
            .iter()
            .position(|m| line.starts_with(m))
        {
            p.heading = Heading::from_level(3 - h as i64);
            rest = &line[3 - h + 1..];
        } else if let Some(r) = line
            .strip_prefix("- [ ] ")
            .map(|r| (r, false))
            .or_else(|| line.strip_prefix("- [x] ").map(|r| (r, true)))
        {
            p.task = Some(r.1);
            rest = r.0;
        } else if let Some(r) = line.strip_prefix("- ") {
            p.list = Some(ListKind::Bullet);
            rest = r;
        } else if let Some((n, r)) = line.split_once(". ")
            && !n.is_empty()
            && n.chars().all(|c| c.is_ascii_digit())
        {
            p.list = Some(ListKind::Ordered);
            rest = r;
        }
        let (t, styles) = inline_marks(rest);
        p.text = t;
        p.styles = styles;
        out.push(p);
    }
    out
}

fn kinds(names: &[String]) -> Vec<EntityKind> {
    names.iter().map(|k| EntityKind::parse(k)).collect()
}

/// Lay a sample book out as the 0.1 sample writer did.
fn lay_out(s: &SampleBook, key: &str) -> Result<SeededBook> {
    let book_id = BookId::parse(&sample_id(key, "book", 0)).expect("valid id");
    let mut b = Builder::new(book_id)?;
    let sid = |kind: &str, i: usize| sample_id(key, kind, i);
    let storylines: BTreeMap<&str, StorylineId> = s
        .storylines
        .iter()
        .enumerate()
        .map(|(i, l)| {
            (
                l.key.as_str(),
                StorylineId::parse(&sid("storyline", i)).expect("id"),
            )
        })
        .collect();
    let categories: BTreeMap<&str, CategoryId> = s
        .categories
        .iter()
        .enumerate()
        .map(|(i, c)| {
            (
                c.key.as_str(),
                CategoryId::parse(&sid("category", i)).expect("id"),
            )
        })
        .collect();
    let element_ids: Vec<ElementId> = (0..s.elements.len())
        .map(|i| ElementId::parse(&sid("element", i)).expect("id"))
        .collect();
    let element_index: BTreeMap<String, usize> = s
        .elements
        .iter()
        .enumerate()
        .map(|(i, e)| (e.key.clone(), i))
        .collect();
    let element_refs: Vec<EntityRef> = element_ids
        .iter()
        .map(|e| EntityRef::new(EntityKind::Element, e.as_str()))
        .collect();
    let chapters: Vec<NodeId> = (0..s.chapters.len())
        .map(|i| NodeId::parse(&sid("chapter", i)).expect("id"))
        .collect();
    let order = |n: usize| n as f64 * 10.0;

    let mut storyline_pos = positions(s.storylines.len()).into_iter();
    let finished: BTreeSet<usize> = s.finished_chapters.iter().copied().collect();
    b.edit_book(|t| {
        t.meta()
            .name(&s.name)?
            .summary(&s.summary)?
            .created_at(Some(Timestamp(T0)))?;
        for (i, f) in s.facts.iter().enumerate() {
            t.put_fact(&KvEntry {
                id: KvEntryId::parse(&format!("fact-{i}")).expect("id"),
                key: f.key.clone(),
                value: f.value.clone(),
                pos: None,
            })?;
        }
        for l in &s.storylines {
            t.storyline(&storylines[l.key.as_str()])?
                .name(&l.name)?
                .color(&l.color)?
                .summary(&l.summary)?
                .pos(&storyline_pos.next().expect("a position per storyline"))?;
        }
        for c in &s.categories {
            t.category(&categories[c.key.as_str()])?
                .name(&c.name)?
                .color(&c.color)?
                .layout(&CategoryLayout::Auto)?;
        }
        for (i, e) in s.elements.iter().enumerate() {
            let w = t.element(&element_ids[i])?;
            w.name(&e.name)?
                .summary(&e.summary)?
                .category(categories.get(e.category.as_str()))?
                .created_at(Some(Timestamp(T0 + i as i64)))?;
            for a in &e.aliases {
                w.add_alias(a)?;
            }
            let pos = positions(e.facts.len());
            for (k, f) in e.facts.iter().enumerate() {
                w.put_fact(&KvEntry {
                    id: KvEntryId::parse(&format!("fact-{k}")).expect("id"),
                    key: f.key.clone(),
                    value: f.value.clone(),
                    pos: Some(pos[k].clone()),
                })?;
            }
        }
        for (v, vol) in s.volumes.iter().enumerate() {
            t.act(&ActId::parse(&sid("act", v)).expect("id"))?
                .name(&vol.name)?
                .start_order((vol.first_chapter > 1).then(|| order(vol.first_chapter) - 5.0))?;
        }
        for (i, c) in chapters.iter().enumerate() {
            let n = i + 1;
            let w = t.node(c)?;
            w.kind(&NodeKind::Chapter)?
                .title(&s.chapter_titles[i])?
                .book_order(Some(order(n)))?
                .narrative_order(Some(order(n)))?
                .status(if finished.contains(&n) {
                    &NodeStatus::Finished
                } else {
                    &NodeStatus::Draft
                })?
                .created_at(Some(Timestamp(T0 + i as i64)))?;
            if let Some(plan) = s.chapter_plans.get(i) {
                w.summary(&plan.summary)?;
                for (k, l) in plan.storylines.iter().enumerate() {
                    if let Some(id) = storylines.get(l.as_str()) {
                        w.add_storyline(id)?;
                        if k == 0 {
                            w.primary_storyline(Some(id))?;
                        }
                    }
                }
            }
        }
        for (p, pin) in s.timeline_pins.iter().enumerate() {
            t.time_pin(&TimePinId::parse(&sid("time-pin", p)).expect("id"))?
                .narrative_order(order(pin.before_chapter) - 5.0)?
                .label(&pin.label)?;
        }
        let types: BTreeMap<&str, RelationTypeId> = s
            .relation_types
            .iter()
            .enumerate()
            .map(|(i, r)| {
                (
                    r.key.as_str(),
                    RelationTypeId::parse(&sid("relation-type", i)).expect("id"),
                )
            })
            .collect();
        for r in &s.relation_types {
            t.relation_type(&types[r.key.as_str()])?
                .name(&r.name)?
                .description(&r.description)?
                .orientation(&RelationOrientation::parse(&r.orientation))?
                .source_role(&r.source_role)?
                .target_role(&r.target_role)?
                .source_kinds(&kinds(&r.source_kinds))?
                .target_kinds(&kinds(&r.target_kinds))?;
        }
        for (k, r) in s.relations.iter().enumerate() {
            let (Some(rt), Some(&from)) = (types.get(r.kind.as_str()), element_index.get(&r.from))
            else {
                continue;
            };
            let to = match &r.to {
                RelationEnd::Element(e) => match element_index.get(e) {
                    Some(&i) => element_refs[i].clone(),
                    None => continue,
                },
                RelationEnd::Chapter(n) => match chapters.get(n.wrapping_sub(1)) {
                    Some(c) => EntityRef::new(EntityKind::Node, c.as_str()),
                    None => continue,
                },
            };
            let (a, z) = if s
                .relation_types
                .iter()
                .any(|t| t.key == r.kind && t.orientation == "symmetric")
            {
                canonical_symmetric(element_refs[from].clone(), to)
            } else {
                (element_refs[from].clone(), to)
            };
            t.relation(&RelationId::parse(&sid("relation", k)).expect("id"))?
                .ends(&a, &z)?
                .relation_type(rt)?
                .created_at(Some(Timestamp(T0 + k as i64)))?;
        }
        if let Some(m) = &s.memory {
            t.memory(&MemoryId::parse(&sid("memory", 0)).expect("id"))?
                .kind(&MemoryKind::Preference)?
                .body(m)?
                .source(&MemorySource::Author)?
                .status(&MemoryStatus::Active)?;
        }
        Ok(())
    })?;

    for l in &s.storylines {
        b.prose(
            "storylines",
            DocId::Storyline(storylines[l.key.as_str()].clone()),
            &plain_paras(&l.body),
            &[],
        )?;
    }
    for c in &s.categories {
        b.prose(
            "categories",
            DocId::Category(categories[c.key.as_str()].clone()),
            &plain_paras(&c.body),
            &[],
        )?;
    }
    for (i, e) in s.elements.iter().enumerate() {
        b.prose(
            "elements",
            DocId::Element(element_ids[i].clone()),
            &plain_paras(&e.body),
            &[],
        )?;
    }
    let linker = Linker::new(&s.link_forms, &element_index, s.link_boundaries == "word");
    let first_chapter = b.prose.len();
    for (i, c) in s.chapters.iter().enumerate() {
        let mut paras = Vec::new();
        for block in &c.blocks {
            let (lines, quote) = match block {
                Block::Para(p) => (std::slice::from_ref(p), false),
                Block::Quote(q) => (q.as_slice(), true),
            };
            for line in lines.iter().filter(|l| !l.is_empty()) {
                let (text, styles) = inline_marks(line);
                let links = linker.links(&text);
                paras.push(Para {
                    text,
                    quote,
                    styles,
                    links,
                    ..Para::default()
                });
            }
        }
        b.prose(
            "chapters",
            DocId::Node(chapters[i].clone()),
            &paras,
            &element_refs,
        )?;
    }

    // Ideas, notes, comments, patches, the plot grid.
    let ideas: Vec<NodeId> = (0..s.ideas.len())
        .map(|i| NodeId::parse(&sid("idea", i)).expect("id"))
        .collect();
    let materials: Vec<MaterialId> = (0..s.material_notes.len())
        .map(|i| MaterialId::parse(&sid("material", i)).expect("id"))
        .collect();
    let material_pos = positions(materials.len());
    b.edit_book(|t| {
        for (i, idea) in s.ideas.iter().enumerate() {
            t.node(&ideas[i])?
                .kind(&NodeKind::Drift)?
                .title(&idea.title)?
                .summary(&idea.summary)?
                .status(&NodeStatus::Drifting)?
                .x((i % 4) as f64 * 260.0)?
                .y((i / 4) as f64 * 180.0)?
                .created_at(Some(Timestamp(T0 + i as i64)))?;
        }
        for (i, m) in s.material_notes.iter().enumerate() {
            t.material(&materials[i])?
                .title(&m.title)?
                .kind(&MaterialKind::Text)?
                .pos(&material_pos[i])?;
        }
        Ok(())
    })?;
    for (i, idea) in s.ideas.iter().enumerate() {
        b.prose(
            "ideas",
            DocId::Node(ideas[i].clone()),
            &plain_paras(&idea.body),
            &[],
        )?;
    }
    for (i, m) in s.material_notes.iter().enumerate() {
        b.prose(
            "materialNotes",
            DocId::Material(materials[i].clone()),
            &markdown_paras(&m.markdown),
            &[],
        )?;
    }

    // Where a quotation sits in a chapter: (anchor, block id, paragraph).
    let locate = |b: &Builder, chapter: usize, quote: &str| {
        let view = b.prose[first_chapter + chapter].view();
        let text = view.plain_text();
        let at = text.find(quote)?;
        let from = text[..at].chars().count();
        let to = from + quote.chars().count();
        let block = view.blocks().into_iter().find(|bl| bl.newline >= to)?;
        let start = view.paragraph_start(block.newline);
        Some((
            view.anchor(from..to),
            block.id,
            view.text_in(start..block.newline).ok()?,
        ))
    };
    let mut comments = Vec::new();
    for c in &s.comments {
        let place = match (c.chapter, &c.quotation) {
            (Some(n), Some(q)) => locate(&b, n - 1, q),
            _ => None,
        };
        comments.push(place);
    }
    let mut patches = Vec::new();
    for p in &s.element_patches {
        patches.push(locate(&b, p.chapter - 1, &p.quotation));
    }
    b.edit_book(|t| {
        for (k, (c, place)) in s.comments.iter().zip(&comments).enumerate() {
            let w = t.comment(&CommentId::parse(&sid("comment", k)).expect("id"))?;
            let target = match (c.chapter, &c.element) {
                (Some(n), _) => Some(EntityRef::new(EntityKind::Node, chapters[n - 1].as_str())),
                (None, Some(e)) => element_index.get(e).map(|&i| element_refs[i].clone()),
                _ => None,
            };
            w.kind(&CommentKind::parse(&c.kind))?
                .author_kind(&CommentAuthorKind::User)?
                .status(if c.resolved {
                    &CommentStatus::Resolved
                } else {
                    &CommentStatus::Open
                })?
                .source(&CommentSource::Manual)?
                .target(target.as_ref())?
                .body(&c.body)?
                .created_at(Some(Timestamp(T0 + k as i64)))?
                .updated_at(Some(Timestamp(T0 + k as i64)))?;
            if let Some((anchor, block, para)) = place {
                w.anchor(anchor.as_ref())?
                    .target_block(block.as_ref())?
                    .quote(c.quotation.as_deref())?
                    .snapshots(&[dr_model::book::BlockSnapshot {
                        block: block.clone(),
                        text: para.clone(),
                    }])?;
            }
        }
        let pos = positions(s.element_patches.len());
        for (k, (p, place)) in s.element_patches.iter().zip(&patches).enumerate() {
            let Some(&e) = element_index.get(&p.element) else {
                continue;
            };
            let w = t.patch(&PatchId::parse(&sid("patch", k)).expect("id"))?;
            w.element(&element_ids[e])?
                .source_node(Some(&chapters[p.chapter - 1]))?
                .source_text(Some(&p.quotation))?
                .title(Some(&p.title))?
                .pos(&pos[k])?
                .body(&p.body)?;
            if let Some((anchor, block, _)) = place {
                w.source_block(block.as_ref())?.anchor(anchor.as_ref())?;
            }
        }
        if let Some(g) = &s.plot_grid {
            let w = t.plot_grid(&chapters[g.chapter - 1])?;
            let cols: Vec<PlotColId> = (0..g.columns.len())
                .map(|c| PlotColId::parse(&format!("col-{c}")).expect("id"))
                .collect();
            let col_pos = positions(cols.len());
            for (c, label) in g.columns.iter().enumerate() {
                w.col(&cols[c], col_pos[c].as_str(), label)?;
            }
            let row_pos = positions(g.rows.len());
            for (r, row) in g.rows.iter().enumerate() {
                let id = PlotRowId::parse(&format!("row-{r}")).expect("id");
                w.row(&id, row_pos[r].as_str(), &row.label)?;
                for (c, cell) in row.cells.iter().enumerate() {
                    if let Some(col) = cols.get(c)
                        && !cell.is_empty()
                    {
                        w.cell(&id, col, Some(cell))?;
                    }
                }
            }
        }
        Ok(())
    })?;
    for c in &s.comments {
        b.record(
            if c.kind == "todo" {
                "todos"
            } else {
                "comments"
            },
            c.body.clone(),
        );
    }
    Ok(b.finish())
}

fn positions(n: usize) -> Vec<PosKey> {
    build::positions(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_marks_strip_markers() {
        let (t, s) = inline_marks("a *b* **cd** e");
        assert_eq!(t, "a b cd e");
        assert_eq!(
            s,
            vec![(2..3, InlineStyle::Italic), (4..6, InlineStyle::Bold)]
        );
    }

    #[test]
    fn linker_prefers_long_forms_and_word_boundaries() {
        let forms = vec![
            LinkForm {
                form: "Darcy".into(),
                element: Some("d".into()),
            },
            LinkForm {
                form: "late Mr. Darcy".into(),
                element: None,
            },
        ];
        let el: BTreeMap<String, usize> = [("d".to_string(), 0)].into();
        let l = Linker::new(&forms, &el, true);
        assert_eq!(l.links("Darcy and the late Mr. Darcy, Darcys").len(), 1);
    }
}
