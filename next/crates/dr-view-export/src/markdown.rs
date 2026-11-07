//! 「分享」: the 0.1 client's `MarkdownShareDialog`. The whole book or one
//! page as Markdown, shown read-only line by line (a whole book is long:
//! only the lines in view are laid out); copy it all, or save a `.md`.

use std::rc::Rc;

use dr_export::{MarkdownDoc, MarkdownTarget};
use dr_i18n::{I18n, keys};
use dr_ui::components::{Button, Dialog, Loading};
use dr_ui::sand::{self, Icon};
use dr_ui::style::DrStyled;
use dr_ui::tokens::{radius, space};
use dr_ui::{Theme, fonts::Role};
use dr_workspace::Workspace;
use gpui::{
    AnyElement, ClipboardItem, Context, IntoElement, ListAlignment, ListState, ParentElement,
    SharedString, Styled, Task, Window, div, list, px,
};

use crate::ExportDialog;

use keys::markdown_share as share;

/// The dialog's width (the 0.1 card's).
pub const WIDTH: f32 = 800.0;
/// The sheet's height at most; less in a short window.
const SHEET_HEIGHT: f32 = 420.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Copy,
    Save,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Feedback {
    Copied,
    Saved,
    Failed,
}

pub struct MarkdownState {
    lib: Option<Workspace>,
    book: String,
    pub target: MarkdownTarget,
    i18n: I18n,
    pub doc: Option<MarkdownDoc>,
    lines: Rc<Vec<SharedString>>,
    list: ListState,
    pub load_failed: bool,
    pub action: Option<Action>,
    pub feedback: Option<Feedback>,
    task: Option<Task<()>>,
}

impl MarkdownState {
    pub(crate) fn new(
        lib: Option<Workspace>,
        book: String,
        target: MarkdownTarget,
        i18n: I18n,
        cx: &mut Context<ExportDialog>,
    ) -> MarkdownState {
        let mut state = MarkdownState {
            lib,
            book,
            target,
            i18n,
            doc: None,
            lines: Rc::new(Vec::new()),
            list: ListState::new(0, ListAlignment::Top, px(400.0)),
            load_failed: false,
            action: None,
            feedback: None,
            task: None,
        };
        state.load(cx);
        state
    }

    /// Reads the Markdown (again, after a failure).
    pub fn load(&mut self, cx: &mut Context<ExportDialog>) {
        let Some(lib) = self.lib.clone() else {
            self.load_failed = true;
            return;
        };
        self.load_failed = false;
        let (book, target) = (self.book.clone(), self.target.clone());
        self.task = Some(cx.spawn(async move |this, cx| {
            let read = cx
                .background_executor()
                .spawn(async move { dr_export::markdown(&lib, &book, &target) })
                .await;
            this.update(cx, |d, cx| {
                if let Some(m) = d.markdown_mut() {
                    match read {
                        Ok(doc) => m.set_doc(doc),
                        Err(error) => {
                            log::warn!("share: reading the Markdown: {error}");
                            m.load_failed = true;
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn set_doc(&mut self, doc: MarkdownDoc) {
        let lines: Vec<SharedString> = doc
            .markdown
            .split('\n')
            .map(|l| SharedString::from(l.to_owned()))
            .collect();
        self.list = ListState::new(lines.len(), ListAlignment::Top, px(400.0));
        self.lines = Rc::new(lines);
        self.doc = Some(doc);
    }

    /// Characters as the 0.1 dialog counted them (JavaScript's `length`).
    pub fn characters(&self) -> Option<usize> {
        self.doc.as_ref().map(|d| d.markdown.encode_utf16().count())
    }

    /// Copies it all.
    pub fn copy(&mut self, cx: &mut Context<ExportDialog>) {
        let Some(doc) = &self.doc else {
            return;
        };
        cx.write_to_clipboard(ClipboardItem::new_string(doc.markdown.clone()));
        self.feedback = Some(Feedback::Copied);
    }

    /// Asks where, then writes the `.md`.
    pub fn save(&mut self, cx: &mut Context<ExportDialog>) {
        if self.action.is_some() {
            return;
        }
        let Some(doc) = &self.doc else {
            return;
        };
        let path = cx.prompt_for_new_path(&crate::start_dir(), Some(&doc.filename));
        let text = doc.markdown.clone();
        self.action = Some(Action::Save);
        self.feedback = None;
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = match path.await {
                Ok(Ok(Some(path))) => Some(
                    cx.background_executor()
                        .spawn(async move { dr_export::write_file(&path, text.as_bytes()) })
                        .await
                        .map_err(|e| e.to_string()),
                ),
                Ok(Err(error)) => Some(Err(error.to_string())),
                _ => None,
            };
            this.update(cx, |d, cx| {
                if let Some(m) = d.markdown_mut() {
                    m.action = None;
                    m.feedback = match result {
                        None => None,
                        Some(Ok(())) => Some(Feedback::Saved),
                        Some(Err(error)) => {
                            log::warn!("share: saving the Markdown: {error}");
                            Some(Feedback::Failed)
                        }
                    };
                }
                cx.notify();
            })
            .ok();
        }));
    }
}

pub(crate) fn render(
    dialog: &mut ExportDialog,
    window: &mut Window,
    cx: &mut Context<ExportDialog>,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let (p, s) = (theme.palette, theme.scale);
    let this = cx.entity();
    let Some(m) = dialog.markdown() else {
        return div().into_any_element();
    };
    let i18n = &m.i18n;
    let t = |key| -> SharedString { i18n.t(key).into() };
    let run = |f: fn(&mut MarkdownState, &mut Context<ExportDialog>)| {
        let this = this.clone();
        move |cx: &mut gpui::App| {
            this.update(cx, |d, cx| {
                if let Some(m) = d.markdown_mut() {
                    f(m, cx);
                }
                cx.notify();
            })
        }
    };
    let viewport = f32::from(window.viewport_size().height);
    let sheet_h = SHEET_HEIGHT.min(viewport - 320.0).max(160.0);
    let small = |text: SharedString| {
        div()
            .font_role(Role::Index)
            .type_px(s.caption, s.line_caption)
            .text_color(p.muted().solid())
            .child(text)
    };

    let filename: SharedString = m
        .doc
        .as_ref()
        .map(|d| d.filename.clone())
        .unwrap_or_default()
        .into();
    let meta = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(space::S2))
        .child(sand::icon(Icon::FileText, 15.0, p.ink(2).solid()))
        .child(
            div()
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .text_color(p.ink(1).solid())
                .child(filename),
        )
        .child(small(t(share::READ_ONLY)));
    let sheet: AnyElement = match &m.doc {
        Some(_) => {
            let lines = m.lines.clone();
            let (ink, caption, line_h) = (p.ink(1).solid(), s.secondary, s.line_body);
            div()
                .h(px(sheet_h))
                .w_full()
                .px(px(space::S5))
                .py(px(space::S3))
                .rounded(px(radius::SM))
                .border(px(0.5))
                .border_color(p.hairline())
                .child(
                    list(m.list.clone(), move |ix, _, _| {
                        div()
                            .w_full()
                            .min_h(px(line_h))
                            .font_role(Role::Index)
                            .type_px(caption, line_h)
                            .text_color(ink)
                            .child(lines[ix].clone())
                            .into_any_element()
                    })
                    .size_full(),
                )
                .into_any_element()
        }
        None if m.load_failed => {
            let retry = run(|m, cx| m.load(cx));
            div()
                .h(px(sheet_h))
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(px(space::S3))
                .child(
                    div()
                        .font_role(Role::Ui)
                        .type_px(s.secondary, s.line_body)
                        .text_color(p.ink(2).solid())
                        .child(t(share::LOAD_FAILED)),
                )
                .child(
                    Button::new("share-retry", t(share::RETRY))
                        .icon(Icon::Rotate)
                        .on_click(move |_, _, cx| retry(cx)),
                )
                .into_any_element()
        }
        None => div()
            .h(px(sheet_h))
            .flex()
            .items_center()
            .justify_center()
            .child(Loading::new("share-loading").label(t(share::LOADING)))
            .into_any_element(),
    };
    let mut caption = div()
        .flex()
        .flex_row()
        .justify_between()
        .gap(px(space::S4))
        .child(small(t(share::PROSE_ONLY)));
    if let Some(n) = m.characters() {
        caption = caption.child(small(i18n.fmt(share::CHARACTERS, &[("count", &n)]).into()));
    }
    let body = div()
        .flex()
        .flex_col()
        .gap(px(space::S3))
        .child(meta)
        .child(sheet)
        .child(caption);

    let ready = m.doc.is_some() && m.action.is_none();
    let save = run(|m, cx| m.save(cx));
    let copy = run(|m, cx| m.copy(cx));
    let dismiss = this.clone();
    let whole = m.target == MarkdownTarget::Book;
    let mut d = Dialog::new("markdown-share", t(share::TITLE))
        .subtitle(t(if whole {
            share::WHOLE_BOOK
        } else {
            share::CURRENT_BODY
        }))
        .width(WIDTH)
        .body(body)
        .action(
            Button::new(
                "share-save",
                t(if m.action == Some(Action::Save) {
                    share::SAVING
                } else {
                    share::SAVE
                }),
            )
            .icon(Icon::CaseRise)
            .busy(m.action == Some(Action::Save))
            .disabled(!ready)
            .on_click(move |_, _, cx| save(cx)),
        )
        .action(
            Button::new("share-copy", t(share::COPY))
                .primary()
                .icon(Icon::Copy)
                .disabled(!ready)
                .on_click(move |_, _, cx| copy(cx)),
        )
        .on_close(move |_, cx| dismiss.update(cx, |d, cx| d.close(cx)));
    let status = match &m.feedback {
        Some(Feedback::Copied) => Some((t(share::COPIED), p.ink(2))),
        Some(Feedback::Saved) => Some((t(share::SAVED), p.ink(2))),
        Some(Feedback::Failed) => Some((t(share::FAILED), p.danger)),
        None => None,
    };
    if let Some((text, color)) = status {
        d = d.status(
            div()
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .text_color(color.solid())
                .child(text),
        );
    }
    d.into_any_element()
}
