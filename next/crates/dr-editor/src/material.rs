//! File embeds in prose (`kernel-v5.md` §6, `v5-tracks.md` §T5):
//!
//! - **Image**: sized (`Small` 36%, `Medium` 64%, `Full` 100%) and aligned
//!   (`Left`, `Center`, `Right`), with an inline `图注` caption below the
//!   figure (empty captions occupy zero height unless the embed is selected or
//!   being edited) and a 248px hover card (`大小`, `对齐`, `打开`,
//!   `在素材库里找到`, `写批注`, `框一块写批注`, `从正文拿走`). Single-click
//!   selects; double-click opens the viewer.
//! - **PDF**: a compact `.pdfc` card (`44×60` first-page thumbnail, filename,
//!   `PDF · N 页`) that opens the viewer on single click and carries a 248px
//!   hover card (`打开`, `在素材库里找到`, `写批注`, `框一块写批注`, `从正文拿走`).
//! - An open comment on the embed puts one sand dot on its corner.
//! - **Missing / Recently Deleted**: a `.gone` dashed box with the struck-through
//!   filename (when still in `assets_raw`), folder-trash-aware `恢复`, and
//!   `从正文拿走`.

use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;

use dr_doc::prose::FileEmbedLook;
use dr_model::id::{AssetId, EmbedId};
use dr_model::v3::{CommentPart, EmbedAlign, EmbedSize};
use dr_store::asset::Variant;
use dr_ui::components::hover_card::{CardAction, CardBody};
use dr_ui::components::menu::RowIcon;
use dr_ui::components::{Button, HoverCard};
use dr_ui::fonts::{Role, weight};
use dr_ui::input::{FieldEvent, TextField};
use dr_ui::sand::{self, Icon, SandFrame};
use dr_ui::style::DrStyled as _;
use dr_ui::theme::Theme;
use dr_ui::tokens::radius;
use dr_workspace::Actor;
use dr_workspace::commands::EntityIn;
use dr_workspace::commands::asset::{AssetFolderRestore, AssetRestore};
use gpui::prelude::FluentBuilder as _;
use gpui::{
    AnyElement, App, AppContext as _, Bounds, Context, ElementId, Entity, Focusable as _,
    InteractiveElement, IntoElement, ObjectFit, ParentElement, Pixels, Render,
    StatefulInteractiveElement as _, Styled, StyledImage as _, Subscription, Window, canvas, div,
    img, px, relative,
};

use crate::embeds::{BookAssetCache, BookAssetRecord, NoteHost, lookup_asset_record};

/// What a live embedded file shows.
#[derive(Clone, Debug, PartialEq)]
pub struct MaterialFacts {
    pub title: String,
    /// `image` or `pdf`.
    pub kind: String,
    /// The image to show: an image's `display` variant (else `source`),
    /// a PDF's `thumbnail`.
    pub picture: Option<PathBuf>,
    /// Thumbnail path for the 248px hover card preview.
    pub thumb: Option<PathBuf>,
    /// Whether this embedded file has at least one open comment on it (a
    /// sand dot on the thumbnail's corner, `kernel-v5.md` §7).
    pub has_open_comment: bool,
}

#[derive(Clone, Debug, PartialEq)]
enum LookupState {
    Live(MaterialFacts),
    Missing {
        title: Option<String>,
        is_pdf: bool,
        restorable: bool,
        self_trashed: bool,
        trashed_folders: Vec<String>,
    },
}

struct CaptionDraft {
    field: Entity<TextField>,
    _sub: Subscription,
}

/// Asset `id`'s name, if it is a live file of the book (used when copying prose).
pub(crate) fn title_of(host: &NoteHost, cache: &BookAssetCache, id: &str) -> Option<String> {
    lookup_asset_record(host, cache, id)
        .filter(|r| r.live)
        .map(|r| r.name)
}

/// One embedded asset paragraph in prose.
pub struct MaterialBlock {
    host: Rc<NoteHost>,
    book_assets: BookAssetCache,
    embed: String,
    material: Option<AssetId>,
    state: Option<LookupState>,
    look: FileEmbedLook,
    caption_edit: Option<CaptionDraft>,
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    pub(crate) selected: bool,
}

impl MaterialBlock {
    pub(crate) fn new(
        host: Rc<NoteHost>,
        book_assets: BookAssetCache,
        embed: &str,
        material: Option<AssetId>,
    ) -> Self {
        let look = host.read_file_embed_look(embed);
        MaterialBlock {
            host,
            book_assets,
            embed: embed.to_owned(),
            material,
            state: None,
            look,
            caption_edit: None,
            bounds: Rc::new(Cell::new(None)),
            selected: false,
        }
    }

    pub(crate) fn last_bounds(&self) -> Option<Bounds<Pixels>> {
        self.bounds.get()
    }

    /// Re-reads the book's asset state (trashed/restored/renamed).
    pub(crate) fn reload(&mut self, cx: &mut Context<Self>) {
        self.state = None;
        cx.notify();
    }

    /// Re-reads `size` / `align` / `caption` from the prose document (e.g. after ⌘Z).
    pub(crate) fn refresh_look(&mut self, cx: &mut Context<Self>) {
        let next = self.host.read_file_embed_look(&self.embed);
        if next != self.look {
            self.look = next;
            cx.notify();
        }
    }

    pub fn look(&self) -> &FileEmbedLook {
        &self.look
    }

    /// The live file's facts; `None` when it is in Recently Deleted or purged.
    pub fn facts(&mut self) -> Option<&MaterialFacts> {
        self.ensure_state();
        match &self.state {
            Some(LookupState::Live(f)) => Some(f),
            _ => None,
        }
    }

    pub fn is_missing(&mut self) -> bool {
        self.ensure_state();
        matches!(self.state, Some(LookupState::Missing { .. }))
    }

    pub fn missing_title(&mut self) -> Option<String> {
        self.ensure_state();
        match &self.state {
            Some(LookupState::Missing { title, .. }) => title.clone(),
            _ => None,
        }
    }

    fn ensure_state(&mut self) {
        if self.state.is_none() {
            self.state = Some(self.look_up());
        }
    }

    fn look_up(&self) -> LookupState {
        let Some(id) = self.material.as_ref() else {
            return LookupState::Missing {
                title: None,
                is_pdf: false,
                restorable: false,
                self_trashed: false,
                trashed_folders: Vec::new(),
            };
        };
        let Some(rec): Option<BookAssetRecord> =
            lookup_asset_record(&self.host, &self.book_assets, id.as_str())
        else {
            return LookupState::Missing {
                title: None,
                is_pdf: false,
                restorable: false,
                self_trashed: false,
                trashed_folders: Vec::new(),
            };
        };
        if !rec.live {
            return LookupState::Missing {
                title: Some(rec.name),
                is_pdf: rec.kind == "pdf",
                restorable: rec.self_trashed || !rec.trashed_folders.is_empty(),
                self_trashed: rec.self_trashed,
                trashed_folders: rec.trashed_folders,
            };
        }
        let store = self.host.ws.library();
        let path_of = |variant: Variant| {
            let r = store.asset(id.as_str(), variant).ok()??;
            r.path.exists().then_some(r.path)
        };
        let thumb = path_of(Variant::Thumbnail)
            .or_else(|| path_of(Variant::Display))
            .or_else(|| path_of(Variant::Source));
        let picture = if rec.kind == "pdf" {
            path_of(Variant::Thumbnail)
        } else {
            path_of(Variant::Display).or_else(|| path_of(Variant::Source))
        };
        // Looked up with the rest of the facts, so again only when the book
        // changes (`EmbedHost::book_changed`), not on every frame.
        let embed_id = self.embed.clone();
        let has_open_comment = crate::v3::read(&self.host.ws, &self.host.book, move |v| {
            v.comments().into_iter().any(|c| {
                !c.is_done()
                    && matches!(
                        &c.part,
                        Some(CommentPart::Embed { embed, .. }) if embed.as_str() == embed_id
                    )
            })
        })
        .unwrap_or(false);
        LookupState::Live(MaterialFacts {
            title: rec.name,
            kind: rec.kind,
            picture,
            thumb,
            has_open_comment,
        })
    }

    /// Opens the file in the viewer tab.
    pub fn open(&self, cx: &mut App) {
        if let Some(id) = &self.material {
            self.host.open_material(id.as_str(), cx);
        }
    }

    /// Opens the comment composer on this embedded file (`kernel-v5.md` §7).
    pub fn comment(&self, at: gpui::Point<Pixels>, cx: &mut App) {
        if let Some(id) = &self.material {
            self.host.comment_embed(&self.embed, id.as_str(), at, cx);
        }
    }

    /// Opens the viewer in region-drawing mode for this embedded file.
    pub fn frame(&self, cx: &mut App) {
        if let Some(id) = &self.material {
            self.host.frame_embed(&self.embed, id.as_str(), cx);
        }
    }

    /// Reveals and flashes the file in the asset library sidebar.
    pub fn locate_in_library(&self, window: &mut Window, cx: &mut App) {
        if let Some(id) = &self.material {
            crate::file_host::locate_in_library(id.as_str(), window, cx);
        }
    }

    pub fn set_size(&mut self, size: EmbedSize, cx: &mut Context<Self>) {
        let mut next = self.look.clone();
        next.size = Some(size);
        self.apply_look(next, cx);
    }

    pub fn set_align(&mut self, align: EmbedAlign, cx: &mut Context<Self>) {
        let mut next = self.look.clone();
        next.align = Some(align);
        self.apply_look(next, cx);
    }

    pub fn set_caption(&mut self, caption: impl Into<String>, cx: &mut Context<Self>) {
        let mut next = self.look.clone();
        next.caption = caption.into().trim().to_owned();
        self.apply_look(next, cx);
    }

    fn apply_look(&mut self, next: FileEmbedLook, cx: &mut Context<Self>) {
        if next == self.look {
            return;
        }
        let Ok(id) = EmbedId::parse(&self.embed) else {
            return;
        };
        if let Err(e) = self.host.session.set_file_embed_look(&id, &next) {
            log::error!("dr-editor: setting file embed look failed: {e}");
            return;
        }
        self.look = next;
        if let Some(body) = self.host.body.upgrade() {
            let chapter = self.host.chapter;
            body.update(cx, |e, cx| {
                e.refresh_chapter(chapter, cx);
                e.record_host_items(chapter, 1, true);
            });
        }
        self.host.edited(cx);
        cx.notify();
    }

    /// Restores trashed ancestor folders and the file itself from Recently Deleted.
    pub fn restore_missing(&mut self, cx: &mut Context<Self>) {
        self.ensure_state();
        let Some(LookupState::Missing {
            restorable: true,
            self_trashed,
            trashed_folders,
            ..
        }) = self.state.clone()
        else {
            return;
        };
        let Some(asset_id) = self.material.as_ref().map(|a| a.to_string()) else {
            return;
        };
        let ws = self.host.ws.clone();
        let book = self.host.book.clone();
        let job = cx.background_spawn(async move {
            for fid in trashed_folders {
                let _ = ws.run::<AssetFolderRestore>(
                    &Actor::User,
                    EntityIn {
                        book: book.clone(),
                        id: fid,
                    },
                );
            }
            if self_trashed {
                let _ = ws.run::<AssetRestore>(&Actor::User, EntityIn { book, id: asset_id });
            }
        });
        let book_assets = self.book_assets.clone();
        cx.spawn(async move |this, cx| {
            job.await;
            this.update(cx, |b, cx| {
                *book_assets.borrow_mut() = None;
                b.reload(cx);
            })
            .ok();
        })
        .detach();
    }

    /// Removes this embed paragraph from the prose (one undoable step; keeps the file in the library).
    pub fn remove_from_prose(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((line, _)) = self.host.embed_line(&self.embed, cx) else {
            return;
        };
        let chapter = self.host.chapter;
        if let Some(body) = self.host.body.upgrade() {
            body.update(cx, |e, cx| {
                e.select_embed(chapter, line, window, cx);
                e.press_backspace(window, cx);
            });
        }
    }

    fn select(&self, window: &mut Window, cx: &mut App) {
        let Some((line, _)) = self.host.embed_line(&self.embed, cx) else {
            return;
        };
        let chapter = self.host.chapter;
        if let Some(body) = self.host.body.upgrade() {
            body.update(cx, |e, cx| e.select_embed(chapter, line, window, cx));
        }
    }

    fn start_caption_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.caption_edit.is_some() {
            return;
        }
        let strings = crate::file_host::strings(cx);
        let initial = self.look.caption.clone();
        let fid = format!("prose-embed-caption-{}", self.embed);
        let field = cx.new(|cx| {
            TextField::new(ElementId::Name(fid.into()), window, cx)
                .small()
                .placeholder(strings.prose_caption_placeholder)
                .with_text(initial)
        });
        let sub = cx.subscribe_in(
            &field,
            window,
            |this, field, ev: &FieldEvent, window, cx| match ev {
                FieldEvent::Submitted(_) | FieldEvent::Blurred => {
                    let next = field.read(cx).text();
                    this.caption_edit = None;
                    this.set_caption(next, cx);
                    if matches!(ev, FieldEvent::Submitted(_))
                        && let Some(body) = this.host.body.upgrade()
                    {
                        let focus = body.read(cx).focus_handle(cx);
                        window.focus(&focus, cx);
                    }
                    cx.notify();
                }
                FieldEvent::Cancelled => {
                    this.caption_edit = None;
                    if let Some(body) = this.host.body.upgrade() {
                        let focus = body.read(cx).focus_handle(cx);
                        window.focus(&focus, cx);
                    }
                    cx.notify();
                }
                FieldEvent::Changed(_) => {}
            },
        );
        let focus = field.read(cx).focus_handle(cx);
        window.focus(&focus, cx);
        self.caption_edit = Some(CaptionDraft { field, _sub: sub });
        cx.notify();
    }

    fn flash_keys(&self, cx: &App) -> Vec<String> {
        let mut keys = vec![format!("embed_id:{}", self.embed)];
        let block_id = self.host.body.upgrade().and_then(|body| {
            let e = body.read(cx);
            let line = e.embed_line(self.host.chapter, &self.embed)?;
            e.book()
                .chapters
                .get(self.host.chapter)?
                .doc
                .line(line)
                .bid()
                .map(str::to_owned)
        });
        if let Some(bid) = &block_id {
            keys.push(bid.clone());
        }
        if let Some(aid) = self.material.as_ref().map(|a| a.as_str()) {
            keys.push(aid.to_owned());
            if let Some((entry, module)) = crate::v3::body(&self.host.doc_id) {
                keys.push(format!("embed:{entry}:{module}:{aid}"));
                if let Some(bid) = &block_id {
                    keys.push(format!("embed:{entry}:{module}:{bid}"));
                }
            }
        }
        keys
    }

    fn wrap_hover_card(
        &self,
        facts: &MaterialFacts,
        is_image: bool,
        target: AnyElement,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let this = cx.entity();
        let title = facts.title.clone();
        let thumb_path = facts.thumb.clone();
        let is_pdf = facts.kind == "pdf";
        let cur_size = self.look.size.clone().unwrap_or(EmbedSize::Medium);
        let cur_align = self.look.align.clone().unwrap_or(EmbedAlign::Center);
        let cid = format!("dr-editor-embed-hc-{}", self.embed);
        let body_id = cid.clone();
        HoverCard::new(ElementId::Name(cid.into()), target, move |window, cx| {
            let theme = Theme::of(window, cx);
            let (p, s) = (theme.palette, theme.scale);
            let strings = crate::file_host::strings(cx);

            let open_ent = this.clone();
            let open_act = CardAction::new(
                ElementId::Name(format!("{body_id}-open").into()),
                RowIcon::Brush(Icon::GateOut),
                strings.open.clone(),
            )
            .on_click(move |_, _, cx| open_ent.update(cx, |b, cx| b.open(cx)))
            .into_any_element();

            let loc_ent = this.clone();
            let locate_act = CardAction::new(
                ElementId::Name(format!("{body_id}-locate").into()),
                RowIcon::Brush(Icon::Locate),
                strings.locate_in_library.clone(),
            )
            .on_click(move |_, window, cx| {
                loc_ent.update(cx, |b, cx| b.locate_in_library(window, cx));
            })
            .into_any_element();

            let comment_ent = this.clone();
            let comment_act = CardAction::new(
                ElementId::Name(format!("{body_id}-comment").into()),
                RowIcon::Brush(Icon::CommentPlus),
                strings.write_comment.clone(),
            )
            .on_click(move |_, window, cx| {
                let at = window.mouse_position();
                comment_ent.update(cx, |b, cx| b.comment(at, cx));
            })
            .into_any_element();

            let frame_ent = this.clone();
            let frame_act = CardAction::new(
                ElementId::Name(format!("{body_id}-frame").into()),
                RowIcon::Brush(Icon::Fullscreen),
                strings.draw_region_comment.clone(),
            )
            .on_click(move |_, _, cx| frame_ent.update(cx, |b, cx| b.frame(cx)))
            .into_any_element();

            let rem_ent = this.clone();
            let remove_act = CardAction::new(
                ElementId::Name(format!("{body_id}-remove").into()),
                RowIcon::Brush(Icon::Minus),
                strings.remove_from_prose.clone(),
            )
            .danger()
            .on_click(move |_, window, cx| {
                rem_ent.update(cx, |b, cx| b.remove_from_prose(window, cx));
            })
            .into_any_element();

            let mut card = CardBody::new(
                ElementId::Name(format!("{body_id}-body").into()),
                title.clone(),
            );

            if is_image {
                let make_size_seg = |choice: EmbedSize, label: gpui::SharedString, suffix: &str| {
                    let active = cur_size == choice;
                    let ent = this.clone();
                    div()
                        .id(ElementId::Name(format!("{body_id}-sz-{suffix}").into()))
                        .px(px(7.))
                        .py(px(2.))
                        .rounded(px(4.))
                        .cursor_pointer()
                        .role(gpui::Role::Button)
                        .when(active, |d| {
                            d.bg(p.page.solid())
                                .text_color(p.ink(1).solid())
                                .weight(weight::MEDIUM)
                        })
                        .when(!active, |d| {
                            d.text_color(p.ink(3).solid())
                                .hover(move |st| st.text_color(p.ink(1).solid()))
                        })
                        .font_role(Role::Index)
                        .type_px(s.caption, s.line_caption)
                        .child(label)
                        .on_click(move |_, _, cx| {
                            let c = choice.clone();
                            ent.update(cx, |b, cx| b.set_size(c, cx));
                        })
                };
                let size_row = div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .px(px(6.))
                    .py(px(2.))
                    .child(
                        div()
                            .font_role(Role::Index)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.ink(3).solid())
                            .child(strings.size_heading.clone()),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(2.))
                            .p(px(2.))
                            .rounded(px(6.))
                            .bg(p.ink(1).alpha(0.06))
                            .child(make_size_seg(
                                EmbedSize::Small,
                                strings.size_small.clone(),
                                "s",
                            ))
                            .child(make_size_seg(
                                EmbedSize::Medium,
                                strings.size_medium.clone(),
                                "m",
                            ))
                            .child(make_size_seg(
                                EmbedSize::Full,
                                strings.size_full.clone(),
                                "f",
                            )),
                    )
                    .into_any_element();

                let make_align_seg =
                    |choice: EmbedAlign, label: gpui::SharedString, suffix: &str| {
                        let active = cur_align == choice;
                        let ent = this.clone();
                        div()
                            .id(ElementId::Name(format!("{body_id}-al-{suffix}").into()))
                            .px(px(7.))
                            .py(px(2.))
                            .rounded(px(4.))
                            .cursor_pointer()
                            .role(gpui::Role::Button)
                            .when(active, |d| {
                                d.bg(p.page.solid())
                                    .text_color(p.ink(1).solid())
                                    .weight(weight::MEDIUM)
                            })
                            .when(!active, |d| {
                                d.text_color(p.ink(3).solid())
                                    .hover(move |st| st.text_color(p.ink(1).solid()))
                            })
                            .font_role(Role::Index)
                            .type_px(s.caption, s.line_caption)
                            .child(label)
                            .on_click(move |_, _, cx| {
                                let c = choice.clone();
                                ent.update(cx, |b, cx| b.set_align(c, cx));
                            })
                    };
                let align_row = div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .px(px(6.))
                    .py(px(2.))
                    .child(
                        div()
                            .font_role(Role::Index)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.ink(3).solid())
                            .child(strings.align_heading.clone()),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(2.))
                            .p(px(2.))
                            .rounded(px(6.))
                            .bg(p.ink(1).alpha(0.06))
                            .child(make_align_seg(
                                EmbedAlign::Left,
                                strings.align_left.clone(),
                                "l",
                            ))
                            .child(make_align_seg(
                                EmbedAlign::Center,
                                strings.align_center.clone(),
                                "c",
                            ))
                            .child(make_align_seg(
                                EmbedAlign::Right,
                                strings.align_right.clone(),
                                "r",
                            )),
                    )
                    .into_any_element();

                card = card.section(vec![size_row, align_row]);
            } else if let Some(path) = &thumb_path {
                let preview = div()
                    .w_full()
                    .h(px(124.))
                    .rounded(px(radius::SM))
                    .overflow_hidden()
                    .bg(p.ink(1).alpha(0.05))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(img(path.clone()).size_full().object_fit(if is_pdf {
                        ObjectFit::Contain
                    } else {
                        ObjectFit::Cover
                    }))
                    .into_any_element();
                card = card.section(vec![preview]);
            }

            card.section(vec![open_act, locate_act])
                .section(vec![comment_act, frame_act])
                .section(vec![remove_act])
                .into_any_element()
        })
        .into_any_element()
    }
}

impl Render for MaterialBlock {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.ensure_state();
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let style = self.host.style.borrow().clone();
        let (ink, muted) = (style.text, style.muted);
        let ring = style.cursor.opacity(0.55);
        let selected = self.selected;
        let strings = crate::file_host::strings(cx);
        let bounds_cell = self.bounds.clone();
        let measure = canvas(move |b, _, _| bounds_cell.set(Some(b)), |_, _, _, _| {})
            .absolute()
            .inset_0();
        let id = gpui::SharedString::from(format!("dr-editor-material-{}", self.embed));
        let state = self.state.clone();

        match state {
            None | Some(LookupState::Missing { .. }) => {
                let (title, is_pdf, restorable) = match state {
                    Some(LookupState::Missing {
                        title,
                        is_pdf,
                        restorable,
                        ..
                    }) => (title, is_pdf, restorable),
                    _ => (None, false, false),
                };
                let label = title.unwrap_or_else(|| {
                    self.material
                        .as_ref()
                        .map(|a| a.to_string())
                        .unwrap_or_default()
                });
                let gid = format!("dr-editor-gone-{}", self.embed);
                div()
                    .id(id)
                    .relative()
                    .w_full()
                    .min_h(px(64.))
                    .px(px(12.))
                    .py(px(10.))
                    .rounded(px(radius::SM))
                    .border_1()
                    .border_dashed()
                    .border_color(p.hairline())
                    .when(selected, |d| d.border_color(ring))
                    .bg(p.ink(1).alpha(0.02))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(measure)
                    .child(sand::icon(
                        if is_pdf { Icon::FileText } else { Icon::Image },
                        16.,
                        p.ink(4).solid(),
                    ))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .line_through()
                            .font_role(Role::Ui)
                            .type_px(s.secondary, s.line_body)
                            .text_color(p.ink(4).solid())
                            .child(label),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .when(restorable, |d| {
                                d.child(
                                    Button::new(
                                        ElementId::Name(format!("{gid}-restore").into()),
                                        strings.restore,
                                    )
                                    .text()
                                    .small()
                                    .on_click(cx.listener(|b, _, _, cx| b.restore_missing(cx))),
                                )
                            })
                            .child(
                                Button::new(
                                    ElementId::Name(format!("{gid}-remove").into()),
                                    strings.remove_from_prose,
                                )
                                .text()
                                .small()
                                .on_click(cx.listener(
                                    |b, _, window, cx| {
                                        b.remove_from_prose(window, cx);
                                    },
                                )),
                            ),
                    )
                    .into_any_element()
            }
            Some(LookupState::Live(facts)) => {
                let keys = self.flash_keys(cx);
                let flashing = crate::file_host::flash_active(&keys, window, cx);
                let sand_frame = SandFrame::new(
                    ElementId::Name(format!("dr-editor-embed-flash-{}", self.embed).into()),
                    flashing,
                )
                .color(p.accent);
                // An open comment on this embed: one sand dot on the corner,
                // never a count (`kernel-v5.md` §7).
                let comment_dot = |on: bool| {
                    on.then(|| {
                        div()
                            .absolute()
                            .top(px(5.))
                            .right(px(5.))
                            .child(sand::comment_dot(8.0, false, p))
                    })
                };

                if facts.kind == "image" {
                    let size_mode = self.look.size.clone().unwrap_or(EmbedSize::Medium);
                    let align_mode = self.look.align.clone().unwrap_or(EmbedAlign::Center);
                    let apply_fig_width = |d: gpui::Div| match size_mode {
                        EmbedSize::Small => d.w(relative(0.36)),
                        EmbedSize::Medium | EmbedSize::Other(_) => d.w(relative(0.64)),
                        EmbedSize::Full => d.w_full(),
                    };
                    let this = cx.entity();
                    let fig_box = match facts.picture.clone() {
                        Some(path) => {
                            let (open_ent, pick_ent) = (this.clone(), this.clone());
                            div()
                                .id("picture")
                                .w_full()
                                .relative()
                                .rounded(px(radius::SM))
                                .overflow_hidden()
                                .when(selected, |d| d.border_2().border_color(ring))
                                .cursor_pointer()
                                .on_click(move |event, window, cx| {
                                    if event.click_count() >= 2 {
                                        open_ent.update(cx, |b, cx| b.open(cx));
                                    } else {
                                        pick_ent.update(cx, |b, cx| b.select(window, cx));
                                    }
                                })
                                .child(
                                    img(path)
                                        .w_full()
                                        .max_h(px(520.))
                                        .rounded(px(radius::SM))
                                        .object_fit(ObjectFit::Contain),
                                )
                                .children(comment_dot(facts.has_open_comment))
                                .into_any_element()
                        }
                        None => div()
                            .w_full()
                            .h(px(120.))
                            .relative()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(radius::SM))
                            .border_1()
                            .border_dashed()
                            .border_color(muted.opacity(0.45))
                            .when(selected, |d| d.border_2().border_color(ring))
                            .text_size(px(12.))
                            .text_color(muted)
                            .child(sand::icon(Icon::Image, 20., muted))
                            .children(comment_dot(facts.has_open_comment))
                            .into_any_element(),
                    };
                    let wrapped_fig = self.wrap_hover_card(&facts, true, fig_box, cx);
                    // Wrap `HoverCard` in a width-constrained slot so `Small`/`Medium`
                    // keep their percentage width inside the flex column.
                    let sized_slot = apply_fig_width(div())
                        .relative()
                        .child(wrapped_fig)
                        .child(sand_frame);

                    let caption_el: Option<AnyElement> = if let Some(draft) = &self.caption_edit {
                        Some(
                            apply_fig_width(div())
                                .pt(px(2.))
                                .child(draft.field.clone())
                                .into_any_element(),
                        )
                    } else if !self.look.caption.is_empty() {
                        let edit_ent = this.clone();
                        Some(
                            apply_fig_width(div())
                                .id("caption")
                                .pt(px(2.))
                                .text_size(px(12.))
                                .text_color(muted)
                                .hover(|st| st.text_color(ink))
                                .map(|d| match align_mode {
                                    EmbedAlign::Left => d.text_left(),
                                    EmbedAlign::Center | EmbedAlign::Other(_) => d.text_center(),
                                    EmbedAlign::Right => d.text_right(),
                                })
                                .cursor_pointer()
                                .on_click(move |_, window, cx| {
                                    edit_ent.update(cx, |b, cx| b.start_caption_edit(window, cx));
                                })
                                .child(self.look.caption.clone())
                                .into_any_element(),
                        )
                    } else if selected {
                        let edit_ent = this.clone();
                        Some(
                            apply_fig_width(div())
                                .id("caption-placeholder")
                                .pt(px(2.))
                                .text_size(px(12.))
                                .text_color(muted.opacity(0.65))
                                .hover(|st| st.text_color(muted))
                                .map(|d| match align_mode {
                                    EmbedAlign::Left => d.text_left(),
                                    EmbedAlign::Center | EmbedAlign::Other(_) => d.text_center(),
                                    EmbedAlign::Right => d.text_right(),
                                })
                                .cursor_pointer()
                                .on_click(move |_, window, cx| {
                                    edit_ent.update(cx, |b, cx| b.start_caption_edit(window, cx));
                                })
                                .child(strings.prose_caption_placeholder)
                                .into_any_element(),
                        )
                    } else {
                        // Empty caption takes zero height unless selected or editing (`v5-tracks.md` §T5).
                        None
                    };

                    return div()
                        .id(id)
                        .relative()
                        .w_full()
                        .flex()
                        .flex_col()
                        .map(|d| match align_mode {
                            EmbedAlign::Left => d.items_start(),
                            EmbedAlign::Center | EmbedAlign::Other(_) => d.items_center(),
                            EmbedAlign::Right => d.items_end(),
                        })
                        .gap(px(4.))
                        .child(measure)
                        .child(sized_slot)
                        .children(caption_el)
                        .into_any_element();
                }

                // PDF card (`.pdfc`): 44×60 thumb, filename, `PDF · N 页`, single-click opens viewer.
                let pages = self
                    .material
                    .as_ref()
                    .and_then(|aid| crate::file_host::pdf_pages(&self.host.ws, aid.as_str(), cx));
                let mut sub_parts = vec![strings.kind_pdf.to_string()];
                if let Some(n) = pages {
                    sub_parts.push(crate::file_host::format_page_count(n, cx));
                }
                let thumb = match facts.picture.clone() {
                    Some(path) => img(path)
                        .w(px(44.))
                        .h(px(60.))
                        .rounded(px(4.))
                        .object_fit(ObjectFit::Cover)
                        .into_any_element(),
                    None => div()
                        .w(px(44.))
                        .h(px(60.))
                        .rounded(px(4.))
                        .bg(p.ink(1).alpha(0.05))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(sand::icon(Icon::FileText, 20., muted))
                        .into_any_element(),
                };
                let open_ent = cx.entity();
                let card_inner = div()
                    .id("pdf-card")
                    .relative()
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .px(px(10.))
                    .py(px(8.))
                    .rounded(px(radius::SM))
                    .border_1()
                    .border_color(if selected { ring } else { p.hairline() })
                    .bg(p.ink(1).alpha(0.025))
                    .hover(|st| st.bg(p.ink(1).alpha(0.05)))
                    .cursor_pointer()
                    .on_click(move |_, _, cx| open_ent.update(cx, |b, cx| b.open(cx)))
                    .child(thumb)
                    .children(comment_dot(facts.has_open_comment))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(
                                div()
                                    .font_role(Role::Ui)
                                    .type_px(13.5, 19.)
                                    .weight(weight::MEDIUM)
                                    .text_color(ink)
                                    .truncate()
                                    .child(facts.title.clone()),
                            )
                            .child(
                                div()
                                    .font_role(Role::Index)
                                    .type_px(11., 15.)
                                    .text_color(muted)
                                    .truncate()
                                    .child(sub_parts.join(" · ")),
                            ),
                    )
                    .into_any_element();
                let wrapped = self.wrap_hover_card(&facts, false, card_inner, cx);
                div()
                    .id(id)
                    .relative()
                    .w_full()
                    .child(measure)
                    .child(wrapped)
                    .child(sand_frame)
                    .into_any_element()
            }
        }
    }
}
