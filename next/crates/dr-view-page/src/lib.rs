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
//!   H2 and H3, then search and the timeline with their keys) and the room
//!   under the text. The 0.1 client's chapter-end mark and its actions are
//!   not here (`kernel-v5.md` §15, item 34).
//!
//! Heads and ends are views of their own inside the editor's scroll, so
//! their fields redraw without the editor. Writes go through
//! dr-editor's `page::*` on a background thread; what they change comes
//! back with the editor's next `PageInfo`.
//!
//! The app registers it once with [`init`], after `dr_shell::init`. Chapter
//! and idea pages get the head and end (an idea's folio says 「构想」);
//! other pages get nothing.

pub mod custom;
pub mod end;
pub mod entry_head;
pub mod head;
mod history;
mod links;
pub mod media;
mod relations;
pub mod settlement;
pub mod v3;
pub mod whole;

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use dr_editor::page::{PageChrome, PageInfo};
use dr_shell::pages::{PageEditorRef, PageHost};
use dr_ui::tokens::page as tk;
use gpui::{
    AnyElement, App, AppContext as _, Entity, Global, IntoElement, ParentElement as _, Styled as _,
    WeakEntity, Window, div,
};

pub use end::PageEnd;
pub use head::PageHead;

/// Registers the chrome with the shell: every chapter, idea and whole-book
/// editor it opens gets one.
pub fn init(cx: &mut App) {
    links::init(cx);
    // The shell owns the rail; the editor owns its painted relation layer.
    // This host connects their app-global seams without a view-to-editor
    // dependency in dr-view-relations.
    let relay = |cx: &mut App| {
        dr_editor::assist::relate::RelationFocus::point(
            dr_shell::relations::rail_hover(cx).map(|row| row.row),
            cx,
        );
    };
    relay(cx);
    cx.observe_global::<dr_shell::relations::RailHover>(relay)
        .detach();
    settlement::init(cx);
    history::init(cx);
    entry_head::register(cx);
    v3::register(cx);
    relations::register(cx);
    dr_shell::v3::history::register(cx);
    dr_shell::v3::register_entry_comment_card(cx);
}

/// A page's head and end.
type Views = (Entity<PageHead>, Entity<PageEnd>);

/// One editor's chrome: the head and end views of each of its pages, made
/// the first time the page is drawn and kept while the editor lives.
pub struct Chrome {
    host: PageHost,
    book: Option<Rc<dr_shell::book::Book>>,
    /// Whether the head draws the page's title: not on an entry page, whose
    /// own head is the one title (`kernel-v5.md` §8).
    titled: bool,
    pages: RefCell<HashMap<String, Views>>,
}

impl Chrome {
    pub fn new(host: PageHost) -> Chrome {
        Chrome {
            host,
            book: None,
            titled: true,
            pages: RefCell::default(),
        }
    }

    /// Bind chrome to an already validated canonical snapshot when the host
    /// is not itself the shell (e.g. a standalone module preview). Writes
    /// still use the captured per-field CAS guards and settlement pipeline.
    pub fn with_book(host: PageHost, book: Rc<dr_shell::book::Book>) -> Self {
        Self {
            host,
            book: Some(book),
            titled: true,
            pages: RefCell::default(),
        }
    }

    /// The chrome of a body on an entry page: the page's own head has the
    /// title and its fields the synopsis, so the body draws no head of its
    /// own (UP, kernel-v5 §15 item 50: it drew a folio line, the synopsis
    /// again and two rules). Its head views are still made and kept up to
    /// date ([`page_views`]); only the end is drawn.
    pub fn on_entry_page(mut self) -> Self {
        self.titled = false;
        self
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
                let titled = self.titled;
                let head = cx.new(|cx| {
                    PageHead::new_with_book(host, page, self.book.clone(), titled, window, cx)
                });
                let end = cx.new(|_| PageEnd::new(page));
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
        if !page.chrome {
            return None;
        }
        let (head, _) = self.views(page, window, cx);
        if !self.titled {
            return None;
        }
        Some(div().w_full().child(head).into_any_element())
    }

    fn end(&self, page: &PageInfo, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
        if !page.chrome {
            return None;
        }
        let (_, end) = self.views(page, window, cx);
        Some(div().w_full().child(end).into_any_element())
    }

    fn head_estimate(&self, page: &PageInfo) -> f32 {
        if !page.chrome || !self.titled {
            return 0.0;
        }
        let synopsis = if page.has_synopsis {
            24.0 + tk::SYNOPSIS_GAP
        } else {
            0.0
        };
        // On an entry page the title is the page's own head's.
        let title = if self.titled {
            tk::TITLE_SIZE * tk::TITLE_LINE + tk::TITLE_GAP
        } else {
            0.0
        };
        tk::TOP
            + tk::FOLIO_LINE
            + tk::FOLIO_PAD
            + tk::FOLIO_MARGIN
            + title
            + synopsis
            + 1.0
            + tk::RULE_GAP
    }

    fn end_estimate(&self, page: &PageInfo) -> f32 {
        if !page.chrome {
            return 0.0;
        }
        let hints = if page.empty {
            tk::HINTS_TOP + 140.0
        } else {
            0.0
        };
        hints + tk::BOTTOM
    }
}

/// The kind of field a page's title is.
pub type TitleField = dr_ui::input::TextArea;

/// The title field of the page showing `doc`: the body's own head in the
/// whole book or a standalone editor, else the head of `entry`'s page (one
/// title per entry, `kernel-v5.md` §8). For the debug bridge and tests.
pub fn title_field(doc: &str, entry: Option<&str>, cx: &App) -> Option<Entity<TitleField>> {
    if let Some((head, _)) = page_views(doc, cx)
        && head.read(cx).shows_title()
    {
        return Some(head.read(cx).title().clone());
    }
    entry_head::head_of(entry?, cx).map(|head| head.read(cx).title().clone())
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

/// Select the title the first time a newly created page is drawn.
/// Pair with `Open::KEEP.at_title()` so the shell leaves focus to the title.
/// Use the entry's `Target::key()` (`entry:<id>`) for a v3 page, including
/// entries without prose. Document chrome can still request it by doc key.
pub fn focus_new_title(key: String, cx: &mut App) {
    cx.default_global::<NewTitles>().0.push(key);
}

#[derive(Default)]
pub(crate) struct NewTitles(Vec<String>);

impl Global for NewTitles {}

impl NewTitles {
    pub fn pending_entry(entry: &str, cx: &App) -> bool {
        cx.try_global::<Self>()
            .is_some_and(|list| list.0.iter().any(|key| Self::matches_entry(key, entry)))
    }

    /// Take an entry's title request, including older requests by body key.
    pub fn take_entry(entry: &str, cx: &mut App) -> bool {
        if !Self::pending_entry(entry, cx) {
            return false;
        }
        cx.global_mut::<NewTitles>()
            .0
            .retain(|key| !Self::matches_entry(key, entry));
        true
    }

    fn matches_entry(key: &str, entry: &str) -> bool {
        key.strip_prefix("entry:") == Some(entry)
            || key
                .strip_prefix("body:")
                .and_then(|body| body.split_once('/'))
                .is_some_and(|(id, _)| id == entry)
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
