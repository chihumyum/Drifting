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
use dr_workspace::commands::comment::CommentCreateIn;
use dr_workspace::dto::{AnchorBytes, Region, Target};
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
    module: Option<String>,
    anchor: Anchor,
    /// Captured while opening a v3 composer, before another writer can move
    /// the selected characters. A capture failure never falls back to offsets.
    source_anchor: Option<Result<AnchorBytes, String>>,
    todo: bool,
    field: Entity<TextArea>,
    at: Point<Pixels>,
    i18n: I18n,
    saving: bool,
    error: Option<String>,
    _field: Subscription,
}

impl EventEmitter<ComposerEvent> for CommentComposer {}

/// How wide the composer is.
pub const WIDTH: f32 = 300.0;

fn capture_anchor(
    ws: &Workspace,
    doc: &str,
    start: usize,
    end: usize,
) -> Result<AnchorBytes, String> {
    let id = dr_model::DocId::parse(doc).map_err(|e| e.to_string())?;
    let handle = ws
        .library()
        .open_doc(doc, dr_store::OpenDoc::Existing)
        .map_err(|e| e.to_string())?;
    handle
        .read(move |doc| {
            let prose = dr_doc::prose::BorrowedProse::new(doc, &id).map_err(|e| e.to_string())?;
            prose
                .view()
                .anchor(start..end)
                .map(|a| AnchorBytes::from(&a.encode()))
                .ok_or_else(|| "selection cannot be anchored".to_owned())
        })
        .map_err(|e| e.to_string())?
}

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
        let (range, start16, end16, source_anchor) = {
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
                doc.source()
                    .anchor(r)
                    .map(|a| AnchorBytes::from(&dr_editor::anchors::encode(&a))),
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
        Some(cx.new(|cx| {
            let mut composer =
                CommentComposer::new(ws, book, target, range, below, locale, window, cx);
            if composer.source_anchor.is_some() {
                composer.source_anchor =
                    Some(source_anchor.ok_or_else(|| "selection cannot be anchored".into()));
            }
            composer
        }))
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
            FieldEvent::Cancelled if !this.saving => cx.emit(ComposerEvent::Done),
            _ => {}
        });
        let handle = field.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
        let source_doc = format!("{}:{}", target.kind, target.id);
        let v3_prose = target.kind == "body"
            || (target.kind == "material"
                && ws
                    .library()
                    .open_doc(&format!("book:{book}"), dr_store::OpenDoc::Existing)
                    .and_then(|h| h.read(dr_doc::v3::is_book_doc))
                    .unwrap_or(false));
        let source_anchor = match anchor {
            Anchor::Range(start, end) if v3_prose => {
                Some(capture_anchor(&ws, &source_doc, start, end))
            }
            _ => None,
        };
        let (target, module) =
            match dr_model::DocId::parse(&format!("{}:{}", target.kind, target.id)) {
                Ok(dr_model::DocId::Body(body)) => (
                    Target {
                        kind: "entry".into(),
                        id: body.entry().to_string(),
                    },
                    Some(body.module().to_string()),
                ),
                _ => (target, None),
            };
        CommentComposer {
            ws,
            book,
            target,
            module,
            anchor,
            source_anchor,
            todo: false,
            field,
            at,
            i18n,
            saving: false,
            error: None,
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
        if self.saving {
            return;
        }
        if let Some(Err(error)) = &self.source_anchor {
            self.error = Some(error.clone());
            cx.notify();
            return;
        }
        self.saving = true;
        self.error = None;
        self.field
            .update(cx, |field, cx| field.set_disabled(true, cx));
        let body = self.field.read(cx).text();
        let (range, region) = match self.anchor {
            Anchor::Range(start, end) => (Some((start, end)), None),
            Anchor::Region(r) => (None, Some(r)),
        };
        let input = CommentCreateIn {
            book: self.book.clone(),
            kind: Some(if self.todo { "todo" } else { "note" }.into()),
            target: Some(dr_workspace::commands::v3::comment::Target {
                kind: self.target.kind.clone(),
                id: self.target.id.clone(),
            }),
            module: self.module.clone(),
            anchor: None,
            block_id: None,
            range,
            region,
            body,
            priority: None,
            author_name: None,
        };
        // Named calls select the book version. A v3 body always carries the
        // exact module; materials retain their common target shape.
        let mut input = serde_json::to_value(input).expect("serializable comment input");
        if let Some(module) = &self.module {
            input["module"] = module.clone().into();
        }
        if let Some(Ok(anchor)) = &self.source_anchor {
            input
                .as_object_mut()
                .expect("comment object")
                .remove("range");
            input["anchor"] = serde_json::to_value(anchor).expect("serializable anchor");
        }
        let ws = self.ws.clone();
        let task = cx
            .background_executor()
            .spawn(async move { ws.call(&Actor::User, "comment.create", input) });
        cx.spawn(async move |this, cx| {
            let made = task.await;
            this.update(cx, |this, cx| {
                this.saving = false;
                this.field
                    .update(cx, |field, cx| field.set_disabled(false, cx));
                match made {
                    Ok(done) => {
                        let id = done["output"]["id"]
                            .as_str()
                            .expect("created comment id")
                            .to_owned();
                        // Written: chosen, so its sand is drawn along its rows.
                        ReviewFocus::jump(&id, cx);
                        cx.emit(ComposerEvent::Saved(id));
                        cx.emit(ComposerEvent::Done);
                    }
                    Err(e) => {
                        log::warn!("review: comment.create: {e}");
                        this.error = Some(e.to_string());
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
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
                .disabled(self.saving)
                .on_change(move |ix, _, cx| pick.update(cx, |c, cx| c.set_todo(ix == 1, cx))),
            )
            .children(self.error.as_ref().map(|_| {
                div()
                    .text_color(p.danger.solid())
                    .child(self.i18n.t(keys::common::SAVE_FAILED).to_owned())
            }))
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
                        .disabled(self.saving)
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
                        .busy(self.saving)
                        .disabled(self.saving)
                        .on_click(move |_, _, cx| save.update(cx, |c, cx| c.save(cx))),
                    ),
            )
    }
}

#[cfg(test)]
mod v3_tests {
    use super::*;
    use dr_doc::prose::ProseDoc;
    use dr_model::{
        DocId, Origin,
        id::{BodyDocId, ModuleId},
        v3::ModuleSpec,
    };
    use gpui::{TestAppContext, VisualTestContext};
    use serde_json::json;
    use std::time::{Duration, Instant};

    struct Frame(Entity<CommentComposer>);
    impl Render for Frame {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().child(self.0.clone())
        }
    }
    fn wait(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.run_until_parked();
            cx.update(|window, cx| window.draw(cx).clear(cx));
            if done(cx) {
                return;
            }
            assert!(Instant::now() < deadline, "v3 composer timed out");
            std::thread::sleep(Duration::from_millis(3));
        }
    }

    #[gpui::test]
    fn composer_keeps_the_exact_module_and_retains_a_refused_draft(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "v3-composer").unwrap();
        let mut seed = dr_testkit::seed::generate_v3(
            dr_testkit::seed::Preset::Tiny,
            dr_testkit::seed::DEFAULT_SEED,
        )
        .unwrap();
        let b = &mut seed.books[0];
        let book = b.book_id().to_string();
        let source = b
            .book
            .view()
            .comments()
            .into_iter()
            .find(|c| c.target_module.is_some())
            .unwrap();
        let entry = source.target.as_ref().unwrap().id.clone();
        let original = b
            .prose
            .iter()
            .find(|p| p.doc_id() == &crate::v3::prose_doc(&source).unwrap())
            .unwrap();
        let text = original
            .view()
            .text_in(0..original.view().len() - 1)
            .unwrap();
        let template = b
            .book
            .view()
            .entry(&entry.parse().unwrap())
            .unwrap()
            .template
            .unwrap();
        let module = ModuleId::parse("composer-second-body").unwrap();
        let doc = DocId::Body(BodyDocId::new(entry.parse().unwrap(), module.clone()));
        let mut prose = ProseDoc::create(doc, 8437).unwrap();
        prose
            .edit(Origin::User, |t| t.insert_paragraphs(0, &text))
            .0
            .unwrap();
        b.book
            .edit(Origin::User, |t| {
                t.template(&template)?.put_module(&ModuleSpec::prose(
                    module.clone(),
                    "Second body",
                    true,
                    false,
                ))?;
                Ok(())
            })
            .0
            .unwrap();
        b.prose.push(prose);
        seed.write_to(ws.library()).unwrap();
        let body = format!("{}\n{}", source.body, source.body);
        let (frame, cx) = cx.add_window_view(|window, cx| {
            Frame(cx.new(|cx| {
                CommentComposer::new(
                    ws.clone(),
                    book.clone(),
                    Target {
                        kind: "body".into(),
                        id: format!("{entry}/{module}"),
                    },
                    (0, 4),
                    point(px(0.0), px(0.0)),
                    Locale::En,
                    window,
                    cx,
                )
            }))
        });
        let composer = frame.read_with(cx, |f, _| f.0.clone());
        let session = ws.prose_session(&format!("body:{entry}/{module}")).unwrap();
        let quote = session.reader().view().text_in(0..4).unwrap();
        let prefix = format!("{quote} ");
        session.edit(move |t| t.insert_text(0, &prefix)).unwrap();
        composer.update(cx, |c, cx| {
            c.set_text(&body, cx);
            c.save(cx);
            c.save(cx);
        });
        wait(cx, |cx| composer.read_with(cx, |c, _| !c.saving));
        assert!(composer.read_with(cx, |c, _| c.error.is_none()));
        let comments = ws
            .call(
                &Actor::User,
                "comment.list",
                json!({"book":book,"target":{"kind":"entry","id":entry},"module":module}),
            )
            .unwrap()["output"]
            .clone();
        assert_eq!(
            comments.as_array().unwrap().len(),
            1,
            "a second submit while saving cannot duplicate the comment"
        );
        assert_eq!(comments[0]["module"], module.as_str());
        assert_eq!(comments[0]["body"], body);
        assert_eq!(comments[0]["target"]["id"], entry);
        assert_eq!(
            comments[0]["quote"], quote,
            "a peer's prefix cannot change the selected quote"
        );
        let end = session.reader().view().len() - 1;
        session.edit(move |t| t.delete(0..end)).unwrap();
        composer.update(cx, |c, cx| c.save(cx));
        wait(cx, |cx| composer.read_with(cx, |c, _| c.error.is_some()));
        assert_eq!(
            composer.read_with(cx, |c, cx| c.field.read(cx).text()),
            body
        );
        ws.close();
    }
}
