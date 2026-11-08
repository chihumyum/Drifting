//! Writing a prose document: every edit keeps the schema's invariants.
//!
//! - The body always ends with the genesis newline: inserts happen before the
//!   last character, nothing deletes it, and Enter inserts its newline at the
//!   caret.
//! - A newly written newline gets every block attribute stated explicitly
//!   (readers only trust newlines, and a concurrent insert can leave a stray
//!   paragraph mark around).
//! - Block ids follow the text (Enter at a paragraph's end moves the id to
//!   the new newline; a join keeps the first paragraph's id).
//! - Inline marks never touch a newline.

use std::collections::HashSet;
use std::ops::Range;

use dr_model::ProseProfile;
use dr_model::id::{BlockId, EmbedId};
use dr_model::pos::PosKey;
use dr_model::prose::{
    BlockAttrs, EntityLink, Heading, InlineMarks, InlineStyle, OBJECT_CHAR, PARAGRAPH_END,
};
use loro::cursor::Side;
use loro::{LoroText, LoroValue};

use super::attrs::{encode_block, encode_entity, note_only_block};
use super::embed::{EmbedKind, EmbedView, TableWriter};
use super::view::{ProseView, Run};
use crate::error::{DocError, Result};
use crate::schema::{block, inline};

/// An open write on a prose document; see `ProseDoc::edit`.
pub struct ProseTxn<'a> {
    pub(crate) view: ProseView<'a>,
}

/// Which inline style to clear.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StyleKey {
    Bold,
    Italic,
    Underline,
    Strike,
    Link,
    Highlight,
    Code,
}

impl StyleKey {
    fn key(self) -> &'static str {
        match self {
            StyleKey::Bold => inline::BOLD,
            StyleKey::Italic => inline::ITALIC,
            StyleKey::Underline => inline::UNDERLINE,
            StyleKey::Strike => inline::STRIKE,
            StyleKey::Link => inline::LINK,
            StyleKey::Highlight => inline::HIGHLIGHT,
            StyleKey::Code => inline::CODE,
        }
    }
}

impl<'a> ProseTxn<'a> {
    /// Read what the transaction has written so far.
    pub fn view(&self) -> ProseView<'a> {
        self.view
    }

    fn len(&self) -> usize {
        self.view.len()
    }

    /// Positions where text may be inserted: before the final newline.
    fn check_insert_pos(&self, pos: usize) -> Result<()> {
        let len = self.len();
        if len == 0 || pos >= len {
            return Err(DocError::BadRange {
                start: pos,
                end: pos,
                len,
            });
        }
        Ok(())
    }

    /// Fresh block id for the newline at `nl`: that character's op id.
    fn fresh_block_id(&self, nl: usize) -> Result<BlockId> {
        let cursor = self
            .view
            .text
            .get_cursor(nl, Side::Middle)
            .ok_or(DocError::NotANewline(nl))?;
        let id = cursor.id.ok_or(DocError::NotANewline(nl))?;
        Ok(BlockId::parse(&format!("{}@{}", id.counter, id.peer)).expect("op id is a valid id"))
    }

    fn check_profile(&self, b: &BlockAttrs) -> Result<()> {
        if self.view.profile == ProseProfile::Prose
            && let Some(what) = note_only_block(b)
        {
            return Err(DocError::NotInProfile(what));
        }
        Ok(())
    }

    /// Make the newline at `nl` carry exactly `id` and `attrs`, and no
    /// inline mark (a newline inserted inside a link or a bold run gets that
    /// mark from Loro; readers ignore it, writers remove it).
    fn set_newline(&self, nl: usize, id: Option<&BlockId>, attrs: &BlockAttrs) -> Result<()> {
        let have = self.view.raw_attrs_at(nl);
        for key in have.keys().filter(|k| !block::is_block_key(k)) {
            self.view.text.unmark(nl..nl + 1, key)?;
        }
        for (key, want) in encode_block(id, attrs) {
            match (want, have.get(key)) {
                (Some(w), Some(h)) if &w == h => {}
                (Some(w), _) => {
                    self.view.text.mark(nl..nl + 1, key, w)?;
                }
                (None, Some(_)) => {
                    self.view.text.unmark(nl..nl + 1, key)?;
                }
                (None, None) => {}
            }
        }
        Ok(())
    }

    fn newline_at_or_after(&self, pos: usize) -> Result<usize> {
        self.view
            .next_newline(pos)
            .ok_or(DocError::NotANewline(pos))
    }

    /// Insert text without paragraph breaks at `pos` (before the final
    /// newline). New text takes the inline marks Loro's expand rules give it
    /// (bold continues after bold; links and entity links do not).
    pub fn insert_text(&mut self, pos: usize, s: &str) -> Result<()> {
        if s.contains(PARAGRAPH_END) {
            return Err(DocError::NewlineInText);
        }
        if s.contains(OBJECT_CHAR) {
            return Err(DocError::ObjectCharInText);
        }
        self.check_insert_pos(pos)?;
        if !s.is_empty() {
            self.view.text.insert(pos, s)?;
        }
        Ok(())
    }

    /// Insert text that may contain newlines: each newline is an Enter
    /// ([`Self::split`]), so pasted paragraphs get fresh block ids. Returns
    /// the caret after the inserted text.
    pub fn insert_paragraphs(&mut self, pos: usize, s: &str) -> Result<usize> {
        let mut caret = pos;
        for (i, line) in s.split(PARAGRAPH_END).enumerate() {
            if i > 0 {
                caret = self.split(caret)?;
            }
            self.insert_text(caret, line)?;
            caret += line.chars().count();
        }
        Ok(caret)
    }

    /// Copy the whole of `from` (a template, `template:` document) in front
    /// of the paragraph that starts at `pos`: every paragraph with its
    /// attributes and a fresh block id, the inline marks and entity links of
    /// its text, tables (rows and columns under the same ids, cells with
    /// their marks and entity links) and material embeds under new embed
    /// ids. When the paragraph at `pos` is empty, the last copied paragraph
    /// takes its place, so applying a template to a new, empty document
    /// leaves exactly the template.
    /// Returns the position after the copied text.
    ///
    /// Marks and attributes `from` has but this document's profile does not
    /// allow are refused (a note's list copied into a chapter).
    pub fn insert_copy(&mut self, pos: usize, from: &ProseView<'_>) -> Result<usize> {
        self.check_insert_pos(pos)?;
        let target = self.view.paragraph_at(pos)?;
        if target.range.start != pos || target.runs.iter().any(|r| r.marks.embed.is_some()) {
            return Err(DocError::BadRange {
                start: pos,
                end: pos,
                len: self.len(),
            });
        }
        let replace_last = target.range.is_empty();
        let source: Vec<_> = from.paragraphs().collect();
        let mut caret = pos;
        for (i, p) in source.iter().enumerate() {
            if let Some(embed) = p.runs.iter().find_map(|r| r.marks.embed.clone()) {
                caret = self.copy_embed(caret, from, &embed)?;
                continue;
            }
            let start = caret;
            let text = p.text();
            self.insert_text(start, &text)?;
            let mut at = start;
            for r in &p.runs {
                let n = r.text.chars().count();
                self.copy_marks(at..at + n, &r.marks)?;
                at += n;
            }
            caret = start + text.chars().count();
            if !(replace_last && i + 1 == source.len()) {
                caret = self.split(caret)?;
            }
            self.set_block_attrs(start, &p.attrs)?;
        }
        Ok(caret)
    }

    fn copy_marks(&mut self, range: Range<usize>, m: &InlineMarks) -> Result<()> {
        if range.is_empty() {
            return Ok(());
        }
        for s in styles_of(m) {
            self.set_style(range.clone(), &s)?;
        }
        for e in &m.entities {
            self.link_entity(range.clone(), e)?;
        }
        Ok(())
    }

    /// Write `runs` into the empty table cell `cell`, marks included, by the
    /// rules of [`Self::set_style`] and [`Self::link_entity`]. The whole text
    /// goes in before any mark, so a mark that grows at its end (bold) does
    /// not spread to the next run.
    fn copy_cell(&self, cell: &LoroText, runs: &[Run]) -> Result<()> {
        let text: String = runs.iter().map(|r| r.text.as_str()).collect();
        if text.is_empty() {
            return Ok(());
        }
        cell.insert(0, &text)?;
        let mut at = 0;
        for r in runs {
            let range = at..at + r.text.chars().count();
            at = range.end;
            if range.is_empty() {
                continue;
            }
            for s in styles_of(&r.marks) {
                self.check_style(&s)?;
                let (key, value) = style_mark(&s);
                cell.mark(range.clone(), key, value)?;
            }
            for e in &r.marks.entities {
                check_link(e)?;
                cell.mark(
                    range.clone(),
                    &inline::entity_key(&e.target),
                    encode_entity(e),
                )?;
            }
        }
        Ok(())
    }

    /// Copy embed `id` of `from` as a new embed paragraph at `para_start`.
    /// Returns the start of the paragraph after it.
    fn copy_embed(
        &mut self,
        para_start: usize,
        from: &ProseView<'_>,
        id: &EmbedId,
    ) -> Result<usize> {
        let fresh = EmbedId::new_v7();
        match from.embed(id) {
            Some(EmbedView::Table {
                cols, rows, cells, ..
            }) => {
                let t = self.insert_embed(para_start, &fresh, &EmbedKind::Table)?;
                for (lines, col) in [(&cols, true), (&rows, false)] {
                    let mut last: Option<PosKey> = None;
                    for l in lines {
                        let pos = l.pos.clone().unwrap_or_else(|| match &last {
                            Some(k) => k.after(),
                            None => PosKey::first(),
                        });
                        if col {
                            t.add_col(&l.id, &pos)?;
                        } else {
                            t.add_row(&l.id, &pos)?;
                        }
                        last = Some(pos);
                    }
                }
                for (r, c) in cells.keys() {
                    let runs = from.table_cell(id, r, c).unwrap_or_default();
                    self.copy_cell(&t.cell(r, c)?, &runs)?;
                }
            }
            Some(EmbedView::Material {
                material: Some(m), ..
            }) => {
                self.insert_embed(para_start, &fresh, &EmbedKind::Material(m))?;
            }
            // A material embed without its material, or a kind this version
            // does not know: nothing to copy.
            _ => return Ok(para_start),
        }
        Ok(para_start + 2)
    }

    /// Enter at `pos`. Returns the caret afterwards (`pos + 1`).
    ///
    /// - At the end of a non-empty paragraph: the new newline now ends the
    ///   text just written, so the paragraph's id and attributes move onto
    ///   it; the old newline ends the new empty paragraph, which gets a fresh
    ///   id and inherits quote, indent, alignment, list and callout.
    /// - At the start of a paragraph (or in an empty one): the new empty
    ///   paragraph above gets the fresh id and the same inheritance.
    /// - In the middle: the first half gets the fresh id and inherits heading,
    ///   quote, indent, alignment, list, code block and callout; the second
    ///   half keeps the old newline and id.
    pub fn split(&mut self, pos: usize) -> Result<usize> {
        self.check_insert_pos(pos)?;
        let nl = self.newline_at_or_after(pos)?;
        let start = self.view.paragraph_start(pos);
        let (old_id, old) = self.view.newline_block(nl);
        self.view.text.insert(pos, "\n")?;
        let fresh = self.fresh_block_id(pos)?;
        if pos == nl && pos > start {
            self.set_newline(pos, old_id.as_ref(), &old)?;
            self.set_newline(nl + 1, Some(&fresh), &old.inherited_at_end())?;
        } else if pos == start {
            self.set_newline(pos, Some(&fresh), &old.inherited_at_end())?;
        } else {
            self.set_newline(pos, Some(&fresh), &old.inherited_on_split())?;
        }
        Ok(pos + 1)
    }

    /// Delete `range` (clamped so the final newline stays). When it removes
    /// newlines, the paragraph containing `range.start` absorbs what is left
    /// of the one containing `range.end` and keeps its own id and attributes
    /// (as ProseMirror joins into the first block) — unless the range is
    /// exactly whole paragraphs (from a paragraph start to just after a
    /// newline), in which case the paragraph after it is untouched. So a
    /// Backspace that removes an empty paragraph above keeps the one below.
    pub fn delete(&mut self, range: Range<usize>) -> Result<()> {
        let len = self.len();
        if range.start > range.end || range.end > len {
            return Err(DocError::BadRange {
                start: range.start,
                end: range.end,
                len,
            });
        }
        let end = range.end.min(len.saturating_sub(1));
        let start = range.start.min(end);
        if start == end {
            return Ok(());
        }
        let deleted = self.view.text.slice(start, end)?;
        if !deleted.contains(PARAGRAPH_END) {
            self.view.text.delete(start, end - start)?;
            return Ok(());
        }
        let first_start = self.view.paragraph_start(start);
        let first_nl = self.newline_at_or_after(start)?;
        let (first_id, first_attrs) = self.view.newline_block(first_nl);
        let survivor_nl = self.newline_at_or_after(end)?;
        self.view.text.delete(start, end - start)?;
        if start == first_start && deleted.ends_with(PARAGRAPH_END) {
            return Ok(());
        }
        let nl = survivor_nl - (end - start);
        self.set_newline(nl, first_id.as_ref(), &first_attrs)
    }

    /// Set the block attributes of the paragraph containing `pos`, keeping its
    /// block id. Attributes not in `attrs` are cleared.
    pub fn set_block_attrs(&mut self, pos: usize, attrs: &BlockAttrs) -> Result<()> {
        self.check_profile(attrs)?;
        if pos >= self.len() {
            return Err(DocError::BadRange {
                start: pos,
                end: pos,
                len: self.len(),
            });
        }
        let nl = self.newline_at_or_after(pos)?;
        let (id, _) = self.view.newline_block(nl);
        self.set_newline(nl, id.as_ref(), attrs)
    }

    /// Set or clear one block attribute key only (other keys untouched).
    /// The narrowest write, so a concurrent change of another attribute on the
    /// same paragraph is not overwritten.
    pub fn set_heading(&mut self, pos: usize, heading: Option<Heading>) -> Result<()> {
        if pos >= self.len() {
            return Err(DocError::BadRange {
                start: pos,
                end: pos,
                len: self.len(),
            });
        }
        let nl = self.newline_at_or_after(pos)?;
        match heading {
            Some(h) => {
                self.view
                    .text
                    .mark(nl..nl + 1, block::HEADING, LoroValue::I64(h.level()))?
            }
            None => self.view.text.unmark(nl..nl + 1, block::HEADING)?,
        }
        Ok(())
    }

    /// Apply `f` to every non-newline segment of `range`.
    fn per_segment(
        &self,
        range: Range<usize>,
        mut f: impl FnMut(Range<usize>) -> Result<()>,
    ) -> Result<()> {
        self.view.check_range(&range)?;
        if range.is_empty() {
            return Ok(());
        }
        let s = self.view.text.slice(range.start, range.end)?;
        let mut seg = range.start;
        for (i, c) in s.chars().enumerate() {
            if c == PARAGRAPH_END {
                let pos = range.start + i;
                if pos > seg {
                    f(seg..pos)?;
                }
                seg = pos + 1;
            }
        }
        if range.end > seg {
            f(seg..range.end)?;
        }
        Ok(())
    }

    /// Apply an inline style to `range`, skipping the newlines it crosses.
    pub fn set_style(&mut self, range: Range<usize>, style: &InlineStyle) -> Result<()> {
        self.check_style(style)?;
        let (key, value) = style_mark(style);
        let text = self.view.text;
        self.per_segment(range, |r| Ok(text.mark(r, key, value.clone())?))
    }

    fn check_style(&self, style: &InlineStyle) -> Result<()> {
        if style.allowed_in(self.view.profile) {
            Ok(())
        } else {
            Err(DocError::NotInProfile("highlight / inline code"))
        }
    }

    /// Clear an inline style from `range` (newlines included, so no stray
    /// piece survives on one).
    pub fn clear_style(&mut self, range: Range<usize>, style: StyleKey) -> Result<()> {
        self.view.check_range(&range)?;
        if !range.is_empty() {
            self.view.text.unmark(range, style.key())?;
        }
        Ok(())
    }

    /// Link `range` to an entity. Different targets use different keys, so
    /// links may overlap; two adjacent links to one target join.
    pub fn link_entity(&mut self, range: Range<usize>, link: &EntityLink) -> Result<()> {
        check_link(link)?;
        let key = inline::entity_key(&link.target);
        let value = encode_entity(link);
        let text = self.view.text;
        self.per_segment(range, |r| Ok(text.mark(r, &key, value.clone())?))
    }

    /// Remove the link to `target` from `range` (newlines included).
    pub fn unlink_entity(&mut self, range: Range<usize>, target: &str) -> Result<()> {
        self.view.check_range(&range)?;
        if !range.is_empty() {
            self.view.text.unmark(range, &inline::entity_key(target))?;
        }
        Ok(())
    }

    /// Insert an embed paragraph (U+FFFC + newline) before the paragraph that
    /// starts at `para_start`, and its entry. Returns a writer for a table's
    /// structure (unused for a material embed).
    pub fn insert_embed(
        &mut self,
        para_start: usize,
        id: &EmbedId,
        kind: &EmbedKind,
    ) -> Result<TableWriter> {
        self.check_insert_pos(para_start)?;
        if self.view.paragraph_start(para_start) != para_start {
            return Err(DocError::BadRange {
                start: para_start,
                end: para_start,
                len: self.len(),
            });
        }
        let s: String = [OBJECT_CHAR, PARAGRAPH_END].iter().collect();
        self.view.text.insert(para_start, &s)?;
        self.view
            .text
            .mark(para_start..para_start + 1, inline::EMBED, id.as_str())?;
        let nl = para_start + 1;
        let fresh = self.fresh_block_id(nl)?;
        self.set_newline(nl, Some(&fresh), &BlockAttrs::default())?;
        let entry = self.view.embeds.ensure_mergeable_map(id.as_str())?;
        match kind {
            EmbedKind::Table => {
                entry.insert("kind", "table")?;
            }
            EmbedKind::Material(m) => {
                entry.insert("kind", "material")?;
                entry.insert("material", m.as_str())?;
            }
        }
        Ok(TableWriter { entry })
    }

    /// A writer for an existing table embed's entry.
    pub fn table(&mut self, id: &EmbedId) -> Result<TableWriter> {
        if self.view.embed(id).is_none() {
            return Err(DocError::Missing {
                collection: "embeds",
                id: id.to_string(),
            });
        }
        Ok(TableWriter {
            entry: self.view.embeds.ensure_mergeable_map(id.as_str())?,
        })
    }

    /// Drop embed entries no placeholder points at (background cleanup).
    pub fn drop_orphan_embeds(&mut self) -> Result<usize> {
        let orphans = self.view.orphan_embeds();
        for id in &orphans {
            self.view.embeds.delete(id.as_str())?;
        }
        Ok(orphans.len())
    }

    /// Write the block id of the paragraph containing `pos` as given (`None`
    /// removes it). For importing old libraries, whose uuids are kept as
    /// block ids; ordinary edits never choose ids. A duplicate written here is
    /// fixed by [`Self::repair_block_ids`] like any other.
    pub fn set_block_id(&mut self, pos: usize, id: Option<&BlockId>) -> Result<()> {
        if pos >= self.len() {
            return Err(DocError::BadRange {
                start: pos,
                end: pos,
                len: self.len(),
            });
        }
        let nl = self.newline_at_or_after(pos)?;
        match id {
            Some(id) => self.view.text.mark(nl..nl + 1, block::ID, id.as_str())?,
            None => self.view.text.unmark(nl..nl + 1, block::ID)?,
        }
        Ok(())
    }

    /// Give every paragraph a unique block id. A later duplicate (in document
    /// order) or a missing id gets the op id of its own newline, suffixed
    /// `/1`, `/2`, … if another paragraph already uses that string, so two
    /// devices repairing the same state write the same values. Returns how
    /// many paragraphs were fixed.
    pub fn repair_block_ids(&mut self) -> Result<usize> {
        let blocks = self.view.blocks();
        let mut all: HashSet<BlockId> = blocks.iter().filter_map(|b| b.id.clone()).collect();
        let mut seen = HashSet::new();
        let mut fixes = Vec::new();
        for b in &blocks {
            match &b.id {
                Some(id) if seen.insert(id.clone()) => {}
                _ => fixes.push(b.newline),
            }
        }
        for nl in &fixes {
            let base = self.fresh_block_id(*nl)?;
            let mut id = base.clone();
            let mut n = 1;
            while all.contains(&id) {
                id = BlockId::parse(&format!("{base}/{n}")).expect("valid id");
                n += 1;
            }
            all.insert(id.clone());
            self.view.text.mark(*nl..*nl + 1, block::ID, id.as_str())?;
        }
        Ok(fixes.len())
    }
}

/// The inline styles `m` carries (entity links and embeds aside).
fn styles_of(m: &InlineMarks) -> impl Iterator<Item = InlineStyle> {
    [
        m.bold.then_some(InlineStyle::Bold),
        m.italic.then_some(InlineStyle::Italic),
        m.underline.then_some(InlineStyle::Underline),
        m.strike.then_some(InlineStyle::Strike),
        m.link.clone().map(InlineStyle::Link),
        m.highlight.clone().map(InlineStyle::Highlight),
        m.code.then_some(InlineStyle::Code),
    ]
    .into_iter()
    .flatten()
}

/// The Loro mark key and value of `style`.
fn style_mark(style: &InlineStyle) -> (&'static str, LoroValue) {
    match style {
        InlineStyle::Bold => (inline::BOLD, true.into()),
        InlineStyle::Italic => (inline::ITALIC, true.into()),
        InlineStyle::Underline => (inline::UNDERLINE, true.into()),
        InlineStyle::Strike => (inline::STRIKE, true.into()),
        InlineStyle::Link(url) => (inline::LINK, url.as_str().into()),
        InlineStyle::Highlight(c) => (inline::HIGHLIGHT, c.as_str().into()),
        InlineStyle::Code => (inline::CODE, true.into()),
    }
}

fn check_link(link: &EntityLink) -> Result<()> {
    if link.kind.may_be_linked() {
        Ok(())
    } else {
        Err(DocError::NotInProfile("entity link to this kind"))
    }
}
