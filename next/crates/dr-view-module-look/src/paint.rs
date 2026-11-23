//! A [`Plan`] as GPUI elements, every style step on a dr-ui token (§4
//! 「风格甲」): the three faces are the App's roles (serif the manuscript's,
//! sans the interface's, mono the index's), the four sizes the interface
//! scale, the four inks the palette's, the edges a hairline, a resting glass
//! rim or a resting sand frame, the grounds the paper or a wash of ink, the
//! arc and the marks dr-ui's sand. Nothing here has a colour of its own:
//! light and dark come from the theme.
//!
//! A host that edits values ([`Edit`]) is handed each value node and each
//! list item as it is drawn, and puts its own controls there.

use std::sync::Arc;

use dr_model::custom_module::{
    Align, Background, BlockKind, Border, BoxDir, Column, Connector, Decoration, EachDir, Font,
    Separator, TextSize, Width,
};
use dr_ui::{
    Theme,
    fonts::Role,
    glass::{self, Kind as GlassKind, Mode, Spec, Tone},
    sand::{self, Icon, KindMark, SandFrame, SandMask},
    style::{DrStyled, child_id},
    text::wrapped,
    tokens::{Rgb, surface},
};
use gpui::{
    AnyElement, App, ElementId, Hsla, InteractiveElement, IntoElement, ObjectFit, ParentElement,
    RenderImage, Styled, StyledImage as _, Window, canvas, div, img, point,
    prelude::FluentBuilder as _, px, relative, size, svg,
};

use crate::plan::{Content, Fill, PBox, PEach, PItem, PNode, PText, PValue, Plan, TextStyle};

/// How a value with nothing kept is drawn read-only.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Blanks {
    /// A dash in the faintest ink.
    #[default]
    Dash,
    /// The block's name in the faintest ink (the workbench's 「空」).
    Names,
}

/// A host that edits the values it draws (the entry page).
pub trait Edit {
    /// What stands where a value node is: `display` is the value as it is
    /// drawn read-only, in the node's type.
    fn value(
        &self,
        value: &PValue,
        id: ElementId,
        display: AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement;

    /// One item of a list (`body` is the item as drawn).
    #[allow(clippy::too_many_arguments)]
    fn item(
        &self,
        each: &PEach,
        index: usize,
        item: &PItem,
        id: ElementId,
        body: AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement;

    /// What follows a list's items (its 「加一项」), if anything.
    fn after_items(
        &self,
        each: &PEach,
        id: ElementId,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<AnyElement>;
}

/// The wash of ink a box's 「淡墨」 ground is (`--wash`, the prototype's).
pub const WASH: f32 = 0.04;
/// The resting strength of a box's 「砂笔框」 edge (a region comment's).
pub const SAND_REST: f32 = 0.5;
/// A dot of a number shown as dots, and the gap after it.
pub const DOT: f32 = 10.0;
pub const DOT_GAP: f32 = 3.0;
/// A select shown as a mark.
pub const MARK: f32 = 13.0;
/// An image value's height.
pub const IMAGE_HEIGHT: f32 = 64.0;
/// A list's axis: the room it takes, where its line runs, its dots.
const AXIS_ROOM: f32 = 14.0;
const AXIS_LINE: f32 = 4.0;
const AXIS_DOT: f32 = 7.0;

/// Paints `plan`. `id` names the look (element ids under it are made from
/// it); `edit`, when given, puts the host's controls in the value nodes.
pub fn paint(
    id: impl Into<ElementId>,
    plan: &Plan,
    blanks: Blanks,
    edit: Option<&dyn Edit>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let id = id.into();
    let mut p = Painter {
        blanks,
        edit,
        theme: Theme::of(window, cx),
    };
    p.node(&plan.root, child_id(&id, "root"), false, window, cx)
}

struct Painter<'e> {
    blanks: Blanks,
    edit: Option<&'e dyn Edit>,
    theme: Theme,
}

/// The interface role a face is drawn with.
pub fn role(font: Font) -> Role {
    match font {
        Font::Serif => Role::Prose,
        Font::Sans => Role::Ui,
        Font::Mono => Role::Index,
    }
}

/// A size's font size and line height on the interface scale, px.
pub fn type_px(size: TextSize, theme: &Theme) -> (f32, f32) {
    let s = theme.scale;
    match size {
        TextSize::Title => (s.heading, (s.heading * 1.4).round()),
        TextSize::Body => (s.body, s.line_body),
        TextSize::Small => (s.secondary, (s.secondary * 1.4).round()),
        TextSize::Note => (s.caption, s.line_caption),
    }
}

/// An ink step (1 darkest to 4 faintest) on the palette.
pub fn ink(level: u8, theme: &Theme) -> Rgb {
    theme.palette.ink(usize::from(level.clamp(1, 4)))
}

/// `el` in a value's or text's type: its face, size and ink.
pub fn typed<E: Styled>(el: E, style: TextStyle, theme: &Theme) -> E {
    let (size, line) = type_px(style.size, theme);
    el.font_role(role(style.font))
        .type_px(size, line)
        .text_color(ink(style.ink, theme).solid())
}

/// How a node takes the width its parent gives it.
fn sized<E: Styled>(el: E, width: Width, in_row: bool) -> E {
    match (width, in_row) {
        (Width::Fill, true) => el.flex_1().min_w_0(),
        (Width::Fill, false) => el.w_full(),
        (Width::Hug, true) => el.flex_none(),
        (Width::Hug, false) => el.self_start(),
        (Width::Auto, _) => el,
    }
}

fn aligned<E: Styled>(el: E, align: Align) -> E {
    match align {
        Align::Start => el.items_start(),
        Align::Center => el.items_center(),
        Align::End => el.items_end(),
        Align::Stretch => el.items_stretch(),
    }
}

impl Painter<'_> {
    fn sand(&self, color: Rgb) -> Hsla {
        let p = self.theme.palette;
        p.sand_on(color, p.page).solid()
    }

    fn node(
        &mut self,
        n: &PNode,
        id: ElementId,
        in_row: bool,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        match n {
            PNode::Box(b) => self.boxed(b, id, in_row, window, cx),
            PNode::Each(e) => self.each(e, id, in_row, window, cx),
            PNode::Value(v) => self.value(v, id, in_row, window, cx),
            PNode::Text(t) => self.text(t, id, in_row),
            PNode::Mark(m) => self.mark(&m.mark, id),
        }
    }

    fn boxed(
        &mut self,
        b: &PBox,
        id: ElementId,
        in_row: bool,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let p = self.theme.palette;
        let el = if b.border == Border::Glass {
            glass::glass_box(
                id.clone(),
                GlassKind::Still,
                Mode::default(),
                false,
                Spec::new(Tone::Clear, b.radius),
                window,
                cx,
            )
        } else {
            div().id(id.clone())
        };
        let mut el = sized(el.relative().flex().min_w_0(), b.width, in_row)
            .gap(px(b.gap))
            .p(px(b.pad))
            .rounded(px(b.radius))
            .when_some(b.max, |el, max| el.max_w(px(max)));
        el = match b.bg {
            Background::None => el,
            Background::Paper => el.bg(p.page.solid()),
            Background::Wash => el.bg(p.ink(1).alpha(WASH)),
        };
        if b.border == Border::Hair {
            el = el.border(px(surface::HAIRLINE)).border_color(p.hairline());
        }
        let kids_in_row = b.dir == BoxDir::Row;
        el = match b.dir {
            BoxDir::Col => aligned(el.flex_col(), b.align),
            BoxDir::Row => aligned(el.flex_row(), b.align).when(!b.nowrap, |el| el.flex_wrap()),
            BoxDir::Grid => el.flex_col(),
        };
        if b.dir == BoxDir::Grid {
            let cols = if b.cols.is_empty() {
                vec![Column::Fill(dr_model::custom_module::ColumnFill::Fill)]
            } else {
                b.cols.clone()
            };
            for (r, row) in b.kids.chunks(cols.len()).enumerate() {
                let mut line = aligned(div().flex().flex_row().min_w_0().gap(px(b.gap)), b.align);
                for (c, kid) in row.iter().enumerate() {
                    let cell = match cols[c] {
                        Column::Fixed(w) => div().w(px(f32::from(w))).flex_none(),
                        Column::Fill(_) => div().flex_1().min_w_0(),
                    };
                    let kid_id = child_id(&id, format!("{}", r * cols.len() + c));
                    let kid = self.node(kid, kid_id, false, window, cx);
                    line = line.child(cell.flex().flex_col().child(kid));
                }
                el = el.child(line);
            }
        } else {
            for (i, kid) in b.kids.iter().enumerate() {
                let kid = self.node(kid, child_id(&id, format!("{i}")), kids_in_row, window, cx);
                el = el.child(kid);
            }
        }
        if b.border == Border::Sand {
            el = el.child(
                SandFrame::new(child_id(&id, "frame"), false)
                    .rest(SAND_REST)
                    .color(p.ink(3)),
            );
        }
        if b.deco == Decoration::Arc {
            el = el.child(arc(child_id(&id, "arc"), self.sand(p.ink(3))));
        }
        el.into_any_element()
    }

    fn each(
        &mut self,
        e: &PEach,
        id: ElementId,
        in_row: bool,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let p = self.theme.palette;
        let row = e.dir == EachDir::Row;
        let mut el = div()
            .id(id.clone())
            .relative()
            .flex()
            .min_w_0()
            .gap(px(e.gap));
        el = if row {
            el.flex_row().flex_wrap().items_center()
        } else {
            el.flex_col()
        };
        if !in_row {
            el = el.w_full();
        }
        let axis = e.sep == Separator::Axis && !e.items.is_empty();
        if axis {
            let line = div().absolute().bg(p.hairline());
            el = if row {
                el.pt(px(AXIS_ROOM)).child(
                    line.left_0()
                        .right_0()
                        .top(px(AXIS_LINE))
                        .h(px(surface::HAIRLINE * 2.0)),
                )
            } else {
                el.pl(px(AXIS_ROOM)).child(
                    line.top(px(AXIS_ROOM / 2.0))
                        .bottom(px(AXIS_ROOM / 2.0))
                        .left(px(AXIS_LINE))
                        .w(px(surface::HAIRLINE * 2.0)),
                )
            };
        }
        let dot = self.sand(p.ink(3));
        for (i, item) in e.items.iter().enumerate() {
            if i > 0 && e.link == Connector::Arrow {
                el = el.child(
                    div()
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(sand::icon(
                            if row {
                                Icon::ArrowForward
                            } else {
                                Icon::ArrowDown
                            },
                            12.0,
                            p.ink(4).solid(),
                        )),
                );
            }
            let item_id = child_id(
                &id,
                match &item.id {
                    Some(item) => format!("item-{item}"),
                    None => format!("item#{i}"),
                },
            );
            let body = self.boxed(&item.body, child_id(&item_id, "body"), row, window, cx);
            let mut wrap = div().relative().flex().min_w_0().child(body);
            wrap = if row {
                wrap.flex_row()
            } else {
                wrap.flex_col()
            };
            if i > 0 && e.sep == Separator::Hair {
                wrap = if row {
                    wrap.border_l(px(surface::HAIRLINE))
                } else {
                    wrap.border_t(px(surface::HAIRLINE))
                }
                .border_color(p.hairline());
            }
            if axis {
                let mark = svg()
                    .path(SandMask::Blob0.shared_path())
                    .size(px(AXIS_DOT))
                    .text_color(dot)
                    .absolute();
                wrap = wrap.child(if row {
                    mark.top(px(-(AXIS_ROOM - AXIS_LINE) + 1.0)).left(px(2.0))
                } else {
                    mark.left(px(-(AXIS_ROOM - 1.0)))
                        .top(relative(0.5))
                        .mt(px(-AXIS_DOT / 2.0))
                });
            }
            let wrap = wrap.into_any_element();
            let drawn = match self.edit {
                Some(edit) => edit.item(e, i, item, item_id, wrap, window, cx),
                None => wrap,
            };
            el = el.child(drawn);
        }
        if let Some(edit) = self.edit
            && let Some(after) = edit.after_items(e, child_id(&id, "after"), window, cx)
        {
            el = el.child(after);
        }
        el.into_any_element()
    }

    fn text(&self, t: &PText, id: ElementId, in_row: bool) -> AnyElement {
        sized(
            typed(div().id(id).min_w_0(), t.style, &self.theme),
            t.width,
            in_row,
        )
        .child(wrapped(t.text.clone()))
        .into_any_element()
    }

    fn mark(&self, name: &str, id: ElementId) -> AnyElement {
        div()
            .flex_none()
            .flex()
            .items_center()
            .child(KindMark::new(id, mark_kind(name)).color(self.theme.palette.ink(2)))
            .into_any_element()
    }

    fn value(
        &mut self,
        v: &PValue,
        id: ElementId,
        in_row: bool,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let display = display(v, self.blanks, &self.theme);
        let el = sized(div().id(id.clone()).min_w_0(), v.width, in_row);
        match self.edit {
            Some(edit) => el
                .child(edit.value(v, child_id(&id, "edit"), display, window, cx))
                .into_any_element(),
            None => el.child(display).into_any_element(),
        }
    }
}

/// `v` as it is drawn read-only, in its node's type.
pub fn display(v: &PValue, blanks: Blanks, theme: &Theme) -> AnyElement {
    let p = theme.palette;
    let sand = |c: Rgb| p.sand_on(c, p.page).solid();
    let text = |s: String| {
        let w = wrapped(s);
        match v.lines {
            Some(n) => w.max_lines(usize::from(n)),
            None => w,
        }
    };
    let typed_div = || typed(div().min_w_0(), v.style, theme);
    let with_suffix = |el: gpui::Div| match &v.suffix {
        Some(s) => el.child(s.clone()),
        None => el,
    };
    match &v.content {
        Content::Words(s) => {
            let words = match &v.suffix {
                Some(suffix) => format!("{s}{suffix}"),
                None => s.clone(),
            };
            typed_div().child(text(words)).into_any_element()
        }
        Content::Count(n) => {
            with_suffix(typed_div().flex().flex_row().child(format!("{n}"))).into_any_element()
        }
        Content::Missing => {
            let words = match blanks {
                Blanks::Dash => "—".to_owned(),
                Blanks::Names => v.name.clone(),
            };
            typed_div()
                .text_color(p.ink(4).solid())
                .child(text(words))
                .into_any_element()
        }
        Content::Toggle(on) => typed_div()
            .child(format!("{} {}", if *on { "✓" } else { "□" }, v.name))
            .into_any_element(),
        Content::Choices(xs) => typed_div().child(text(xs.join(" · "))).into_any_element(),
        Content::Entries(xs) => typed_div()
            .child(text(
                xs.iter()
                    .map(|e| e.title.as_str())
                    .collect::<Vec<_>>()
                    .join(" · "),
            ))
            .into_any_element(),
        Content::Dots { filled, of } => {
            let color = sand(ink(v.style.ink, theme));
            div()
                .flex()
                .flex_row()
                .flex_none()
                .items_center()
                .gap(px(DOT_GAP))
                .py(px(2.0))
                .children((0..*of).map(|i| {
                    let mask = dot_mask(i, i < *filled);
                    svg()
                        .path(mask.shared_path())
                        .size(px(DOT))
                        .flex_none()
                        .text_color(color)
                }))
                .into_any_element()
        }
        Content::Mark(fill) => mark_of(*fill, sand(ink(v.style.ink, theme)))
            .py(px(2.0))
            .into_any_element(),
        Content::Image(picture) => {
            let frame = div()
                .w_full()
                .h(px(IMAGE_HEIGHT))
                .rounded(px(2.0))
                .overflow_hidden();
            match &picture.path {
                Some(path) => frame
                    .child(img(path.clone()).size_full().object_fit(ObjectFit::Contain))
                    .into_any_element(),
                None => frame
                    .border(px(surface::HAIRLINE))
                    .border_color(p.hairline())
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(sand::icon(Icon::Image, 16.0, p.ink(4).solid()))
                    .into_any_element(),
            }
        }
    }
}

/// A select's mark (§4): a hollow ring, half filled, or full.
pub fn mark_of(fill: Fill, color: Hsla) -> gpui::Div {
    let ring = svg()
        .path(SandMask::Blob0Hollow.shared_path())
        .size(px(MARK))
        .absolute()
        .top_0()
        .left_0()
        .text_color(color);
    let full = svg()
        .path(SandMask::Blob0.shared_path())
        .size(px(MARK))
        .text_color(color);
    let slot = div().relative().flex_none().size(px(MARK));
    match fill {
        Fill::Hollow => slot.child(ring),
        Fill::Half => slot.child(ring).child(
            div()
                .absolute()
                .top_0()
                .left_0()
                .h(px(MARK))
                .w(px(MARK / 2.0))
                .overflow_hidden()
                .child(full),
        ),
        Fill::Full => slot.child(full.absolute().top_0().left_0()),
    }
}

fn dot_mask(i: u8, filled: bool) -> SandMask {
    use SandMask as M;
    let i = usize::from(i) % 6;
    if filled {
        [M::Blob0, M::Blob1, M::Blob2, M::Blob3, M::Blob4, M::Blob5][i]
    } else {
        [
            M::Blob0Hollow,
            M::Blob1Hollow,
            M::Blob2Hollow,
            M::Blob3Hollow,
            M::Blob4Hollow,
            M::Blob5Hollow,
        ][i]
    }
}

/// A mark node's sand mark, by the names the mark pickers list
/// (`dr_shell::book::v3::mark`, the same seven).
pub fn mark_kind(name: &str) -> sand::Kind {
    match name {
        "book" => sand::Kind::All,
        "file-text" => sand::Kind::Chapter(0),
        "lightbulb" => sand::Kind::Drift { loose: false },
        "folder" => sand::Kind::Category,
        "compass" => sand::Kind::Storyline,
        "git-branch" => sand::Kind::DriftGroup,
        _ => sand::Kind::Element,
    }
}

/// Whether a value of `kind` is drawn with words (and so is typed into in
/// place).
pub fn is_wordy(kind: BlockKind) -> bool {
    matches!(
        kind,
        BlockKind::Text | BlockKind::LongText | BlockKind::Number | BlockKind::Date
    )
}

/// The arc decoration (§4 「弧线」): one dry stroke over the box, the
/// prototype's `M1 19 Q50 -8 99 19` stretched across its width.
fn arc(id: ElementId, color: Hsla) -> impl IntoElement {
    div()
        .absolute()
        .top(px(-14.0))
        .left(relative(0.06))
        .w(relative(0.88))
        .h(px(22.0))
        .child(ArcStroke { id, color })
}

#[derive(IntoElement)]
struct ArcStroke {
    id: ElementId,
    color: Hsla,
}

/// The arc's stroke as an image, where it lies from the box's corner and how
/// big it is, px.
type ArcImage = (Arc<RenderImage>, (f32, f32), (f32, f32));

#[derive(Default)]
struct ArcCache {
    key: Option<(u32, u32, u32, [u8; 4])>,
    image: Option<ArcImage>,
}

impl gpui::RenderOnce for ArcStroke {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let cache = window.use_keyed_state(self.id.clone(), cx, |_, _| ArcCache::default());
        let color = self.color;
        canvas(
            |_, _, _| (),
            move |bounds, _, window, cx| {
                let scale = window.scale_factor();
                let (w, h) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
                let rgba = color.to_rgb();
                let rgb = [
                    (rgba.r * 255.0) as u8,
                    (rgba.g * 255.0) as u8,
                    (rgba.b * 255.0) as u8,
                    (rgba.a * 255.0) as u8,
                ];
                let key = (w as u32, h as u32, (scale * 100.0) as u32, rgb);
                cache.update(cx, |c, _| {
                    if c.key != Some(key) {
                        if let Some((old, _, _)) = c.image.take() {
                            let _ = window.drop_image(old);
                        }
                        c.key = Some(key);
                        let pts = sand::line::quadratic(
                            (1.0, h - 3.0),
                            (w / 2.0, -8.0),
                            (w - 1.0, h - 3.0),
                        );
                        if let Some(line) = sand::line::along(&pts, 3.0, scale, 7) {
                            let image = line.image([rgb[0], rgb[1], rgb[2]], rgba.a);
                            c.image = Some((
                                image,
                                line.origin,
                                (
                                    line.stroke.width as f32 / scale,
                                    line.stroke.height as f32 / scale,
                                ),
                            ));
                        }
                    }
                    if let Some((image, origin, sz)) = &c.image {
                        let at = gpui::Bounds::new(
                            point(
                                bounds.origin.x + px(origin.0),
                                bounds.origin.y + px(origin.1),
                            ),
                            size(px(sz.0), px(sz.1)),
                        );
                        let _ = window.paint_image(
                            at,
                            at,
                            gpui::Corners::default(),
                            image.clone(),
                            0,
                            false,
                        );
                    }
                });
            },
        )
        .size_full()
    }
}

/// Element ids made from a look's id and a list's or value's place, so
/// controls keep their state across refreshes.
pub fn value_id(look: &ElementId, v: &PValue) -> ElementId {
    let path: Vec<String> = v
        .path
        .iter()
        .map(|s| format!("{}:{}", s.list, s.item))
        .collect();
    child_id(look, format!("{}/{}", path.join("/"), v.block))
}
