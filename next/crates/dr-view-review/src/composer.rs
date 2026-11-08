//! The comment composer: a flat floating card that comes up beside the
//! selected text (docs/design-system/components.md, 新建批注): a slip of
//! paper to write on (F5's multi-line input), 「批注 | TODO」 as a row of
//! two, 取消 as a text button and 保存 as the primary one. Enter starts a
//! new line, ⌘↵ (Ctrl+Enter) saves, Esc cancels. The new comment is
//! anchored to the selected characters; once written it counts as chosen,
//! so its sand is drawn along its rows in the prose. The same composer
//! comes up beside a rectangle just drawn on an image or a PDF page (M19,
//! [`CommentComposer::for_region`]); that comment marks the rectangle.

use dr_editor::ChapterEditor;
use dr_editor::decor::ReviewFocus;
use dr_i18n::{I18n, Locale, Platform, keys};
use dr_ui::Theme;
use dr_ui::components::{Button, Segmented};
use dr_ui::fonts::Role;
use dr_ui::input::{FieldEvent, TextArea};
use dr_ui::style::DrStyled;
use dr_ui::tokens::radius;
use dr_workspace::commands::comment::{CommentCreate, CommentCreateIn};
use dr_workspace::dto::{Region, Target};
use dr_workspace::{Actor, Workspace};
use gpui::{
    AppContext, Bounds, Context, ElementId, Entity, EntityInputHandler, EventEmitter, Focusable,
    IntoElement, ParentElement, Pixels, Point, Render, Styled, Subscription, Window, div, point,
    px,
};
use gpui_prose::ProseEditor;

/// The composer is done (saved or cancelled): the host drops it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ComposerEvent {
    Done,
    /// Saved as this comment.
    Saved(String),
}

/// What the new comment is on, beyond its target.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Anchor {
    /// Characters `[start, end)` of the target's prose.
    Range(usize, usize),
    /// A rectangle on an image or a PDF page.
    Region(Region),
}

pub struct CommentComposer {
    ws: Workspace,
    book: String,
    target: Target,
    anchor: Anchor,
    todo: bool,
    field: Entity<TextArea>,
    at: Point<Pixels>,
    i18n: I18n,
    _field: Subscription,
}

impl EventEmitter<ComposerEvent> for CommentComposer {}

/// How wide the composer is.
pub const WIDTH: f32 = 300.0;

impl CommentComposer {
    /// A composer for the selection in a chapter editor, placed under its
    /// last row; `None` without a selection.
    pub fn for_selection(
        editor: &Entity<ChapterEditor>,
        ws: Workspace,
        locale: Locale,
        window: &mut Window,
        cx: &mut gpui::App,
    ) -> Option<Entity<CommentComposer>> {
        let (book, doc, prose) = {
            let e = editor.read(cx);
            (
                e.book_id().to_owned(),
                e.doc_id().to_owned(),
                e.editor().clone(),
            )
        };
        Self::for_prose(&prose, ws, &book, &doc, locale, window, cx)
    }

    /// A composer for the selection in `prose` (any editor: one chapter's,
    /// or the whole book's), the selection being in document `doc` of
    /// `book`; placed under its last row, lined up with where it starts.
    pub fn for_prose(
        prose: &Entity<ProseEditor>,
        ws: Workspace,
        book: &str,
        doc: &str,
        locale: Locale,
        window: &mut Window,
        cx: &mut gpui::App,
    ) -> Option<Entity<CommentComposer>> {
        let (kind, id) = doc.split_once(':')?;
        let target = Target {
            kind: kind.to_owned(),
            id: id.to_owned(),
        };
        let (range, start16, end16) = {
            let e = prose.read(cx);
            let sel = e.selection();
            if sel.is_empty() {
                return None;
            }
            let r = sel.range();
            let doc = &e.book().chapters[sel.chapter].doc;
            (
                (r.start, r.end),
                doc.offset_to_utf16(r.start),
                doc.offset_to_utf16(r.end),
            )
        };
        let (first, last) = prose.update(cx, |e, cx| {
            (
                e.bounds_for_range(start16..start16 + 1, Bounds::default(), window, cx),
                e.bounds_for_range(
                    end16.saturating_sub(1)..end16,
                    Bounds::default(),
                    window,
                    cx,
                ),
            )
        });
        let below = match (first, last) {
            (Some(f), Some(l)) => point(f.left().min(l.left()), l.bottom() + px(8.0)),
            (_, Some(l)) => point(l.left(), l.bottom() + px(8.0)),
            _ => window.mouse_position(),
        };
        let book = book.to_owned();
        Some(cx.new(|cx| CommentComposer::new(ws, book, target, range, below, locale, window, cx)))
    }

    /// A composer for characters `range` of `target`'s prose, its top left
    /// corner at `at`.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        ws: Workspace,
        book: String,
        target: Target,
        range: (usize, usize),
        at: Point<Pixels>,
        locale: Locale,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> CommentComposer {
        let anchor = Anchor::Range(range.0, range.1);
        Self::with_anchor(ws, book, target, anchor, at, locale, window, cx)
    }

    /// A composer for a rectangle on an image or PDF material (`target`),
    /// its top left corner at `at`.
    #[allow(clippy::too_many_arguments)]
    pub fn for_region(
        ws: Workspace,
        book: String,
        target: Target,
        region: Region,
        at: Point<Pixels>,
        locale: Locale,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> CommentComposer {
        let anchor = Anchor::Region(region);
        Self::with_anchor(ws, book, target, anchor, at, locale, window, cx)
    }

    #[allow(clippy::too_many_arguments)]
    fn with_anchor(
        ws: Workspace,
        book: String,
        target: Target,
        anchor: Anchor,
        at: Point<Pixels>,
        locale: Locale,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> CommentComposer {
        let i18n = I18n::new(locale, Platform::current());
        let placeholder = i18n.t(keys::review_panel::COMMENT_PLACEHOLDER).to_owned();
        let field = cx
            .new(|cx| TextArea::new("comment-composer-field", window, cx).placeholder(placeholder));
        let sub = cx.subscribe_in(&field, window, |this, _, e: &FieldEvent, _, cx| match e {
            FieldEvent::Submitted(_) => this.save(cx),
            FieldEvent::Cancelled => cx.emit(ComposerEvent::Done),
            _ => {}
        });
        let handle = field.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
        CommentComposer {
            ws,
            book,
            target,
            anchor,
            todo: false,
            field,
            at,
            i18n,
            _field: sub,
        }
    }

    /// Where its top left corner goes, in the window.
    pub fn position(&self) -> Point<Pixels> {
        self.at
    }

    /// What the new comment will be on.
    pub fn anchor(&self) -> Anchor {
        self.anchor
    }

    pub fn set_todo(&mut self, todo: bool, cx: &mut Context<Self>) {
        self.todo = todo;
        cx.notify();
    }

    pub fn set_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.field.update(cx, |f, cx| f.set_text(text, cx));
    }

    /// Writes the comment (on the selected characters, or the rectangle)
    /// and closes.
    pub fn save(&mut self, cx: &mut Context<Self>) {
        let body = self.field.read(cx).text();
        let (range, region) = match self.anchor {
            Anchor::Range(start, end) => (Some((start, end)), None),
            Anchor::Region(r) => (None, Some(r)),
        };
        let input = CommentCreateIn {
            book: self.book.clone(),
            kind: Some(if self.todo { "todo" } else { "note" }.into()),
            target: Some(self.target.clone()),
            block_id: None,
            range,
            region,
            body,
            priority: None,
            author_name: None,
        };
        let ws = self.ws.clone();
        let task = cx
            .background_executor()
            .spawn(async move { ws.run::<CommentCreate>(&Actor::User, input) });
        cx.spawn(async move |this, cx| {
            let made = task.await;
            this.update(cx, |_, cx| match made {
                Ok(done) => {
                    let id = done.output.id;
                    // Written: chosen, so its sand is drawn along its rows.
                    ReviewFocus::jump(&id, cx);
                    cx.emit(ComposerEvent::Saved(id));
                    cx.emit(ComposerEvent::Done);
                }
                Err(e) => log::warn!("review: comment.create: {e}"),
            })
            .ok();
        })
        .detach();
    }
}

impl Render for CommentComposer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let entity = cx.entity();
        let kinds = [
            self.i18n.t(keys::review_panel::filters::COMMENT).to_owned(),
            self.i18n.t(keys::review_panel::filters::TODO).to_owned(),
        ];
        let (pick, cancel, save) = (entity.clone(), entity.clone(), entity.clone());
        div()
            .w(px(WIDTH))
            .p(px(12.0))
            .flex()
            .flex_col()
            .gap(px(10.0))
            .bg(p.desk.solid())
            .rounded(px(radius::SHEET))
            .border_1()
            .border_color(p.hairline())
            .shadow_md()
            .child(
                Segmented::new(
                    ElementId::Name("comment-composer-kind".into()),
                    kinds,
                    usize::from(self.todo),
                )
                .on_change(move |ix, _, cx| pick.update(cx, |c, cx| c.set_todo(ix == 1, cx))),
            )
            .child(
                // The slip: the paper's colour, the input takes its type.
                div()
                    .min_h(px(theme.scale.line_body * 3.0))
                    .px(px(8.0))
                    .py(px(6.0))
                    .rounded(px(radius::SM))
                    .bg(p.page.solid())
                    .border_1()
                    .border_color(p.hairline())
                    .font_role(Role::Ui)
                    .type_px(theme.scale.secondary, theme.scale.line_body)
                    .text_color(p.ink(1).solid())
                    .child(self.field.clone()),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_end()
                    .gap(px(8.0))
                    .child(
                        Button::new(
                            "comment-composer-cancel",
                            self.i18n.t(keys::common::CANCEL).to_owned(),
                        )
                        .text()
                        .on_click(move |_, _, cx| {
                            cancel.update(cx, |_, cx| cx.emit(ComposerEvent::Done))
                        }),
                    )
                    .child(
                        Button::new(
                            "comment-composer-save",
                            self.i18n.t(keys::common::SAVE).to_owned(),
                        )
                        .primary()
                        .on_click(move |_, _, cx| save.update(cx, |c, cx| c.save(cx))),
                    ),
            )
    }
}
