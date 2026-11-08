//! The chapter page around its text (M03), drawn through dr-editor's
//! [`PageChrome`]: what the 0.1 client's chapter page has above and below
//! the prose (`NodeEditorView.tsx`, `ChapterEditor.tsx`,
//! `ChapterEndOrnament.tsx`, `ChapterEmptyHints.tsx`, the whole book's act
//! breaks in `AllChaptersEditorView.tsx`).
//!
//! - **Head** ([`head::PageHead`]): in the whole book, an act's title page
//!   (「第一幕」, its name, a dry stroke, 「N 章 · x.xk 字」) above the
//!   chapter that opens it; the folio line 「第 N 章 · 故事线 ·
//!   字数」 over a dotted rule; the title, a borderless field that wraps
//!   (Enter or ↓ at its end hands the caret to the text, Esc puts the stored
//!   title back, leaving it stores it); the synopsis, a borderless multi-line
//!   field (stored when it is left, Esc puts it back); the rule.
//! - **End** ([`end::PageEnd`]): an empty page's hint (the Markdown for H1,
//!   H2 and H3, then search and the timeline with their keys), and ⁂. The
//!   pointer resting on ⁂ turns it into its actions: 「标为完成」 or
//!   「改回草稿」 and 「新建下一章」, which makes the chapter, opens it and
//!   puts the caret in its title, selected.
//!
//! Heads and ends are views of their own inside the editor's scroll, so
//! their fields and menu redraw without the editor. Writes go through
//! dr-editor's `page::*` on a background thread; what they change comes
//! back with the editor's next `PageInfo`.
//!
//! The app registers it once with [`init`], after `dr_shell::init`. Chapter
//! and idea pages get the head and end (an idea's folio says 「构想」, its ⁂
//! has no actions); other pages get nothing.

pub mod end;
pub mod head;

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use dr_editor::page::{PageChrome, PageInfo, PageKind};
use dr_shell::nav::Target;
use dr_shell::pages::{PageEditorRef, PageHost};
use dr_ui::tokens::page as tk;
use gpui::{
    AnyElement, App, AppContext as _, Entity, Global, IntoElement, ParentElement as _, Styled as _,
    WeakEntity, Window, div,
};

pub use end::{EndAction, PageEnd};
pub use head::PageHead;

/// Registers the chrome with the shell: every chapter, idea and whole-book
/// editor it opens gets one.
pub fn init(cx: &mut App) {
    dr_shell::pages::add_page_chrome(cx, |target, host, _, _| match target {
        Target::Chapter(_) | Target::Idea(_) | Target::Book => {
            Some(Rc::new(Chrome::new(host)) as Rc<dyn PageChrome>)
        }
        _ => None,
    });
}

/// A page's head and end.
type Views = (Entity<PageHead>, Entity<PageEnd>);

/// One editor's chrome: the head and end views of each of its pages, made
/// the first time the page is drawn and kept while the editor lives.
pub struct Chrome {
    host: PageHost,
    pages: RefCell<HashMap<String, Views>>,
}

impl Chrome {
    pub fn new(host: PageHost) -> Chrome {
        Chrome {
            host,
            pages: RefCell::default(),
        }
    }

    /// The head and end views of `page`, and their facts brought up to date.
    pub fn views(
        &self,
        page: &PageInfo,
        window: &mut Window,
        cx: &mut App,
    ) -> (Entity<PageHead>, Entity<PageEnd>) {
        let known = self.pages.borrow().get(&page.doc).cloned();
        let (head, end) = match known {
            Some(views) => views,
            None => {
                let host = self.host.clone();
                let head = cx.new(|cx| PageHead::new(host.clone(), page, window, cx));
                let end = cx.new(|_| PageEnd::new(host, page));
                self.pages
                    .borrow_mut()
                    .insert(page.doc.clone(), (head.clone(), end.clone()));
                cx.default_global::<Made>()
                    .0
                    .insert(page.doc.clone(), (head.downgrade(), end.downgrade()));
                (head, end)
            }
        };
        head.update(cx, |h, cx| h.set_page(page, window, cx));
        end.update(cx, |e, _| e.set_page(page));
        (head, end)
    }
}

impl PageChrome for Chrome {
    fn head(&self, page: &PageInfo, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
        if page.kind == PageKind::Other {
            return None;
        }
        let (head, _) = self.views(page, window, cx);
        Some(div().w_full().child(head).into_any_element())
    }

    fn end(&self, page: &PageInfo, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
        if page.kind == PageKind::Other {
            return None;
        }
        let (_, end) = self.views(page, window, cx);
        Some(div().w_full().child(end).into_any_element())
    }

    fn head_estimate(&self, page: &PageInfo) -> f32 {
        let act = if page.act_page.is_some() {
            tk::ACT_TOP
                + tk::ACT_ORDINAL_SIZE
                + tk::ACT_ORDINAL_GAP
                + tk::ACT_NAME_SIZE * tk::ACT_NAME_LINE
                + tk::ACT_GAP
                + 10.0
                + tk::ACT_GAP
                + tk::ACT_META_LINE
                + tk::ACT_BOTTOM
        } else {
            0.0
        };
        act + tk::TOP
            + tk::FOLIO_LINE
            + tk::FOLIO_PAD
            + tk::FOLIO_MARGIN
            + tk::TITLE_SIZE * tk::TITLE_LINE
            + tk::TITLE_GAP
            + 24.0
            + tk::SYNOPSIS_GAP
            + 1.0
            + tk::RULE_GAP
    }

    fn end_estimate(&self, page: &PageInfo) -> f32 {
        let hints = if page.empty {
            tk::HINTS_TOP + 140.0
        } else {
            0.0
        };
        hints + tk::ORNAMENT_TOP + tk::ORNAMENT_TARGET.1 + tk::ORNAMENT_BOTTOM + tk::BOTTOM
    }
}

/// The head and end views made last for `doc` (in whichever editor drew it
/// last), while they live: for the shell and for tests.
pub fn page_views(doc: &str, cx: &App) -> Option<(Entity<PageHead>, Entity<PageEnd>)> {
    let (head, end) = cx.try_global::<Made>()?.0.get(doc)?;
    Some((head.upgrade()?, end.upgrade()?))
}

#[derive(Default)]
struct Made(HashMap<String, (WeakEntity<PageHead>, WeakEntity<PageEnd>)>);

impl Global for Made {}

/// Hands the caret to `doc`'s text in the editor the chrome sits in.
pub(crate) fn focus_body(host: &PageHost, doc: &str, window: &mut Window, cx: &mut App) {
    match &host.editor {
        PageEditorRef::Doc(e) => {
            let _ = e.update(cx, |e, cx| e.focus_body(window, cx));
        }
        PageEditorRef::Book(e) => {
            let _ = e.update(cx, |e, cx| e.focus_body(doc, window, cx));
        }
    }
}

/// Chapters ⁂ just made, whose title takes the caret, selected, when their
/// page is first drawn.
/// Select the title the first time a newly created chapter or idea is drawn.
/// Pair this with the shell's `Open::KEEP.at_title()` so its editor does not
/// take the keyboard before the page head does (M02's create row, M03's ⁂).
pub fn focus_new_title(doc: String, cx: &mut App) {
    NewTitles::add(doc, cx);
}

#[derive(Default)]
pub(crate) struct NewTitles(Vec<String>);

impl Global for NewTitles {}

impl NewTitles {
    pub fn add(doc: String, cx: &mut App) {
        cx.default_global::<NewTitles>().0.push(doc);
    }

    /// Whether `doc` was just made (and forgets it).
    pub fn take(doc: &str, cx: &mut App) -> bool {
        let Some(list) = cx.try_global::<NewTitles>() else {
            return false;
        };
        if !list.0.iter().any(|d| d == doc) {
            return false;
        }
        cx.global_mut::<NewTitles>().0.retain(|d| d != doc);
        true
    }
}
