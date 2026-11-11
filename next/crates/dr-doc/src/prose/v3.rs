//! Version-explicit entity links. The persisted key stays `entity:<target>`;
//! module, range and unknown metadata belong to its value, never its id.

use std::collections::BTreeMap;
use std::ops::Range;

use dr_model::id::{BlockId, EmbedId, EntryId, MaterialId, ModuleId};
use dr_model::kind::EntityKind;
use dr_model::prose::PARAGRAPH_END;
use dr_model::v3::EntityLinkV3;
use loro::{LoroText, LoroValue, TextDelta};

use super::{ProseTxn, ProseView};
use crate::error::{DocError, Result};
use crate::schema::inline;

fn invalid() -> DocError {
    DocError::NotInProfile("invalid v3 entity link")
}

fn check(link: &EntityLinkV3) -> Result<()> {
    let valid = match link.kind {
        EntityKind::Entry => EntryId::parse(&link.target).is_ok(),
        EntityKind::Material => MaterialId::parse(&link.target).is_ok() && link.module.is_none(),
        _ => false,
    };
    if valid { Ok(()) } else { Err(invalid()) }
}

/// Decode a v3 link value. Invalid/unknown kinds or malformed known fields
/// are not actionable links; raw copying still retains them unchanged.
pub fn decode_entity_link(target: &str, value: &LoroValue) -> Option<EntityLinkV3> {
    let LoroValue::Map(map) = value else {
        return None;
    };
    let string = |key: &str| match map.get(key) {
        Some(LoroValue::String(s)) => Some(s.as_str()),
        _ => None,
    };
    let optional = |key: &str| match map.get(key) {
        None | Some(LoroValue::Null) => Some(None),
        Some(LoroValue::String(s)) => Some(Some(s.as_str())),
        _ => None,
    };
    let link = EntityLinkV3 {
        target: target.to_owned(),
        kind: EntityKind::parse(string("kind")?),
        module: optional("module")?.map(ModuleId::parse).transpose().ok()?,
        block: optional("block")?.map(BlockId::parse).transpose().ok()?,
        end_block: optional("end_block")?
            .map(BlockId::parse)
            .transpose()
            .ok()?,
    };
    check(&link).ok()?;
    Some(link)
}

/// Encode a v3 link, replacing only its known fields in the previous value.
/// Retain the previous raw value when editing or serializing a clipboard
/// mark: decoding into the domain type alone cannot retain unknown fields.
/// A non-map previous value is refused before any document mutation.
pub fn encode_entity_link(link: &EntityLinkV3, previous: Option<&LoroValue>) -> Result<LoroValue> {
    check(link)?;
    let mut map: BTreeMap<String, LoroValue> = match previous {
        None | Some(LoroValue::Null) => BTreeMap::new(),
        Some(LoroValue::Map(m)) => m.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        _ => return Err(invalid()),
    };
    map.insert("kind".into(), link.kind.as_str().into());
    for (key, value) in [
        ("module", link.module.as_ref().map(ModuleId::as_str)),
        ("block", link.block.as_ref().map(BlockId::as_str)),
        ("end_block", link.end_block.as_ref().map(BlockId::as_str)),
    ] {
        if let Some(value) = value {
            map.insert(key.into(), value.into());
        } else {
            map.remove(key);
        }
    }
    Ok(LoroValue::Map(map.into_iter().collect::<Vec<_>>().into()))
}

/// One raw entity mark with Unicode-scalar offsets relative to the copied
/// text. Unknown link values are deliberately retained, not made actionable.
pub type EntityLinkMarkV3 = (Range<usize>, String, LoroValue);

/// Owned entity marks for a copied range. It contains no live document or
/// writer; callers copy the text/styles separately, then apply these marks
/// in the same target transaction. Keep raw values in clipboard codecs.
#[derive(Clone, Debug, PartialEq)]
pub struct EntityLinkMarksV3 {
    len: usize,
    marks: Vec<EntityLinkMarkV3>,
}

impl EntityLinkMarksV3 {
    /// Validate raw clipboard records before applying any of them. Unknown
    /// value fields and kinds are opaque; invalid ranges/keys are refused.
    pub fn from_marks(len: usize, marks: Vec<EntityLinkMarkV3>) -> Result<Self> {
        for (range, key, value) in &marks {
            if range.start >= range.end
                || range.end > len
                || value.is_null()
                || inline::entity_target(key).is_none_or(|id| EntryId::parse(id).is_err())
            {
                return Err(invalid());
            }
        }
        Ok(Self { len, marks })
    }

    pub fn len(&self) -> usize {
        self.len
    }
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
    pub fn marks(&self) -> &[EntityLinkMarkV3] {
        &self.marks
    }

    fn all(text: &LoroText) -> Self {
        let delta = text.to_delta();
        let len = delta_len(&delta);
        Self::read_delta(delta, 0..len).expect("range derived from the same immutable delta")
    }

    pub(crate) fn read(text: &LoroText, range: Range<usize>) -> Result<Self> {
        Self::read_delta(text.to_delta(), range)
    }

    fn read_delta(delta: Vec<TextDelta>, range: Range<usize>) -> Result<Self> {
        let mut marks = Vec::new();
        segments_of(delta, range.clone(), |span, attrs| {
            for (key, value) in attrs {
                if inline::entity_target(&key).is_some() && !value.is_null() {
                    marks.push((span.start - range.start..span.end - range.start, key, value));
                }
            }
            Ok(())
        })?;
        // Unknown existing target ids/values are opaque while copying.
        Ok(Self {
            len: range.len(),
            marks,
        })
    }

    pub(crate) fn apply(&self, text: &LoroText, at: usize) -> Result<()> {
        let end = at.checked_add(self.len).ok_or_else(invalid)?;
        check_range(text, &(at..end))?;
        let have = Self::read(text, at..end)?;
        for (_, key, _) in have.marks {
            text.unmark(at..end, &key)?;
        }
        for (range, key, value) in &self.marks {
            // Imported/pasted records may span newlines. Body marks never
            // attach to those; U+2028 cell line breaks remain ordinary text.
            segments(text, at + range.start..at + range.end, |range, _| {
                text.mark(range, key, value.clone())?;
                Ok(())
            })?;
        }
        Ok(())
    }

    fn links(&self) -> Vec<(Range<usize>, EntityLinkV3)> {
        let mut by_target: BTreeMap<String, Vec<(Range<usize>, EntityLinkV3)>> = BTreeMap::new();
        for (range, key, value) in &self.marks {
            if let Some(target) = inline::entity_target(key)
                && let Some(link) = decode_entity_link(target, value)
            {
                let list = by_target.entry(target.to_owned()).or_default();
                if let Some((previous, last)) = list.last_mut()
                    && previous.end == range.start
                    && *last == link
                {
                    previous.end = range.end;
                } else {
                    list.push((range.clone(), link));
                }
            }
        }
        let mut links: Vec<_> = by_target.into_values().flatten().collect();
        links.sort_by(|a, b| (a.0.start, &a.1.target).cmp(&(b.0.start, &b.1.target)));
        links
    }
}

impl ProseView<'_> {
    /// v3 links, splitting adjacent links whenever module or block range
    /// changes. Different targets can overlap; paragraph breaks never join.
    pub fn entity_links_v3(&self) -> Vec<(Range<usize>, EntityLinkV3)> {
        EntityLinkMarksV3::all(self.text).links()
    }

    pub fn copy_entity_links_v3(&self, range: Range<usize>) -> Result<EntityLinkMarksV3> {
        EntityLinkMarksV3::read(self.text, range)
    }

    pub fn table_cell_entity_links_v3(
        &self,
        table: &EmbedId,
        row: &str,
        col: &str,
    ) -> Option<Vec<(Range<usize>, EntityLinkV3)>> {
        let cell = self.table_cell_text(table, row, col)?;
        Some(EntityLinkMarksV3::all(&cell).links())
    }

    pub fn copy_table_cell_entity_links_v3(
        &self,
        table: &EmbedId,
        row: &str,
        col: &str,
        range: Range<usize>,
    ) -> Result<EntityLinkMarksV3> {
        let cell = cell(self, table, row, col)?;
        EntityLinkMarksV3::read(&cell, range)
    }
}

impl ProseTxn<'_> {
    /// Edit only this target's mark, preserving unknown fields on each
    /// affected segment. Validate all segments before the first mutation.
    pub fn link_entity_v3(&mut self, range: Range<usize>, link: &EntityLinkV3) -> Result<()> {
        link_text(self.view.text, range, link)
    }

    /// Write a link in an existing table cell, with the same preflight and
    /// metadata-preserving rules as the body. Missing cells are not created.
    pub fn link_table_cell_entity_v3(
        &mut self,
        table: &EmbedId,
        row: &str,
        col: &str,
        range: Range<usize>,
        link: &EntityLinkV3,
    ) -> Result<()> {
        link_text(&cell(&self.view, table, row, col)?, range, link)
    }

    pub fn apply_table_cell_entity_links_v3(
        &mut self,
        table: &EmbedId,
        row: &str,
        col: &str,
        at: usize,
        marks: &EntityLinkMarksV3,
    ) -> Result<()> {
        marks.apply(&cell(&self.view, table, row, col)?, at)
    }

    /// Replace a table cell's text, inline styles, and v3 entity links in one
    /// preflighted write. Validates the table/row/col coordinates, profile
    /// style rules, character ranges, and v3 link targets before mutating Loro.
    pub fn set_table_cell_runs_v3(
        &mut self,
        table: &EmbedId,
        row: &str,
        col: &str,
        runs: &[super::Run],
        links: &[(Range<usize>, EntityLinkV3)],
    ) -> Result<()> {
        match self.view.embed(table) {
            Some(super::EmbedView::Table { rows, cols, .. })
                if rows.iter().any(|r| r.id == row) && cols.iter().any(|c| c.id == col) => {}
            _ => {
                return Err(DocError::Missing {
                    collection: "table cell",
                    id: format!("{table}/{row}/{col}"),
                });
            }
        }
        let text: String = runs.iter().map(|r| r.text.as_str()).collect();
        if text.contains(PARAGRAPH_END) {
            return Err(DocError::NewlineInText);
        }
        let len = text.chars().count();
        for r in runs {
            for style in super::txn::styles_of(&r.marks) {
                self.check_style(&style)?;
            }
        }
        for (range, link) in links {
            if range.start > range.end || range.end > len {
                return Err(DocError::BadRange {
                    start: range.start,
                    end: range.end,
                    len,
                });
            }
            check(link)?;
        }
        let cell = self.table(table)?.cell(row, col)?;
        let old_len = cell.len_unicode();
        let old_links = EntityLinkMarksV3::read(&cell, 0..old_len)?;
        cell.update(&text, Default::default())
            .map_err(|_| loro::LoroError::ArgErr("cell update timed out".into()))?;
        if len > 0 {
            for key in [
                super::StyleKey::Bold,
                super::StyleKey::Italic,
                super::StyleKey::Underline,
                super::StyleKey::Strike,
                super::StyleKey::Link,
                super::StyleKey::Highlight,
                super::StyleKey::Code,
            ] {
                cell.unmark(0..len, key.key())?;
            }
            let cur_links = EntityLinkMarksV3::read(&cell, 0..len)?;
            for (_, key, _) in old_links.marks.into_iter().chain(cur_links.marks) {
                cell.unmark(0..len, &key)?;
            }
            let mut at = 0;
            for r in runs {
                let r_range = at..at + r.text.chars().count();
                at = r_range.end;
                if r_range.is_empty() {
                    continue;
                }
                for style in super::txn::styles_of(&r.marks) {
                    let (key, value) = super::txn::style_mark(&style);
                    cell.mark(r_range.clone(), key, value)?;
                }
            }
            for (range, link) in links {
                if !range.is_empty() {
                    link_text(&cell, range.clone(), link)?;
                }
            }
        }
        Ok(())
    }

    /// Replace entity marks only in the already-inserted copied text. Does
    /// not touch surrounding links, styles, text, or any other document.
    pub fn apply_entity_links_v3(&mut self, at: usize, marks: &EntityLinkMarksV3) -> Result<()> {
        marks.apply(self.view.text, at)
    }
}

fn cell(view: &ProseView<'_>, table: &EmbedId, row: &str, col: &str) -> Result<LoroText> {
    view.table_cell_text(table, row, col)
        .ok_or_else(|| DocError::Missing {
            collection: "table cell",
            id: format!("{table}/{row}/{col}"),
        })
}

fn link_text(text: &LoroText, range: Range<usize>, link: &EntityLinkV3) -> Result<()> {
    let key = inline::entity_key(&link.target);
    check(link)?;
    let mut planned = Vec::new();
    segments(text, range, |range, attrs| {
        planned.push((range, encode_entity_link(link, attrs.get(&key))?));
        Ok(())
    })?;
    for (range, value) in planned {
        text.mark(range, &key, value)?;
    }
    Ok(())
}

fn check_range(text: &LoroText, range: &Range<usize>) -> Result<()> {
    let len = text.len_unicode();
    if range.start > range.end || range.end > len {
        Err(DocError::BadRange {
            start: range.start,
            end: range.end,
            len,
        })
    } else {
        Ok(())
    }
}

fn segments(
    text: &LoroText,
    range: Range<usize>,
    f: impl FnMut(Range<usize>, BTreeMap<String, LoroValue>) -> Result<()>,
) -> Result<()> {
    segments_of(text.to_delta(), range, f)
}

fn delta_len(delta: &[TextDelta]) -> usize {
    delta
        .iter()
        .map(|d| match d {
            TextDelta::Insert { insert, .. } => insert.chars().count(),
            _ => 0,
        })
        .sum()
}

fn segments_of(
    delta: Vec<TextDelta>,
    range: Range<usize>,
    mut f: impl FnMut(Range<usize>, BTreeMap<String, LoroValue>) -> Result<()>,
) -> Result<()> {
    let len = delta_len(&delta);
    if range.start > range.end || range.end > len {
        return Err(DocError::BadRange {
            start: range.start,
            end: range.end,
            len,
        });
    }
    let mut at = 0;
    // Take the delta before invoking callbacks; a callback may write marks.
    for delta in delta {
        if let TextDelta::Insert { insert, attributes } = delta {
            for (i, part) in insert.split(PARAGRAPH_END).enumerate() {
                if i > 0 {
                    at += 1;
                }
                let end = at + part.chars().count();
                let span = at.max(range.start)..end.min(range.end);
                if span.start < span.end {
                    let attrs = attributes
                        .as_ref()
                        .map(|a| a.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                        .unwrap_or_default();
                    f(span, attrs)?;
                }
                at = end;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
