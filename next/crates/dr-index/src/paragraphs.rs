//! One paragraph's derived data, and a document's from its paragraphs.

use std::collections::{BTreeMap, HashSet};

use dr_doc::prose::{EmbedView, Paragraph, ProseView};
use dr_model::id::{BlockId, EmbedId};
use dr_store::index::{BlockRow, Derived, RefKind, RefRow};
use dr_text::{block_text, text_metrics};

/// What one paragraph contributes, kept between derivations.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Block {
    /// Characters of the body this paragraph spans, its newline included.
    pub(crate) len: usize,
    /// Ends with a newline (only damaged data has a last paragraph without).
    pub(crate) terminated: bool,
    /// The block id as stored; which paragraph keeps a duplicated one is
    /// decided over the whole document ([`derived_from`]).
    pub(crate) stored_id: Option<BlockId>,
    pub(crate) heading: u8,
    /// A lone embed placeholder: the embed it stands for.
    pub(crate) embed: Option<EmbedId>,
    pub(crate) text: String,
    pub(crate) words: u64,
    pub(crate) chars: u64,
    /// Entity links: (kind, target) → separate spans in this paragraph.
    pub(crate) links: BTreeMap<(String, String), u32>,
    /// The material a material embed shows.
    pub(crate) material: Option<String>,
}

impl Block {
    pub(crate) fn read(view: &ProseView<'_>, p: &Paragraph) -> Self {
        let text = block_text(view, p);
        let m = text_metrics(&text);
        let mut links = BTreeMap::new();
        // A span starts where a target appears that the previous run did
        // not link to (dr-doc merges adjacent runs of one target).
        let mut previous: HashSet<(String, String)> = HashSet::new();
        for r in &p.runs {
            let here: HashSet<(String, String)> = r
                .marks
                .entities
                .iter()
                .map(|l| (l.kind.as_str().to_string(), l.target.clone()))
                .collect();
            for t in &here {
                if !previous.contains(t) {
                    *links.entry(t.clone()).or_insert(0) += 1;
                }
            }
            previous = here;
        }
        let embed = p.embed().cloned();
        let material = embed.as_ref().and_then(|id| match view.embed(id) {
            Some(EmbedView::Material {
                material: Some(m), ..
            }) => Some(m.as_str().to_string()),
            _ => None,
        });
        Self {
            len: p.range.len() + usize::from(p.terminated),
            terminated: p.terminated,
            stored_id: p.stored_id.clone(),
            heading: p.attrs.heading.map(|h| h.level() as u8).unwrap_or(0),
            embed,
            text,
            words: m.words,
            chars: m.chars,
            links,
            material,
        }
    }
}

/// Every paragraph of `view`, read from scratch.
pub fn derive_blocks(view: &ProseView<'_>) -> Vec<Block> {
    view.paragraphs().map(|p| Block::read(view, &p)).collect()
}

/// For each paragraph (by its stored block id, in order), whether it keeps
/// its id: a block id that appears twice is kept by the first paragraph
/// (dr-doc's reading rule).
pub(crate) fn kept_ids<'b>(stored: impl IntoIterator<Item = Option<&'b BlockId>>) -> Vec<bool> {
    let stored = stored.into_iter();
    let mut seen: HashSet<&BlockId> = HashSet::with_capacity(stored.size_hint().0);
    stored
        .map(|id| id.is_some_and(|id| seen.insert(id)))
        .collect()
}

impl Block {
    /// The block id readers see.
    fn visible_id(&self, kept: bool) -> Option<String> {
        self.stored_id
            .as_ref()
            .filter(|_| kept)
            .map(|id| id.as_str().to_string())
    }

    /// The row dr-store stores for this paragraph.
    pub(crate) fn row(&self, kept: bool) -> BlockRow {
        BlockRow {
            block_id: self.visible_id(kept),
            heading: self.heading,
            chars: self.chars.min(u64::from(u32::MAX)) as u32,
            text: self.text.clone(),
        }
    }

    /// Whether [`Self::row`] would be `row` (without building it).
    pub(crate) fn has_row(&self, kept: bool, row: &BlockRow) -> bool {
        let id = self.stored_id.as_ref().filter(|_| kept);
        row.heading == self.heading
            && u64::from(row.chars) == self.chars.min(u64::from(u32::MAX))
            && row.block_id.as_deref() == id.map(BlockId::as_str)
            && row.text == self.text
    }
}

/// The document's references, from its paragraphs in order.
pub(crate) fn references<'b>(blocks: impl IntoIterator<Item = (&'b Block, bool)>) -> Vec<RefRow> {
    let mut out = Vec::new();
    for (b, kept) in blocks {
        if b.links.is_empty() && b.material.is_none() {
            continue;
        }
        let id = b.visible_id(kept);
        for ((kind, target), count) in &b.links {
            out.push(RefRow {
                source_block: id.clone(),
                target_kind: kind.clone(),
                target_id: target.clone(),
                kind: RefKind::Link,
                count: *count,
            });
        }
        if let Some(m) = &b.material {
            out.push(RefRow {
                source_block: id.clone(),
                target_kind: "material".into(),
                target_id: m.clone(),
                kind: RefKind::Embed,
                count: 1,
            });
        }
    }
    out
}

/// The rows dr-store stores, from the paragraphs in order.
pub fn derived_from(blocks: &[Block]) -> Derived {
    derived_with(
        blocks,
        &kept_ids(blocks.iter().map(|b| b.stored_id.as_ref())),
    )
}

/// [`derived_from`], with [`kept_ids`] already worked out.
pub(crate) fn derived_with(blocks: &[Block], kept: &[bool]) -> Derived {
    let mut out = Derived {
        blocks: Vec::with_capacity(blocks.len()),
        references: references(blocks.iter().zip(kept.iter().copied())),
        ..Derived::default()
    };
    for (b, kept) in blocks.iter().zip(kept) {
        out.words += b.words;
        out.chars += b.chars;
        out.blocks.push(b.row(*kept));
    }
    out
}
