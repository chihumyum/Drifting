//! Book-local linked text lives in one mergeable Loro text per field.

use std::iter::repeat_n;

use dr_model::v3::{EntryId, EntryTextLink, LinkedText};
use loro::{Container, LoroMap, LoroText, LoroValue, TextDelta, ValueOrContainer};

use crate::schema::inline;
use crate::{DocError, Result};

// The bare "entity" style is reserved for book-local linked text. Prose
// uses "entity:<target>" to allow overlapping links and carry module/range.
const ENTRY_MARK: &str = inline::ENTITY;

fn read_text(text: &LoroText) -> LinkedText {
    let mut result = LinkedText::default();
    let mut start = 0;
    for delta in text.to_delta() {
        let TextDelta::Insert { insert, attributes } = delta else {
            continue;
        };
        let end = start + insert.chars().count();
        if let Some(LoroValue::String(id)) = attributes.as_ref().and_then(|a| a.get(ENTRY_MARK))
            && let Ok(entry) = EntryId::parse(id.as_str())
            && start < end
        {
            if let Some(last) = result.links.last_mut()
                && last.entry == entry
                && last.end == start
            {
                last.end = end;
            } else {
                result.links.push(EntryTextLink { start, end, entry });
            }
        }
        result.text.push_str(&insert);
        start = end;
    }
    result
}

pub(super) fn read(map: &LoroMap, key: &str) -> Option<LinkedText> {
    match map.get(key)? {
        ValueOrContainer::Container(Container::Text(text)) => Some(read_text(&text)),
        _ => None,
    }
}

fn targets(text: &LinkedText) -> Vec<Option<&EntryId>> {
    let mut entries = Vec::new();
    for link in &text.links {
        entries.resize(link.start, None);
        entries.extend(repeat_n(Some(&link.entry), link.end - link.start));
    }
    entries.resize(text.text.chars().count(), None);
    entries
}

pub(super) fn write(map: &LoroMap, key: &str, value: &LinkedText) -> Result<()> {
    let text = match map.get(key) {
        Some(ValueOrContainer::Container(Container::Text(text))) => text,
        _ => map.ensure_mergeable_text(key)?,
    };
    update(&text, value)
}

pub(super) fn seed_projection(map: &LoroMap, value: &LinkedText) -> Result<()> {
    // Devices can first see different versions of the same prose line.
    // Let the record choose one seeded body. Subsequent edits to that
    // body merge as text operations on its container.
    let text = map.insert_container("body", LoroText::new())?;
    update(&text, value)
}

fn update(text: &LoroText, value: &LinkedText) -> Result<()> {
    value
        .validate()
        .map_err(|_| DocError::NotInProfile("invalid entry link range"))?;
    // Diff the characters before changing their marks. Writing the full
    // value as one register (or replacing all the characters) would lose
    // concurrent edits to different parts of the same field.
    text.update(&value.text, Default::default())
        .map_err(|_| DocError::NotInProfile("linked text update timed out"))?;
    let actual = read_text(text);
    let changes: Vec<_> = targets(&actual).into_iter().zip(targets(value)).collect();
    let mut start = 0;
    while start < changes.len() {
        let (have, want) = changes[start];
        if have == want {
            start += 1;
            continue;
        }
        let mut end = start + 1;
        while end < changes.len() && changes[end].0 != want && changes[end].1 == want {
            end += 1;
        }
        if let Some(entry) = want {
            text.mark(start..end, ENTRY_MARK, entry.as_str())?;
        } else {
            text.unmark(start..end, ENTRY_MARK)?;
        }
        start = end;
    }
    Ok(())
}
