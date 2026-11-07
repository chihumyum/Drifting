//! List items as the author types (material notes: `list`, `list_level`,
//! `checked` and `todo` on the paragraph; how they look is the render
//! layer's, `render/blocks.rs`).
//!
//! - **Enter** in an item continues the list: the paragraph split inherits
//!   `list` and `list_level` (`schema::block::INHERITED_AT_END`), never a
//!   tick or a linked TODO, so a new task starts open.
//! - **Enter in an empty item** leaves the list: a nested item moves one
//!   level out, an item at level 0 becomes a plain paragraph.
//! - **Backspace at an item's start** makes it a plain paragraph (a second
//!   Backspace then joins it to the paragraph above, as usual).
//! - **Tab / ⇧Tab** move the items the selection touches one level in or
//!   out (0–8). Where the selection touches no item the key is left to the
//!   host (and the platform: a tab character).
//! - **⌘↩ / Ctrl+Enter** ticks or unticks the task items the selection
//!   touches, by the same path as a click on the box: the editor sends
//!   [`crate::render::DecorationEvent::TaskClicked`] and the host ticks the item
//!   (its `checked`, or the TODO it is linked to). Where it touches no task
//!   the key is left to the host.
//!
//! - **Markdown shortcuts**, where the host turns them on for documents that
//!   keep lists ([`ProseEditor::set_list_shortcuts`]; Drifting: material
//!   notes): `- `, `* ` or `+ ` at a body paragraph's start makes it a
//!   bullet, `1. ` (any number) an ordered item, `[ ] ` (or `- [ ] `) a
//!   task, `[x] ` a done task. The marker goes away; one undo brings it
//!   back as typed.
//!
//! Each of these is one undo step. Lists exist only where the document
//! allows them (dr-doc keeps them in material notes only), so in chapters
//! none of this ever applies.

use std::ops::Range;

use gpui::{Context, Window};
use loro::LoroValue;

use super::Selection;
use super::actions::{IndentListItem, OutdentListItem, ToggleTask};
use crate::{
    ProseEditor,
    render::blocks::{ListItem, ListMark, list_item},
    schema::block,
    text::{BlockKind, Edit, ORIGIN_USER, ProseDoc},
};

/// The deepest list level.
const MAX_LEVEL: i64 = 8;

/// The paragraph attributes that make a list item.
const LIST_KEYS: &[&str] = &[block::LIST, block::LIST_LEVEL, block::CHECKED, block::TODO];

impl ProseEditor {
    /// Turns the Markdown list shortcuts on or off (off by default: only
    /// for documents that keep lists).
    pub fn set_list_shortcuts(&mut self, on: bool) {
        self.input.list_shortcuts = on;
    }

    /// The Markdown list shortcut the author just finished typing, if any:
    /// the marker goes, the paragraph becomes an item (its own undo step).
    /// Returns whether it applied.
    pub(crate) fn list_shortcut(
        &mut self,
        typed: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let sel = self.selection;
        if !self.input.list_shortcuts || !typed.ends_with(' ') || !sel.is_empty() {
            return false;
        }
        let doc = &self.book.chapters[sel.chapter].doc;
        let (line, inner) = doc.locate(sel.head);
        let paragraph = doc.line(line);
        if paragraph.kind != BlockKind::Body || list_item(&paragraph.block).is_some() {
            return false;
        }
        let before = &paragraph.text[..paragraph.byte_of_char(inner)];
        let Some((kind, done)) = shortcut(before) else {
            return false;
        };
        let marker = inner;
        self.edit(window, cx, |doc, sel| {
            doc.checkpoint();
            let start = doc.line_start(line);
            doc.delete(start..start + marker, ORIGIN_USER);
            let newline = newline_of(doc, line);
            let mut edits = vec![Edit::SetBlockAttr {
                newline,
                key: block::LIST,
                value: Some(kind.into()),
            }];
            if done {
                edits.push(Edit::SetBlockAttr {
                    newline,
                    key: block::CHECKED,
                    value: Some(true.into()),
                });
            }
            doc.edit_batch(&edits, ORIGIN_USER);
            *sel = Selection::caret(sel.chapter, start);
        });
        true
    }

    /// The list item paragraph `line` of `chapter` is, if any.
    pub fn list_item_at(&self, chapter: usize, line: usize) -> Option<ListItem> {
        let doc = &self.book.chapters.get(chapter)?.doc;
        list_item(&doc.lines().get(line)?.block)
    }

    /// The paragraphs the selection touches (one chapter; a selection that
    /// ends at a paragraph's start does not touch that paragraph).
    fn selected_lines(&self) -> Range<usize> {
        let sel = self.selection;
        let doc = &self.book.chapters[sel.chapter].doc;
        let range = sel.range();
        let (first, _) = doc.locate(range.start);
        let (mut last, inner) = doc.locate(range.end);
        if !range.is_empty() && inner == 0 && last > first {
            last -= 1;
        }
        first..last + 1
    }

    /// Enter in an empty list item: one level out, or out of the list at
    /// level 0. Returns whether it did that (else Enter splits as usual).
    pub(crate) fn newline_in_list(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let sel = self.selection;
        if !sel.is_empty() {
            return false;
        }
        let doc = &self.book.chapters[sel.chapter].doc;
        let (line, _) = doc.locate(sel.head);
        if doc.line(line).chars != 0 {
            return false;
        }
        let Some(item) = list_item(&doc.line(line).block) else {
            return false;
        };
        self.edit(window, cx, |doc, _| {
            doc.checkpoint();
            if item.level > 0 {
                set_level(doc, line, i64::from(item.level) - 1);
            } else {
                leave_list(doc, line);
            }
        });
        true
    }

    /// Backspace with the caret at a list item's start: the item becomes a
    /// plain paragraph. Returns whether it did that.
    pub(crate) fn backspace_in_list(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let sel = self.selection;
        if !sel.is_empty() || self.composition.is_some() {
            return false;
        }
        let doc = &self.book.chapters[sel.chapter].doc;
        let (line, inner) = doc.locate(sel.head);
        if inner != 0 || list_item(&doc.line(line).block).is_none() {
            return false;
        }
        self.edit(window, cx, |doc, _| {
            doc.checkpoint();
            leave_list(doc, line);
        });
        true
    }

    /// Moves the list items the selection touches `delta` levels (Tab: 1,
    /// ⇧Tab: −1). Returns false when the selection touches no list item.
    pub fn shift_list_level(
        &mut self,
        delta: i64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.composition.is_some() || self.selection.spans_chapters() {
            return false;
        }
        let chapter = self.selection.chapter;
        let items: Vec<(usize, i64)> = self
            .selected_lines()
            .filter_map(|line| {
                let item = self.list_item_at(chapter, line)?;
                Some((line, i64::from(item.level)))
            })
            .collect();
        if items.is_empty() {
            return false;
        }
        let moved: Vec<(usize, i64)> = items
            .into_iter()
            .map(|(line, level)| (line, (level + delta).clamp(0, MAX_LEVEL), level))
            .filter(|(_, to, from)| to != from)
            .map(|(line, to, _)| (line, to))
            .collect();
        // At the edge already: the key is still the list's (no tab typed).
        if !moved.is_empty() {
            self.edit(window, cx, |doc, _| {
                doc.checkpoint();
                let newlines: Vec<(usize, Option<LoroValue>)> = moved
                    .iter()
                    .map(|&(line, to)| (newline_of(doc, line), level_value(to)))
                    .collect();
                let edits: Vec<Edit> = newlines
                    .iter()
                    .map(|(newline, value)| Edit::SetBlockAttr {
                        newline: *newline,
                        key: block::LIST_LEVEL,
                        value: value.clone(),
                    })
                    .collect();
                doc.edit_batch(&edits, ORIGIN_USER);
            });
        }
        true
    }

    /// Ticks or unticks the task items the selection touches, through the
    /// host (as a click on their boxes does). Returns false when it touches
    /// no task.
    pub fn toggle_tasks(&mut self, cx: &mut Context<Self>) -> bool {
        if self.composition.is_some() || self.selection.spans_chapters() {
            return false;
        }
        let chapter = self.selection.chapter;
        let tasks: Vec<usize> = self
            .selected_lines()
            .filter(|&line| {
                matches!(
                    self.list_item_at(chapter, line),
                    Some(ListItem {
                        mark: ListMark::Task { .. },
                        ..
                    })
                )
            })
            .collect();
        for &line in &tasks {
            self.task_clicked(chapter, line, cx);
        }
        !tasks.is_empty()
    }

    pub(crate) fn on_indent_list_item(
        &mut self,
        _: &IndentListItem,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.shift_list_level(1, window, cx) {
            cx.propagate();
        }
    }

    pub(crate) fn on_outdent_list_item(
        &mut self,
        _: &OutdentListItem,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.shift_list_level(-1, window, cx) {
            cx.propagate();
        }
    }

    pub(crate) fn on_toggle_task(
        &mut self,
        _: &ToggleTask,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.toggle_tasks(cx) {
            cx.propagate();
        }
    }
}

/// The list a Markdown marker (the whole paragraph text before the caret)
/// makes: its kind and whether a task is done.
fn shortcut(before: &str) -> Option<(&'static str, bool)> {
    Some(match before {
        "- " | "* " | "+ " => ("bullet", false),
        "[ ] " | "[] " | "- [ ] " => ("task", false),
        "[x] " | "[X] " | "- [x] " | "- [X] " => ("task", true),
        _ => {
            let number = before.strip_suffix(". ")?;
            if number.is_empty() || number.len() > 9 || !number.bytes().all(|b| b.is_ascii_digit())
            {
                return None;
            }
            ("ordered", false)
        }
    })
}

fn newline_of(doc: &ProseDoc, line: usize) -> usize {
    doc.line_start(line) + doc.line(line).chars
}

/// Level 0 is stored as no level.
fn level_value(level: i64) -> Option<LoroValue> {
    (level > 0).then_some(LoroValue::I64(level))
}

fn set_level(doc: &mut ProseDoc, line: usize, level: i64) {
    doc.set_block_attr(line, block::LIST_LEVEL, level_value(level), ORIGIN_USER);
}

/// Takes the list attributes off paragraph `line`, in one commit.
fn leave_list(doc: &mut ProseDoc, line: usize) {
    let newline = newline_of(doc, line);
    let edits: Vec<Edit> = LIST_KEYS
        .iter()
        .filter(|&&key| doc.line(line).block.get(key).is_some())
        .map(|&key| Edit::SetBlockAttr {
            newline,
            key,
            value: None,
        })
        .collect();
    if !edits.is_empty() {
        doc.edit_batch(&edits, ORIGIN_USER);
    }
}

#[cfg(test)]
mod tests {
    use super::shortcut;

    #[test]
    fn markdown_markers() {
        assert_eq!(shortcut("- "), Some(("bullet", false)));
        assert_eq!(shortcut("* "), Some(("bullet", false)));
        assert_eq!(shortcut("12. "), Some(("ordered", false)));
        assert_eq!(shortcut("[ ] "), Some(("task", false)));
        assert_eq!(shortcut("- [x] "), Some(("task", true)));
        for no in ["-", "a. ", ". ", "1.", "1.  ", "一. ", "x- ", "- - "] {
            assert_eq!(shortcut(no), None, "{no:?}");
        }
    }
}
