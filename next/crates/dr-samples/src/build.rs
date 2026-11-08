//! Writing a book through dr-doc: the book document and one prose document
//! per body, all with deterministic peers (dr-doc's import peer) and commit
//! timestamps, so the same input gives byte-identical documents. The
//! samples are laid out with it ([`crate::layout`]); dr-testkit's seed
//! writes its synthetic presets with it too (`dr_testkit::seed`), so a
//! sample and a seeded book are made the same way.

use std::collections::BTreeMap;

use dr_doc::book::{BookDoc, BookTxn};
use dr_doc::peer::import_peer;
use dr_doc::prose::{ProseDoc, ProseTxn};
use dr_doc::{DocError, Result};
use dr_model::book::EntityRef;
use dr_model::id::BookId;
use dr_model::kind::ListKind;
use dr_model::pos::PosKey;
use dr_model::prose::{BlockAttrs, EntityLink};
use dr_model::{DocId, Origin};

use crate::para::{self, Para};
use crate::rng::Rng;

/// Seed time zero: 2025-11-01T12:26:40Z, in seconds (Loro's and the book
/// document's unit). Every timestamp of a seed is this plus a fixed offset.
pub const T0: i64 = 1_762_000_000;

/// One written book: its documents and what went into them.
pub struct SeededBook {
    pub book: BookDoc,
    /// Every prose document (chapters, ideas, element bodies, storyline and
    /// category descriptions, material notes), in creation order.
    pub prose: Vec<ProseDoc>,
    groups: BTreeMap<&'static str, Vec<String>>,
    counters: Counters,
}

impl SeededBook {
    pub fn book_id(&self) -> &BookId {
        self.book.book_id()
    }

    /// Body texts by group, in creation order (what dr-testkit's shape and
    /// corpus fingerprint are computed from).
    pub fn groups(&self) -> &BTreeMap<&'static str, Vec<String>> {
        &self.groups
    }

    /// Things the shape reports besides body sizes.
    pub fn counters(&self) -> Counters {
        self.counters
    }
}

/// Things the shape reports besides body sizes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counters {
    pub entity_links: usize,
    pub headings: [usize; 3],
    pub tasks: usize,
}

/// Builds one book: the book document plus prose documents.
pub struct Builder {
    pub book: BookDoc,
    pub prose: Vec<ProseDoc>,
    groups: BTreeMap<&'static str, Vec<String>>,
    counters: Counters,
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
            .push(para::plain(paras));
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
fn write_prose(
    doc_id: DocId,
    paras: &[Para],
    targets: &[EntityRef],
    ts: i64,
) -> Result<(ProseDoc, Counters)> {
    let peer = import_peer(&doc_id.to_string());
    let mut doc = ProseDoc::create(doc_id, peer)?;
    let body = para::plain(paras);
    let (r, _) = doc.edit_at(Origin::Import, Some(ts), |t| {
        if body.is_empty() {
            return Ok(Counters::default());
        }
        t.insert_paragraphs(0, &body)?;
        format_paras(t, paras, targets)
    });
    let counters = r?;
    Ok((doc, counters))
}

/// Give the paragraphs at the start of the document `paras`' attributes,
/// styles and entity links (the text is already there). `targets[i]` is
/// what name `i` links to.
pub fn format_paras(
    t: &mut ProseTxn<'_>,
    paras: &[Para],
    targets: &[EntityRef],
) -> Result<Counters> {
    let mut counters = Counters::default();
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
    Ok(counters)
}

/// A deterministic id of `kind` number `index` in book `book`.
pub fn id(seed: u64, book: &str, kind: &str, index: usize) -> String {
    Rng::stream(seed, &format!("{book}/{kind}"), index as u64)
        .uuid7(((T0 + index as i64) * 1000) as u64)
}

/// `n` fractional positions in order.
pub fn positions(n: usize) -> Vec<PosKey> {
    let mut out = Vec::with_capacity(n);
    let mut k = PosKey::first();
    for _ in 0..n {
        out.push(k.clone());
        k = k.after();
    }
    out
}
