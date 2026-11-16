//! Files into the whole book's prose, as in a chapter editor (`v5-tracks.md`
//! §T5b; the shared half is [`crate::prose_files`]): the slash menu's
//! 「图片或 PDF…」 and its 「从电脑选…」 embed at the caret, below the
//! caret's paragraph, in the caret's chapter (when the system's file window
//! was open the author may have clicked into another chapter meanwhile: the
//! file follows the caret there, `kernel-v5.md` §15 item 49), a drop lands
//! in the chapter under the pointer (between two chapters, the one whose
//! paragraph is nearer), ⌘V and copying or cutting a selection holding
//! embeds work in the caret's chapter. Each embed is a step of that
//! chapter's own undo; after a drop the caret goes to the paragraph after
//! the dropped files, so ⌘Z (which undoes in the caret's chapter) takes the
//! drop back.

use std::rc::Rc;

use dr_workspace::Workspace;
use gpui::{AppContext as _, Bounds, Context, Entity, Pixels, Point, Window};
use gpui_prose::ProseEditor;
use gpui_prose::layout::Item;

use super::BookEditor;
use crate::embeds::NoteEmbeds;
use crate::prose_files::{self, FileView, Place};

/// At most this many list items are looked at for the drop line (what a
/// window shows, with room to spare).
const MAX_DROP_ITEMS: usize = 600;

impl BookEditor {
    /// Chapter `doc`'s tables and embedded files.
    pub fn note_embeds(&self, doc: &str) -> Option<&Rc<NoteEmbeds>> {
        self.embeds.get(self.chapter_of(doc)?)?.as_ref()
    }

    /// Embeds asset `material` (an image or a PDF) at the caret, below the
    /// caret's paragraph, in the caret's chapter, as a chapter editor does.
    /// `chapter` is the chapter the slash menu was opened in: the file
    /// picker's 「从电脑选…」 finishes after the author may have clicked into
    /// another chapter, and the file follows the caret there (`kernel-v5.md`
    /// §15 item 49). When the caret has left `chapter` and the body no
    /// longer has the keyboard (the author went on outside the text), or the
    /// caret's chapter takes no files, it goes to the end of `chapter`, as
    /// before. Returns whether it was.
    pub fn insert_material(
        &mut self,
        chapter: usize,
        material: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Ok(id) = dr_model::id::AssetId::parse(material) else {
            return false;
        };
        let sel = self.editor.read(cx).selection();
        let follow = sel.chapter == chapter || prose_files::body_focused(&self.editor, window, cx);
        let at_caret = follow
            .then(|| self.chapter_embeds(sel.chapter))
            .flatten()
            .map(|embeds| (embeds, sel.head));
        let Some((embeds, offset)) = at_caret.or_else(|| {
            let doc = &self.editor.read(cx).book().chapters.get(chapter)?.doc;
            Some((self.chapter_embeds(chapter)?, doc.max_cursor()))
        }) else {
            return false;
        };
        crate::embeds::insert_material(&embeds, offset, id, cx).is_some()
    }

    /// The gap a drop lands in: `at` (`(chapter, paragraph gap)`), else the
    /// drop line's, else the paragraph after the caret's.
    fn drop_at(&mut self, at: Option<(usize, usize)>, cx: &gpui::App) -> Option<(usize, usize)> {
        at.or_else(|| self.drop_gap.take().map(|g| (g.chapter, g.line)))
            .or_else(|| prose_files::after_caret(self.editor.read(cx)))
    }

    /// Drops library files (or folders) into paragraph gap `at` =
    /// `(chapter, gap)` (`None`: the drop line's, else after the caret's
    /// paragraph).
    pub fn drop_asset_drag(
        &mut self,
        drag: &dr_ui::AssetDrag,
        at: Option<(usize, usize)>,
        cx: &mut Context<Self>,
    ) {
        if let Some((chapter, line)) = self.drop_at(at, cx) {
            prose_files::drop_library(self, drag, chapter, line, cx);
        }
    }

    /// Imports the computer's files into the library and embeds them in
    /// paragraph gap `at` = `(chapter, gap)` (`None`: the drop line's, else
    /// at the caret).
    pub fn drop_external_paths(
        &mut self,
        paths: Vec<std::path::PathBuf>,
        at: Option<(usize, usize)>,
        cx: &mut Context<Self>,
    ) {
        let at = at.or_else(|| self.drop_gap.take().map(|g| (g.chapter, g.line)));
        let (chapter, place) = match at {
            Some((chapter, line)) => (chapter, Place::Gap(line)),
            None => {
                let sel = self.editor.read(cx).selection();
                (sel.chapter, Place::Caret(sel.head))
            }
        };
        prose_files::import_files(self, chapter, paths, place, cx);
    }

    /// The drop line follows the pointer over the paragraphs on screen.
    pub(super) fn update_drop_gap(
        &mut self,
        mouse: Point<Pixels>,
        container: Bounds<Pixels>,
        cx: &mut Context<Self>,
    ) {
        let next = if self.chapters.is_empty() {
            None
        } else {
            let e = self.editor.read(cx);
            let (list, book) = (e.list_state(), e.book());
            let mut lines = Vec::new();
            let top = list.logical_scroll_top().item_ix;
            let mut ix = top;
            while ix < book.item_count() && ix - top < MAX_DROP_ITEMS {
                let Some(bounds) = list.bounds_for_item(ix) else {
                    break;
                };
                if bounds.top() > container.bottom() {
                    break;
                }
                if let Item::Line(chapter, line) = book.item(ix) {
                    lines.push((chapter, line));
                }
                ix += 1;
            }
            let embeds = self.embeds.clone();
            prose_files::drop_gap(
                e,
                lines,
                move |chapter| embeds.get(chapter).cloned().flatten(),
                e.selection().chapter,
                mouse,
                container,
                cx,
            )
        };
        if self.drop_gap != next {
            self.drop_gap = next;
            cx.notify();
        }
    }
}

impl FileView for BookEditor {
    fn file_ws(&self) -> &Workspace {
        &self.ws
    }

    fn file_book(&self) -> &str {
        &self.book
    }

    fn file_prose(&self) -> &Entity<ProseEditor> {
        &self.editor
    }

    fn chapter_embeds(&self, chapter: usize) -> Option<Rc<NoteEmbeds>> {
        self.embeds.get(chapter).cloned().flatten()
    }

    fn doc_embeds(&self, doc: &str) -> Option<Rc<NoteEmbeds>> {
        self.chapter_embeds(self.chapter_of(doc)?)
    }

    /// The caret goes to the paragraph after the dropped files, so ⌘Z (in
    /// the caret's chapter) takes the drop back.
    fn files_dropped(&mut self, embeds: &NoteEmbeds, next: usize, cx: &mut Context<Self>) {
        let chapter = embeds.host().chapter;
        let (editor, window) = (self.editor.clone(), self.window);
        cx.defer(move |cx| {
            let _ = cx.update_window(window, |_, window, cx| {
                editor.update(cx, |e, cx| {
                    let Some(c) = e.book().chapters.get(chapter) else {
                        return;
                    };
                    let line = next.min(c.doc.visible_lines().saturating_sub(1));
                    let at = c.doc.line_start(line);
                    e.select(chapter, at..at, window, cx);
                });
            });
        });
    }
}
