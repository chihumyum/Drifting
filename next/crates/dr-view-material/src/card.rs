//! A material at a glance, for every view that lists materials (the 素材库
//! panel's rows; M23's 审阅与素材 cards).
//!
//! - [`thumb`]: the square at the head of a row (32 px in the panel): an
//!   image's or a PDF's thumbnail cut to the square on a hairline, a note's
//!   glyph, or the kind's glyph while the thumbnail is being made.
//! - [`subline`]: the quieter line under the title: a note's first words
//!   (「写点什么…」 for an empty note), a file's kind (图片 / PDF).
//! - [`MaterialCard`]: a tile — the picture (or a note's first words) over
//!   the title and the subline, in a card of still glass that flows under
//!   the pointer; chosen, the brush goes round it.
//!
//! Previews come from [`crate::previews`]; the tile and the row never read
//! files themselves.

use std::rc::Rc;

use dr_i18n::keys;
use dr_shell::t;
use dr_ui::Theme;
use dr_ui::fonts::{Role, weight};
use dr_ui::glass::{self, Kind as GlassKind, Mode, Spec, Tone};
use dr_ui::sand::{self, Icon, KindMark, SandFrame};
use dr_ui::style::DrStyled;
use dr_ui::tokens::radius;
use dr_workspace::dto::MaterialInfo;
use gpui::{
    AnyElement, App, ClickEvent, ElementId, IntoElement, ObjectFit, ParentElement, RenderOnce,
    SharedString, StatefulInteractiveElement, Styled, StyledImage as _, Window, div, img,
    prelude::FluentBuilder, px,
};

use crate::page::MediaKind;
use crate::previews;

/// The kind's name (笔记 / 图片 / PDF).
pub fn kind_label(kind: &str, cx: &App) -> SharedString {
    match kind {
        "text" => t(cx, keys::memo_material::kind::TEXT),
        "image" => t(cx, keys::memo_material::kind::IMAGE),
        "pdf" => t(cx, keys::memo_material::kind::PDF),
        other => other.to_owned().into(),
    }
}

/// The line under a material's title: a note's first words, a file's kind.
pub fn subline(material: &MaterialInfo, cx: &mut App) -> SharedString {
    if material.kind != "text" {
        return kind_label(&material.kind, cx);
    }
    match previews::first_words(&material.id, cx) {
        Some(w) if !w.is_empty() => w.into(),
        Some(_) => t(cx, keys::memo_material::card::ADD_SNIPPET_BODY),
        None => kind_label("text", cx),
    }
}

/// The material's square: its thumbnail, or a glyph.
pub fn thumb(material: &MaterialInfo, side: f32, window: &mut Window, cx: &mut App) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let picture = MediaKind::parse(&material.kind)
        .zip(material.asset.as_deref())
        .and_then(|(kind, asset)| previews::thumbnail(asset, kind, cx));
    let frame = div()
        .size(px(side))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .overflow_hidden()
        .rounded(px(radius::SM))
        .border_1()
        .border_color(p.hairline())
        .bg(p.desk.alpha(0.5));
    match picture {
        Some(pic) => frame
            .child(img(pic.image).size_full().object_fit(ObjectFit::Cover))
            .into_any_element(),
        None => {
            let icon = if material.kind == "image" {
                Icon::Image
            } else {
                Icon::FileText
            };
            frame
                .child(sand::icon(icon, (side * 0.45).round(), p.ink(4).solid()))
                .into_any_element()
        }
    }
}

type OnClick = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// A material as a tile.
#[derive(IntoElement)]
pub struct MaterialCard {
    id: ElementId,
    material: MaterialInfo,
    width: f32,
    selected: bool,
    on_click: Option<OnClick>,
}

impl MaterialCard {
    pub fn new(id: impl Into<ElementId>, material: &MaterialInfo) -> MaterialCard {
        MaterialCard {
            id: id.into(),
            material: material.clone(),
            width: 168.0,
            selected: false,
            on_click: None,
        }
    }

    /// The tile's width; the picture is three quarters of it high.
    pub fn width(mut self, width: f32) -> Self {
        self.width = width;
        self
    }

    /// Chosen: the brush goes round it.
    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    /// A click (`click_count` tells a double click).
    pub fn on_click(mut self, f: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(f));
        self
    }
}

impl RenderOnce for MaterialCard {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let m = &self.material;
        let inner = self.width - 16.0;
        let picture_h = (inner * 0.75).round();
        let picture = MediaKind::parse(&m.kind)
            .zip(m.asset.as_deref())
            .and_then(|(kind, asset)| previews::thumbnail(asset, kind, cx));
        let face = div()
            .w(px(inner))
            .h(px(picture_h))
            .overflow_hidden()
            .rounded(px(radius::SM))
            .bg(p.desk.alpha(0.5));
        let face = match (&picture, m.kind.as_str()) {
            (Some(pic), _) => face.child(
                img(pic.image.clone())
                    .size_full()
                    .object_fit(ObjectFit::Cover),
            ),
            (None, "text") => {
                let words = subline(m, cx);
                face.p(px(8.0))
                    .font_role(Role::Prose)
                    .type_px(s.caption + 1.0, s.line_caption + 3.0)
                    .text_color(p.ink(2).solid())
                    .child(words)
            }
            (None, _) => face
                .flex()
                .items_center()
                .justify_center()
                .child(sand::icon(
                    if m.kind == "image" {
                        Icon::Image
                    } else {
                        Icon::FileText
                    },
                    22.0,
                    p.ink(4).solid(),
                )),
        };
        let title: SharedString = if m.title.trim().is_empty() {
            t(cx, keys::top_timeline::untitled::LIBRARY_ITEM)
        } else {
            m.title.clone().into()
        };
        let sub = if m.kind == "text" {
            kind_label("text", cx)
        } else {
            subline(m, cx)
        };
        let id = self.id.clone();
        let mark_id = ElementId::Name(format!("{id}-mark").into());
        let frame_id = ElementId::Name(format!("{id}-frame").into());
        glass::glass_box(
            self.id,
            GlassKind::Surface,
            Mode::default(),
            false,
            Spec::new(Tone::Clear, radius::MD),
            window,
            cx,
        )
        .relative()
        .w(px(self.width))
        .p(px(8.0))
        .flex()
        .flex_col()
        .gap(px(6.0))
        .rounded(px(radius::MD))
        .child(SandFrame::new(frame_id, self.selected))
        .child(face)
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .child(KindMark::new(mark_id, sand::Kind::Material))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .font_role(Role::Ui)
                        .type_px(s.secondary, s.line_body)
                        .weight(weight::MEDIUM)
                        .text_color(p.ink(1).solid())
                        .child(title),
                ),
        )
        .child(
            div()
                .overflow_hidden()
                .whitespace_nowrap()
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.muted().solid())
                .child(sub),
        )
        .when_some(self.on_click, |el, f| {
            el.cursor_pointer().on_click(move |e, w, cx| f(e, w, cx))
        })
    }
}
