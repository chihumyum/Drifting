//! M18 in the workspace: opening the tab a Review card points at, and the
//! comment composer beside the selected text (dr-view-review).

use dr_editor::CommentRequested;
use dr_editor::decor::ReviewFocus;
use dr_view_review::{CommentComposer, ComposerEvent, NewComment};
use dr_workspace::dto::CommentPartDto;
use gpui::{
    AnyElement, App, AppContext as _, Context, ElementId, Entity, FocusHandle, Focusable, Global,
    InteractiveElement as _, IntoElement, ParentElement, Pixels, Point, StatefulInteractiveElement,
    Styled as _, Subscription, WeakEntity, Window, anchored, deferred, div, point, px,
};
use gpui_prose::ProseEditor;

use super::Workspace;
use super::editors::PageView;
use crate::nav::{Open, Target};

/// Which place a rectangle comment is being framed for when opening the asset
/// viewer via 「框一块写批注」 (`kernel-v5.md` §15 #7–#9).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FrameScope {
    Asset {
        asset: String,
    },
    Media {
        entry: String,
        module: String,
        asset: String,
    },
    Embed {
        entry: String,
        module: String,
        embed: String,
        asset: String,
    },
}

impl FrameScope {
    pub fn asset(&self) -> &str {
        match self {
            Self::Asset { asset } | Self::Media { asset, .. } | Self::Embed { asset, .. } => asset,
        }
    }
}

/// One-shot handoff from 「框一块写批注」 to the opened `MediaPage`.
#[derive(Clone, Debug, Default)]
pub struct FrameCommentIntent(pub Option<FrameScope>);

impl Global for FrameCommentIntent {}

pub fn take_frame_intent(asset: &str, cx: &mut App) -> Option<FrameScope> {
    let matches = cx
        .try_global::<FrameCommentIntent>()
        .and_then(|g| g.0.as_ref())
        .is_some_and(|s| s.asset() == asset);
    if !matches {
        return None;
    }
    cx.global_mut::<FrameCommentIntent>().0.take()
}

/// Screen bounds of mounted entry titles (`EntryPage` / `PageHead`), so
/// clicking 「写批注」 from the corner `⋯` menu or sidebar hover card opens
/// the composer directly below the entry's title (`v5-tracks.md:447`).
#[derive(Default)]
pub struct EntryTitleBounds(pub std::collections::HashMap<String, gpui::Bounds<gpui::Pixels>>);

impl Global for EntryTitleBounds {}

pub fn record_entry_title_bounds(entry: String, bounds: gpui::Bounds<gpui::Pixels>, cx: &mut App) {
    cx.default_global::<EntryTitleBounds>()
        .0
        .insert(entry, bounds);
}

/// Interactive sand underline beneath a non-prose spot that has open comments:
/// hovering highlights the matching Review cards; clicking reveals the first
/// comment in the Review panel; jumping from Review replays the sand wipe.
pub fn comment_underline(
    id: impl Into<ElementId>,
    comment_ids: Vec<String>,
    ws: WeakEntity<Workspace>,
    cx: &App,
) -> Option<AnyElement> {
    let first = comment_ids.first()?.clone();
    let el_id: ElementId = id.into();
    let rf = ReviewFocus::get(cx);
    let hot = rf.cards.iter().any(|c| comment_ids.contains(c))
        || rf.prose.iter().any(|c| comment_ids.contains(c));
    let replay = rf
        .jump
        .as_ref()
        .filter(|j| comment_ids.contains(&j.comment))
        .map(|j| j.serial)
        .unwrap_or(0);
    let hover_ids = comment_ids;
    Some(
        div()
            .id(el_id.clone())
            .w_full()
            .cursor_pointer()
            .on_hover(move |inside, _, cx| {
                if *inside {
                    ReviewFocus::point_prose(hover_ids.clone(), cx);
                } else {
                    ReviewFocus::point_prose(Vec::new(), cx);
                }
            })
            .on_click(move |_, window, cx| {
                cx.stop_propagation();
                if let Some(ws) = ws.upgrade() {
                    let first = first.clone();
                    ws.update(cx, |ws, cx| {
                        ws.reveal_comment(&first, None, window, cx);
                    });
                }
            })
            .child(
                dr_ui::sand::CommentUnderline::new(ElementId::Name(
                    format!("sand-ul-{el_id:?}").into(),
                ))
                .hot(hot)
                .replay(replay),
            )
            .into_any_element(),
    )
}

/// The composer shown, and its subscription.
pub struct Composer {
    view: Entity<CommentComposer>,
    at: gpui::Point<gpui::Pixels>,
    _done: Subscription,
}

impl Composer {
    /// M18's composer card.
    pub fn view(&self) -> &Entity<CommentComposer> {
        &self.view
    }
}

impl Workspace {
    /// The same navigation as ShowProjectHome, for an accepted book change.
    pub fn open_home(&mut self, cx: &mut Context<Self>) {
        self.exit_fill_in_cx(cx);
        self.nav.go_home();
        self.changed(cx);
    }

    /// Opens the right sidebar on the 素材库 tab.
    pub fn reveal_library(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.exit_fill(window, cx);
        let reduce = self.reduce_motion(window, cx);
        self.right.set_open(true, reduce);
        self.right.panes.reveal(super::RightTab::Library);
        self.changed(cx);
    }

    /// Reveal a comment which the caller has resolved in the current book.
    /// Floating/unlocated comments belong in Review; located comments also
    /// open their actual page and use M18's existing focus signal.
    pub fn reveal_comment(
        &mut self,
        id: &str,
        target: Option<Target>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<futures::channel::oneshot::Receiver<bool>> {
        if dr_model::id::CommentId::parse(id).is_err()
            || target
                .as_ref()
                .is_some_and(|target| self.book.entry(target).is_none())
        {
            return None;
        }
        self.exit_fill(window, cx);
        if let Some(target) = target {
            self.open(target, Open::KEEP, cx);
        }
        let reduce = self.reduce_motion(window, cx);
        self.right.set_open(true, reduce);
        self.right.panes.reveal(super::RightTab::Review);
        let pane = match self.right.panes.focused {
            crate::panes::PaneId::Primary => "review-primary",
            crate::panes::PaneId::Secondary => "review-secondary",
        };
        let revealed = dr_view_review::reveal_comment(pane, &self.book_id, id, cx)?;
        dr_editor::decor::ReviewFocus::jump(id, cx);
        self.changed(cx);
        Some(revealed)
    }

    /// Switches `pane` in the right sidebar from Review to Agent, focusing a
    /// comment's conversation with a `‹ 回审阅` back link.
    pub fn open_companion_for_comment(
        &mut self,
        pane: crate::panes::PaneId,
        req: dr_view_review::agent_bridge::CompanionFocusRequest,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.exit_fill(window, cx);
        let reduce = self.reduce_motion(window, cx);
        self.right.set_open(true, reduce);
        self.right.panes.focused = pane;
        self.right.panes.reveal(super::RightTab::Companion);
        dr_view_review::agent_bridge::request_open_conversation(req, cx);
        self.changed(cx);
    }

    /// Opens the right sidebar on Agent (HC: a suggestion card opened on
    /// Project Home; the Agent panel shows that card's conversation and
    /// Home stays as it is).
    pub fn reveal_companion(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let reduce = self.reduce_motion(window, cx);
        self.right.set_open(true, reduce);
        self.right.panes.reveal(super::RightTab::Companion);
        self.changed(cx);
    }

    /// ⌘⌥M: the composer comes up beside the selection of the editor that
    /// has focus (one chapter's or the whole book's).
    pub(super) fn on_new_comment(
        &mut self,
        _: &NewComment,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let focused = self.all_page_views().into_iter().find(|v| {
            v.prose(cx)
                .read(cx)
                .focus_handle(cx)
                .contains_focused(window, cx)
        });
        if let Some(view) = focused {
            self.open_composer(&view, window, cx);
        }
    }

    fn open_composer(&mut self, view: &PageView, window: &mut Window, cx: &mut Context<Self>) {
        let Some(lib) = self.library.clone() else {
            return;
        };
        let prose = view.prose(cx);
        // The document the selection is in.
        let doc = match view {
            PageView::Doc(e) => Some(e.read(cx).doc_id().to_owned()),
            PageView::Book(b) => b.read(cx).current_doc(cx).map(str::to_owned),
        };
        let Some(doc) = doc else {
            return;
        };
        let locale = crate::Strings::get(cx).locale();
        let book = self.book_id.clone();
        let Some(composer) =
            CommentComposer::for_prose(&prose, lib, &book, &doc, locale, window, cx)
        else {
            return;
        };
        self.show_composer(composer, prose, window, cx);
    }

    /// The selection bar's 添加批注 (F4's `CommentRequested`): the composer on
    /// that range of `req.doc`, under its last row. `chapter` is the
    /// document's chapter in `prose` (0 on one document's page).
    pub(super) fn on_comment_requested(
        &mut self,
        req: &CommentRequested,
        prose: Entity<ProseEditor>,
        chapter: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(lib) = self.library.clone() else {
            return;
        };
        if self.book.is_empty() {
            return;
        }
        let selection = prose.read(cx).selection();
        if selection.chapter != chapter || selection.range() != req.range {
            return;
        }
        let locale = crate::Strings::get(cx).locale();
        if let Some(composer) =
            CommentComposer::for_prose(&prose, lib, &self.book_id, &req.doc, locale, window, cx)
        {
            self.show_composer(composer, prose, window, cx);
        }
    }

    /// Opens a comment composer on the whole `entry` (`target = entry, module = None, part = None`).
    pub fn open_entry_composer(
        &mut self,
        entry: &str,
        at: Option<Point<Pixels>>,
        return_focus: Option<FocusHandle>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(lib) = self.library.clone() else {
            return;
        };
        if self.book.is_empty() {
            return;
        }
        let locale = crate::Strings::get(cx).locale();
        let book = self.book_id.clone();
        let at = at.or_else(|| {
            cx.try_global::<EntryTitleBounds>()
                .and_then(|g| g.0.get(entry))
                .map(|b| point(b.left(), b.bottom() + px(8.0)))
        });
        let entry = entry.to_owned();
        let pos = composer_at(at, window);
        let composer =
            cx.new(|cx| CommentComposer::for_entry(lib, book, entry, pos, locale, window, cx));
        self.show_composer_with_focus(composer, return_focus, window, cx);
    }

    /// Opens a comment composer on an entire `module` of `entry`.
    pub fn open_module_composer(
        &mut self,
        entry: &str,
        module: &str,
        at: Option<Point<Pixels>>,
        return_focus: Option<FocusHandle>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(lib) = self.library.clone() else {
            return;
        };
        if self.book.is_empty() {
            return;
        }
        let locale = crate::Strings::get(cx).locale();
        let book = self.book_id.clone();
        let entry = entry.to_owned();
        let module = module.to_owned();
        let pos = composer_at(at, window);
        let composer = cx.new(|cx| {
            CommentComposer::for_module(lib, book, entry, module, pos, locale, window, cx)
        });
        self.show_composer_with_focus(composer, return_focus, window, cx);
    }

    /// Opens a comment composer on a sub-`part` inside `module` of `entry`.
    #[allow(clippy::too_many_arguments)]
    pub fn open_part_composer(
        &mut self,
        entry: &str,
        module: &str,
        part: CommentPartDto,
        at: Option<Point<Pixels>>,
        return_focus: Option<FocusHandle>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(lib) = self.library.clone() else {
            return;
        };
        if self.book.is_empty() {
            return;
        }
        let locale = crate::Strings::get(cx).locale();
        let book = self.book_id.clone();
        let entry = entry.to_owned();
        let module = module.to_owned();
        let pos = composer_at(at, window);
        let composer = cx.new(|cx| {
            CommentComposer::for_part(lib, book, entry, module, part, pos, locale, window, cx)
        });
        self.show_composer_with_focus(composer, return_focus, window, cx);
    }

    /// Opens a comment composer directly on a standalone `asset` in the asset library.
    pub fn open_asset_composer(
        &mut self,
        asset: &str,
        at: Option<Point<Pixels>>,
        return_focus: Option<FocusHandle>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(lib) = self.library.clone() else {
            return;
        };
        if self.book.is_empty() {
            return;
        }
        let locale = crate::Strings::get(cx).locale();
        let book = self.book_id.clone();
        let asset = asset.to_owned();
        let pos = composer_at(at, window);
        let composer = cx
            .new(|cx| CommentComposer::for_asset(lib, book, asset, None, pos, locale, window, cx));
        self.show_composer_with_focus(composer, return_focus, window, cx);
    }

    /// Opens the asset viewer for `scope` directly in rectangle-framing mode
    /// (「框一块写批注」).
    pub fn open_frame_viewer(&mut self, scope: FrameScope, cx: &mut Context<Self>) {
        let material_id = match &scope {
            FrameScope::Media {
                entry,
                module,
                asset,
            } => self
                .book
                .material_items()
                .iter()
                .find(|m| {
                    m.entry.as_deref() == Some(entry.as_str())
                        && m.module.as_deref() == Some(module.as_str())
                        && m.asset.as_deref() == Some(asset.as_str())
                })
                .map(|m| m.id.clone())
                .unwrap_or_else(|| asset.clone()),
            FrameScope::Asset { asset } | FrameScope::Embed { asset, .. } => asset.clone(),
        };
        let Some(target) = Target::from_key(&format!("material:{material_id}")) else {
            return;
        };
        if !self.book.exists(&target) {
            return;
        }
        cx.set_global(FrameCommentIntent(Some(scope)));
        self.open(target, Open::KEEP, cx);
    }

    /// Shows `view` beside the selection; done, the page gets the keyboard.
    fn show_composer(
        &mut self,
        view: Entity<CommentComposer>,
        prose: Entity<ProseEditor>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let focus = prose.read(cx).focus_handle(cx);
        self.show_composer_with_focus(view, Some(focus), window, cx);
    }

    fn show_composer_with_focus(
        &mut self,
        view: Entity<CommentComposer>,
        return_focus: Option<FocusHandle>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let done = cx.subscribe_in(
            &view,
            window,
            move |ws, _, e: &ComposerEvent, window, cx| {
                if *e == ComposerEvent::Done {
                    ws.composer = None;
                    if let Some(focus) = &return_focus {
                        window.focus(focus, cx);
                    }
                    cx.notify();
                }
            },
        );
        let at = view.read(cx).position();
        self.composer = Some(Composer {
            view,
            at,
            _done: done,
        });
        cx.notify();
    }

    /// The composer over everything, where the selection ends.
    pub(super) fn composer_overlay(&self) -> Option<AnyElement> {
        let c = self.composer.as_ref()?;
        Some(
            deferred(
                anchored()
                    .position(c.at)
                    .snap_to_window_with_margin(px(12.0))
                    .child(c.view.clone()),
            )
            .into_any_element(),
        )
    }
}

fn composer_at(at: Option<Point<Pixels>>, window: &Window) -> Point<Pixels> {
    if let Some(at) = at {
        return at;
    }
    let m = window.mouse_position();
    if m.x > px(1.0) || m.y > px(1.0) {
        point(m.x, m.y + px(8.0))
    } else {
        point(px(160.0), px(120.0))
    }
}

/// Registers 「写批注」 at the top of the bottom-right `⋯` menu (via
/// [`crate::pages::add_page_menu`]) and at the top (`lead`) of v3 entry hover
/// cards in the left sidebar.
pub fn register_entry_comment_card(cx: &mut App) {
    use crate::pages::{CardRows, PageMenuItem, PageMenuSection};
    use dr_i18n::keys;
    use dr_ui::sand::Icon;
    use std::rc::Rc;

    crate::pages::add_page_menu(cx, |target, host, cx| {
        let Target::Entry { id, .. } = target else {
            return Vec::new();
        };
        if host.book.v3().and_then(|v| v.entry(id.as_str())).is_none() {
            return Vec::new();
        }
        let (weak, book, entry_id) = (host.workspace.clone(), host.book_id.clone(), id.clone());
        vec![PageMenuSection {
            title: None,
            items: vec![PageMenuItem {
                id: "page-write-comment".into(),
                label: crate::strings::t(cx, keys::v3_review::WRITE_COMMENT),
                icon: Icon::CommentPlus.into(),
                checked: false,
                danger: false,
                run: Rc::new(move |window, cx| {
                    if let Some(ws) = weak.upgrade() {
                        let entry_id = entry_id.clone();
                        ws.update(cx, |ws, cx| {
                            if ws.book_id != book
                                || ws
                                    .book
                                    .v3()
                                    .and_then(|v| v.entry(entry_id.as_str()))
                                    .is_none()
                            {
                                return;
                            }
                            ws.open_entry_composer(entry_id.as_str(), None, None, window, cx);
                        });
                    }
                }),
            }],
        }]
    });

    crate::v3::add_entry_card_rows(cx, |target, host, cx| {
        let Target::Entry { id, .. } = target else {
            return CardRows::default();
        };
        if host.book.v3().and_then(|v| v.entry(id.as_str())).is_none() {
            return CardRows::default();
        }
        let (weak, book, entry_id) = (host.workspace.clone(), host.book_id.clone(), id.clone());
        CardRows {
            lead: vec![PageMenuSection {
                title: None,
                items: vec![PageMenuItem {
                    id: "entry-write-comment".into(),
                    label: crate::strings::t(cx, keys::v3_review::WRITE_COMMENT),
                    icon: Icon::CommentPlus.into(),
                    checked: false,
                    danger: false,
                    run: Rc::new(move |window, cx| {
                        if let Some(ws) = weak.upgrade() {
                            let entry_id = entry_id.clone();
                            ws.update(cx, |ws, cx| {
                                if ws.book_id != book
                                    || ws
                                        .book
                                        .v3()
                                        .and_then(|v| v.entry(entry_id.as_str()))
                                        .is_none()
                                {
                                    return;
                                }
                                let same_entry = matches!(
                                    ws.nav.current(),
                                    Some(Target::Entry { id: cur, .. }) if cur == &entry_id
                                );
                                if !same_entry {
                                    ws.open(
                                        Target::Entry {
                                            id: entry_id.clone(),
                                            module: None,
                                        },
                                        Open::KEEP,
                                        cx,
                                    );
                                }
                                ws.open_entry_composer(entry_id.as_str(), None, None, window, cx);
                            });
                        }
                    }),
                }],
            }],
            before_danger: Vec::new(),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_workspace::Actor;
    use gpui::{Bounds, TestAppContext, size};
    use serde_json::json;

    #[gpui::test]
    fn entry_module_part_and_asset_spots_index_and_light_review_focus(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let dir = tempfile::tempdir().unwrap();
        let lib = dr_workspace::Workspace::open_dir(dir.path(), "v3-spots").unwrap();
        let seed = dr_testkit::seed::generate_v3(
            dr_testkit::seed::Preset::Tiny,
            dr_testkit::seed::DEFAULT_SEED,
        )
        .unwrap();
        let book_id = seed.books[0].book_id().to_string();
        seed.write_to(lib.library()).unwrap();

        lib.call(
            &Actor::User,
            "entry_template.put",
            json!({
                "book": book_id,
                "template": {
                    "id": "tpl-spot-all",
                    "name": "人物全模块",
                    "modules": [
                        {
                            "id": "mod-fields",
                            "kind": "fields",
                            "name": "设定",
                            "config": {
                                "defs": [{"id": "f-age", "name": "年龄", "field_type": "text"}]
                            }
                        },
                        {"id": "mod-kv", "kind": "kv", "name": "物件"},
                        {"id": "mod-patch", "kind": "patches", "name": "补丁"},
                        {"id": "mod-plot", "kind": "plot_grid", "name": "情节"}
                    ]
                }
            }),
        )
        .unwrap();
        let entry_id = lib
            .call(
                &Actor::User,
                "entry.create",
                json!({"book": book_id, "template": "tpl-spot-all", "title": "林晚"}),
            )
            .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        lib.call(
            &Actor::User,
            "module.set_field",
            json!({
                "book": book_id,
                "entry": entry_id,
                "module": "mod-fields",
                "field": "f-age",
                "value": "二十七"
            }),
        )
        .unwrap();
        lib.call(
            &Actor::User,
            "module.put_kv",
            json!({
                "book": book_id,
                "entry": entry_id,
                "module": "mod-kv",
                "row": {"id": "row-watch", "key": "怀表", "value": "四点十七分"}
            }),
        )
        .unwrap();
        let patch_id = lib
            .call(
                &Actor::User,
                "module.put_patch",
                json!({
                    "book": book_id,
                    "entry": entry_id,
                    "module": "mod-patch",
                    "title": "数楼梯",
                    "body": "数到四十级就停"
                }),
            )
            .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let pos0 = dr_model::pos::PosKey::first().to_string();
        lib.call(
            &Actor::User,
            "module.put_grid",
            json!({
                "book": book_id,
                "entry": entry_id,
                "module": "mod-plot",
                "grid": {
                    "cell_w": 180.0,
                    "cell_h": 120.0,
                    "rows": [{"id": "r1", "pos": pos0, "label": "老周"}],
                    "columns": [{"id": "c1", "pos": pos0, "label": "子夜"}],
                    "cells": [{"row": "r1", "column": "c1", "text": "擦镜片"}]
                }
            }),
        )
        .unwrap();
        lib.call(
            &Actor::User,
            "asset.put",
            json!({
                "book": book_id,
                "id": "asset-tower",
                "name": "灯塔旧照.png",
                "kind": "image",
                "mime": "image/png",
                "size": 64,
                "sha256": "c".repeat(64),
                "width": 120,
                "height": 90
            }),
        )
        .unwrap();

        let create = |input: serde_json::Value| -> String {
            lib.call(&Actor::User, "comment.create", input).unwrap()["output"]["id"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let c_entry = create(json!({
            "book": book_id,
            "target": {"kind": "entry", "id": entry_id},
            "body": "整条设定"
        }));
        let c_mod = create(json!({
            "book": book_id,
            "target": {"kind": "entry", "id": entry_id},
            "module": "mod-kv",
            "body": "物件太多"
        }));
        let c_field = create(json!({
            "book": book_id,
            "target": {"kind": "entry", "id": entry_id},
            "module": "mod-fields",
            "part": {"kind": "field", "field": "f-age"},
            "body": "年龄统一"
        }));
        let c_kv = create(json!({
            "book": book_id,
            "target": {"kind": "entry", "id": entry_id},
            "module": "mod-kv",
            "part": {"kind": "kv_row", "row": "row-watch"},
            "body": "对一下时间"
        }));
        let c_patch = create(json!({
            "book": book_id,
            "target": {"kind": "entry", "id": entry_id},
            "module": "mod-patch",
            "part": {"kind": "patch", "patch": patch_id},
            "body": "交代转变"
        }));
        let c_plot = create(json!({
            "book": book_id,
            "target": {"kind": "entry", "id": entry_id},
            "module": "mod-plot",
            "part": {"kind": "plot_cell", "row": "r1", "col": "c1"},
            "body": "已下山"
        }));
        let c_asset = create(json!({
            "book": book_id,
            "target": {"kind": "asset", "id": "asset-tower"},
            "body": "换冬天的"
        }));

        let loaded = crate::book::Book::load(&lib, &book_id).unwrap();
        let v3 = loaded.v3().unwrap();
        assert_eq!(v3.entry_title_comments(&entry_id), vec![c_entry.clone()]);
        assert_eq!(
            v3.module_header_comments(&entry_id, "mod-kv"),
            vec![c_mod.clone()]
        );
        assert_eq!(
            v3.field_comments(&entry_id, "mod-fields", "f-age"),
            vec![c_field.clone()]
        );
        assert_eq!(
            v3.kv_row_comments(&entry_id, "mod-kv", "row-watch"),
            vec![c_kv.clone()]
        );
        assert_eq!(
            v3.patch_comments(&entry_id, "mod-patch", &patch_id),
            vec![c_patch.clone()]
        );
        assert_eq!(
            v3.plot_cell_comments(&entry_id, "mod-plot", "r1", "c1"),
            vec![c_plot.clone()]
        );
        assert_eq!(v3.asset_comments("asset-tower"), vec![c_asset.clone()]);

        cx.update(|cx| {
            crate::init(
                crate::ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "0.2.0-dev",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: None,
                },
                crate::Services {
                    library: Some(lib.clone()),
                    book: Some(book_id.clone()),
                    ..Default::default()
                },
                crate::SettingsFile::in_memory(),
                cx,
            );
            register_entry_comment_card(cx);
        });
        let (shell, cx) = cx.add_window_view(Workspace::new);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !shell.read_with(cx, |ws, _| ws.book.v3().is_some()) {
            cx.run_until_parked();
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(2));
        }

        // Corner ⋯ and sidebar card both expose 「写批注」 first, and opening
        // the entry composer anchors it directly below recorded title bounds.
        cx.update(|window, cx| {
            record_entry_title_bounds(
                entry_id.clone(),
                Bounds {
                    origin: point(px(120.0), px(80.0)),
                    size: size(px(240.0), px(34.0)),
                },
                cx,
            );
            let target = Target::from_key(&format!("entry:{entry_id}")).unwrap();
            let host = crate::pages::PageMenuHost::of(&shell, cx);
            let corner_sections =
                super::super::page_actions::page_actions(&shell, &host, &target, cx);
            assert_eq!(
                corner_sections[0].items[0].id.as_ref(),
                "page-write-comment"
            );
            let card_rows = crate::v3::card::rows(&target, &host, &Default::default(), cx);
            assert_eq!(card_rows[0].id.as_ref(), "entry-write-comment");
            (card_rows[0].run.as_ref().unwrap())(window, cx);
        });
        let pos = shell.read_with(cx, |ws, _| ws.composer.as_ref().expect("composer open").at);
        assert_eq!(pos, point(px(120.0), px(122.0)));
        lib.close();
    }
}
