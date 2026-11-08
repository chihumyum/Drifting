//! The sample books and the showcase library.
//!
//! - [`pride_and_prejudice`] and [`a_q`]: the 0.1 client's two built-in
//!   samples (public-domain text, the project's own notes around it), which
//!   dr-samples owns and the product writes into a new library;
//! - [`slow_clock`]: 《慢钟》, an original novel written for the release
//!   screenshots;
//! - [`showcase`]: 《慢钟》, 《阿Q正传》 and the screenshot shelf (books
//!   with synthetic text sized to their word counts), with a year of
//!   writing days.
//!
//! Every sample definition is laid out by dr-samples (`dr_samples::layout`)
//! as the 0.1 sample writer did; 《慢钟》 and the shelf come from
//! `fixtures/` (`fixtures/README.md`). Illustrations are listed but their
//! image files are not copied yet.

use std::collections::BTreeMap;

use dr_doc::Result;
use dr_model::book::{EntityRef, KvEntry};
use dr_model::id::*;
use dr_model::kind::*;
use dr_model::pos::PosKey;
use dr_model::{DocId, Timestamp};
use serde::Deserialize;

use crate::rng::Rng;
use crate::seed::{Builder, SeededBook, T0};
use crate::text;

const SLOW_CLOCK: &str = include_str!("../fixtures/slow-clock.json");
const SHELF: &str = include_str!("../fixtures/shelf.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShelfBook {
    name: String,
    genre: String,
    summary: String,
    words: usize,
    chapters: usize,
    storylines: Vec<ShelfStoryline>,
    people: Vec<String>,
    places: Vec<String>,
    started_days_ago: i64,
    last_written_days_ago: i64,
    diligence: f64,
}

#[derive(Deserialize)]
struct ShelfStoryline {
    name: String,
    color: String,
}

fn parse<T: for<'de> Deserialize<'de>>(name: &str, json: &str) -> T {
    serde_json::from_str(json).unwrap_or_else(|e| panic!("fixtures/{name}: {e}"))
}

/// *Pride and Prejudice* (Jane Austen, 1813), 61 chapters, with the 0.1
/// sample's elements, storylines, notes and review items.
pub fn pride_and_prejudice() -> Result<SeededBook> {
    dr_samples::pride_and_prejudice()
}

/// 《阿Q正传》 (鲁迅, 1921–22): six written chapters and three planned ones.
pub fn a_q() -> Result<SeededBook> {
    dr_samples::a_q()
}

/// 《慢钟》: the showcase's main book, twelve written chapters of 24.
pub fn slow_clock() -> Result<SeededBook> {
    dr_samples::layout::from_json("fixtures/slow-clock.json", SLOW_CLOCK, "sample/slow-clock")
}

/// The showcase library: 《慢钟》, 《阿Q正传》 and the Chinese shelf, each
/// with writing days. `seed` drives the shelf's synthetic text.
pub fn showcase(seed: u64) -> Result<Vec<SeededBook>> {
    let shelf: BTreeMap<String, Vec<ShelfBook>> = parse("shelf.json", SHELF);
    let mut books = vec![slow_clock()?, a_q()?];
    for (i, book) in shelf.get("zh-CN").into_iter().flatten().enumerate() {
        books.push(shelf_book(book, seed, i)?);
    }
    Ok(books)
}

fn positions(n: usize) -> Vec<PosKey> {
    crate::seed::positions(n)
}

/// One shelf book: chapters of synthetic text summing to its word count, its
/// storylines, people and places, and writing days between when it was
/// started and last written in.
fn shelf_book(s: &ShelfBook, seed: u64, index: usize) -> Result<SeededBook> {
    let key = format!("showcase/shelf/{index}");
    let sid = |kind: &str, i: usize| crate::seed::build_id(seed, &key, kind, i);
    let mut b = Builder::new(BookId::parse(&sid("book", 0)).expect("id"))?;
    let mut rng = Rng::stream(seed, &key, 0);
    // Chapter lengths: weights 0.6–1.4, at least 40 words, exact total.
    let weights: Vec<f64> = (0..s.chapters).map(|_| 0.6 + rng.unit() * 0.8).collect();
    let sum: f64 = weights.iter().sum();
    let mut lengths: Vec<usize> = weights
        .iter()
        .map(|w| ((s.words as f64 * w / sum).floor() as usize).max(40))
        .collect();
    let have: usize = lengths.iter().sum();
    let last = lengths.len() - 1;
    lengths[last] = (lengths[last] + s.words).saturating_sub(have).max(40);
    let storylines: Vec<StorylineId> = (0..s.storylines.len())
        .map(|i| StorylineId::parse(&sid("storyline", i)).expect("id"))
        .collect();
    let people = CategoryId::parse(&sid("category", 0)).expect("id");
    let places = CategoryId::parse(&sid("category", 1)).expect("id");
    let names: Vec<&String> = s.people.iter().chain(&s.places).collect();
    let elements: Vec<ElementId> = (0..names.len())
        .map(|i| ElementId::parse(&sid("element", i)).expect("id"))
        .collect();
    let element_refs: Vec<EntityRef> = elements
        .iter()
        .map(|e| EntityRef::new(EntityKind::Element, e.as_str()))
        .collect();
    let chapters: Vec<NodeId> = (0..s.chapters)
        .map(|i| NodeId::parse(&sid("chapter", i)).expect("id"))
        .collect();
    let device = DeviceKey::from_installation_id("dr-testkit-showcase-device");
    b.edit_book(|t| {
        t.meta()
            .name(&s.name)?
            .summary(&s.summary)?
            .created_at(Some(Timestamp(T0 - s.started_days_ago * 86_400)))?;
        t.put_fact(&KvEntry {
            id: KvEntryId::parse("fact-genre").expect("id"),
            key: "体裁".into(),
            value: s.genre.clone(),
            pos: None,
        })?;
        let pos = positions(storylines.len());
        for (i, l) in s.storylines.iter().enumerate() {
            t.storyline(&storylines[i])?
                .name(&l.name)?
                .color(&l.color)?
                .pos(&pos[i])?;
        }
        t.category(&people)?
            .name("人物")?
            .color("#9B6A4F")?
            .layout(&CategoryLayout::Auto)?;
        t.category(&places)?
            .name("地点")?
            .color("#5F7D74")?
            .layout(&CategoryLayout::Auto)?;
        for (i, n) in names.iter().enumerate() {
            t.element(&elements[i])?
                .name(n)?
                .category(Some(if i < s.people.len() { &people } else { &places }))?;
        }
        for (i, c) in chapters.iter().enumerate() {
            let l = &storylines[(i + rng.below(2) as usize) % storylines.len()];
            t.node(c)?
                .kind(&NodeKind::Chapter)?
                .title(&format!("第{}章", i + 1))?
                .book_order(Some((i + 1) as f64 * 10.0))?
                .narrative_order(Some((i + 1) as f64 * 10.0))?
                .status(&NodeStatus::Draft)?
                .add_storyline(l)?
                .primary_storyline(Some(l))?;
        }
        for d in s.last_written_days_ago..=s.started_days_ago {
            if rng.chance(s.diligence) || d == s.last_written_days_ago {
                t.writing_day(
                    &device,
                    &crate::seed::day_before_t0(d),
                    rng.range(300, 3_000) as i64,
                )?;
            }
        }
        Ok(())
    })?;
    let name_refs: Vec<&str> = names.iter().map(|n| n.as_str()).collect();
    for (i, c) in chapters.iter().enumerate() {
        let paras = text::body(
            &mut Rng::stream(seed, &format!("{key}/chapters"), i as u64),
            lengths[i],
            text::BodyShape {
                names: &name_refs,
                ..text::BodyShape::default()
            },
        );
        b.prose("chapters", DocId::Node(c.clone()), &paras, &element_refs)?;
    }
    Ok(b.finish())
}
