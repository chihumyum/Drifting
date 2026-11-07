//! The prototype's pages, and the `--bench` and `--capture` runs.

use std::sync::Arc;

use gpui::{
    AnyElement, BoxShadow, Context, Corners, Div, FontWeight, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, ObjectFit, SharedString, Stateful, Window, canvas, div, img,
    point, prelude::*, px, svg,
};

use crate::{
    IconWay, Page, Spike, TOP_BAR, WINDOW_W,
    assets::{icon_embed_path, icon_vector_path, sand_embed_path},
    covers,
    glass::{self, DENSE, Forced, Ground, Kind, Look, Plan, SAMPLE_ORIGINS, control_id},
    theme::{Rgb, Theme},
};

const UI_FONT: &str = "PingFang SC";
const PROSE_FONT: &str = "Songti SC";

/// A paragraph set for the page: synthetic, written for this prototype.
const PROSE: [&str; 5] = [
    "灯转到第九圈，海面上那点光还在。林岚把信纸叠回信封，又抽出来，借着灯的扫光把背面那行铅笔字看了一遍。字很淡，像是写字的人怕被谁看见，又怕自己忘了。",
    "守塔人上楼来添油，看见她坐在窗边，便把油壶放在门口，没有进来。他说码头那边的雾要到后半夜才散，要等船，不如先睡一会儿。林岚说她不等船，只是想看看那光会不会走。",
    "“它不走的。”守塔人说，“它在那儿好些年了。你父亲也问过同样的话。”",
    "她转过身来。守塔人已经下楼去了，铁梯一级一级地响，响到底，停了。灯又转过一圈，那点光在雾里亮了一下，像是有人在水底下回了一声。",
    "她把窗推开一点，冷风灌进来，信纸在桌上翻了个面。背面的铅笔字露出来，最后一个字她先前没认出，这会儿看清了，是一个“回”字。",
];

pub fn root(this: &mut Spike, window: &mut Window, cx: &mut Context<Spike>) -> impl IntoElement {
    let theme = this.theme();
    let page: AnyElement = match this.page {
        Page::Paper => paper(this, &theme, cx).into_any_element(),
        Page::Shelf => shelf(this, &theme, window, cx).into_any_element(),
        Page::Icons => icons_page(this, &theme, cx).into_any_element(),
        Page::Sea => sea_page(this, &theme, cx).into_any_element(),
        Page::Covers => covers_page(this, &theme).into_any_element(),
    };
    div()
        .size_full()
        .flex()
        .flex_col()
        .bg(theme.paper_deep.solid())
        .font_family(UI_FONT)
        .text_color(theme.ink[1].solid())
        .text_size(px(13.0))
        .child(top_bar(this, &theme, cx))
        .child(div().relative().flex_1().overflow_hidden().child(page))
}

fn seg(
    id: String,
    label: &'static str,
    selected: bool,
    theme: &Theme,
    on: impl Fn(&mut Spike, &mut Context<Spike>) + 'static,
    cx: &mut Context<Spike>,
) -> Stateful<Div> {
    div()
        .id(SharedString::from(id))
        .px(px(9.0))
        .py(px(3.0))
        .text_color(if selected {
            theme.ink[0].solid()
        } else {
            theme.ink[3].solid()
        })
        .font_weight(if selected {
            FontWeight::SEMIBOLD
        } else {
            FontWeight::NORMAL
        })
        .cursor_pointer()
        .on_click(cx.listener(move |this, _, _, cx| {
            on(this, cx);
            cx.notify();
        }))
        .child(label)
}

fn top_bar(this: &Spike, theme: &Theme, cx: &mut Context<Spike>) -> impl IntoElement {
    let mut row = div()
        .h(px(TOP_BAR))
        .flex()
        .flex_row()
        .items_center()
        .pl(px(84.0))
        .gap(px(2.0))
        .border_b(px(0.5))
        .border_color(theme.ink[0].alpha(0.14));
    for page in Page::ALL {
        row = row.child(seg(
            format!("page-{}", page.slug()),
            page.label(),
            this.page == page,
            theme,
            move |this, cx| this.set_page(page, cx),
            cx,
        ));
    }
    row = row.child(div().w(px(28.0)));
    for plan in Plan::ALL {
        row = row.child(seg(
            format!("plan-{}", plan.slug()),
            plan.label(),
            this.plan == plan,
            theme,
            move |this, _| this.plan = plan,
            cx,
        ));
    }
    row = row.child(div().w(px(28.0)));
    for (dark, label) in [(false, "浅"), (true, "深")] {
        row = row.child(seg(
            format!("theme-{dark}"),
            label,
            this.dark == dark,
            theme,
            move |this, _| this.dark = dark,
            cx,
        ));
    }
    row
}

/// A glass control: its rim painted under its content, its states from the hand.
#[derive(Clone, Copy)]
struct Spec {
    id: &'static str,
    kind: Kind,
    color: Rgb,
    origin: (f32, f32),
    rim: f32,
    radius: f32,
    ground: Ground,
    forced: Option<Forced>,
}

impl Spec {
    fn new(id: &'static str, kind: Kind, color: Rgb, radius: f32, ground: Ground) -> Spec {
        Spec {
            id,
            kind,
            color,
            origin: DENSE,
            rim: 9.0,
            radius,
            ground,
            forced: None,
        }
    }

    fn origin(self, origin: (f32, f32)) -> Spec {
        Spec { origin, ..self }
    }

    fn rim(self, rim: f32) -> Spec {
        Spec { rim, ..self }
    }

    fn forced(self, state: Forced) -> Spec {
        Spec {
            forced: Some(state),
            ..self
        }
    }
}

fn glass_el(this: &Spike, spec: Spec, cx: &mut Context<Spike>) -> Stateful<Div> {
    let anim = match spec.forced {
        Some(state) => glass::forced(spec.kind, state, this.demo_flow),
        None => this.anim(spec.id, spec.kind),
    };
    let look = anim.look(spec.color, spec.origin, spec.rim);
    let painter = this.painter();
    let key = control_id(spec.id);
    let (radius, ground) = (spec.radius, spec.ground);
    let layer = canvas(
        |_, _, _| (),
        move |bounds, _, window, cx| painter.paint(key, bounds, radius, &look, &ground, window, cx),
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full();
    let el = div().id(spec.id).relative().child(layer);
    if spec.forced.is_some() {
        return el;
    }
    let (id, kind) = (spec.id, spec.kind);
    el.on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
        this.anim_mut(id, kind).hover = *hovered;
        cx.notify();
    }))
    .on_mouse_down(
        MouseButton::Left,
        cx.listener(move |this, _: &MouseDownEvent, _, cx| {
            this.anim_mut(id, kind).pressed = true;
            cx.notify();
        }),
    )
    .on_mouse_up(
        MouseButton::Left,
        cx.listener(move |this, _: &MouseUpEvent, _, cx| {
            this.anim_mut(id, kind).pressed = false;
            cx.notify();
        }),
    )
    .on_mouse_up_out(
        MouseButton::Left,
        cx.listener(move |this, _: &MouseUpEvent, _, cx| {
            this.anim_mut(id, kind).pressed = false;
            cx.notify();
        }),
    )
}

fn icon(name: &str, size: f32, color: gpui::Hsla) -> impl IntoElement {
    svg()
        .path(icon_embed_path(name))
        .size(px(size))
        .flex_none()
        .text_color(color)
}

fn sand_mark(name: &str, w: f32, h: f32, color: gpui::Hsla) -> impl IntoElement {
    svg()
        .path(sand_embed_path(name))
        .w(px(w))
        .h(px(h))
        .flex_none()
        .text_color(color)
}

fn round_button(
    this: &Spike,
    spec: Spec,
    name: &str,
    ink: gpui::Hsla,
    cx: &mut Context<Spike>,
) -> Stateful<Div> {
    glass_el(this, spec, cx)
        .size(px(28.0))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .child(icon(name, 16.0, ink))
}

fn ground(inside: Rgb, outside: Rgb, theme: &Theme) -> Ground {
    Ground {
        inside,
        outside,
        bleed_lift: theme.bleed_lift,
    }
}

fn floating_fill(this: &Spike, color: Rgb) -> gpui::Hsla {
    color.alpha(this.plan.floating_fill())
}

/// The static rest line of a floating menu or hover card. 乙 here is the
/// renderer's own menu trick: the pre-tinted ring texture under an opaque
/// fill inset 1px; GPUI rounds the image's corners itself.
fn slab_rim(
    this: &mut Spike,
    id: &'static str,
    radius: f32,
    theme: &Theme,
) -> impl IntoElement + use<> {
    let look = Look {
        g: 0.85,
        sp: 0.0,
        ..Look::new(theme.glass_clear, SAMPLE_ORIGINS[0])
    };
    let plan = this.plan;
    let ring = this.ring_image();
    let painter = this.painter();
    let fill = theme.paper_deep;
    let key = control_id(id);
    let g = ground(fill, fill, theme);
    canvas(
        |_, _, _| (),
        move |bounds, _, window, cx| {
            if plan == Plan::Cover {
                let (ox, oy) = SAMPLE_ORIGINS[0];
                let mut ty = oy;
                while ty < f32::from(bounds.size.height) {
                    let mut tx = ox;
                    while tx < f32::from(bounds.size.width) {
                        let tile = gpui::Bounds {
                            origin: bounds.origin + point(px(tx), px(ty)),
                            size: gpui::size(px(glass::TILE), px(glass::TILE)),
                        };
                        let piece = tile.intersect(&bounds);
                        let r = px(radius);
                        let at = |x: bool, y: bool| {
                            let cx_ = if x {
                                piece.left() == bounds.left()
                            } else {
                                piece.right() == bounds.right()
                            };
                            let cy_ = if y {
                                piece.top() == bounds.top()
                            } else {
                                piece.bottom() == bounds.bottom()
                            };
                            if cx_ && cy_ { r } else { px(0.0) }
                        };
                        let corners = Corners {
                            top_left: at(true, true),
                            top_right: at(false, true),
                            bottom_right: at(false, false),
                            bottom_left: at(true, false),
                        };
                        let _ = window.paint_image(piece, tile, corners, ring.clone(), 0, false);
                        tx += glass::TILE;
                    }
                    ty += glass::TILE;
                }
                window.paint_quad(
                    gpui::fill(glass::inset(bounds, 1.0), fill.solid())
                        .corner_radii(px(radius - 1.0)),
                );
            } else {
                window.paint_quad(gpui::fill(bounds, fill.solid()).corner_radii(px(radius)));
                painter.paint(key, bounds, radius, &look, &g, window, cx);
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

fn menu_shadow(theme: &Theme) -> Vec<BoxShadow> {
    vec![BoxShadow {
        color: theme.shadow_ink.alpha(theme.menu_shadow),
        offset: point(px(0.0), px(16.0)),
        blur_radius: px(15.0),
        spread_radius: px(-16.0),
        inset: false,
    }]
}

fn paper(this: &mut Spike, theme: &Theme, cx: &mut Context<Spike>) -> impl IntoElement {
    let page_w = 720.0;
    let page_x = (WINDOW_W - page_w) / 2.0;
    let on_page = ground(theme.page, theme.page, theme);
    let ink3 = theme.ink[2].solid();

    // The paper's toolbar: one long pill of round buttons, floating over the prose.
    let buttons: [(&'static str, &str); 5] = [
        ("bar-bold", "fmt-bold"),
        ("bar-comment", "comment"),
        ("bar-search", "search"),
        ("bar-more", "more"),
        ("bar-split", "split"),
    ];
    let mut pill = glass_el(
        this,
        Spec::new("bar-pill", Kind::Surface, theme.glass_clear, 18.0, on_page)
            .origin(SAMPLE_ORIGINS[0])
            .rim(12.0),
        cx,
    )
    .flex()
    .flex_row()
    .gap(px(2.0))
    .p(px(4.0))
    .rounded(px(18.0))
    .bg(floating_fill(this, theme.page));
    for (id, name) in buttons {
        let mut spec = Spec::new(id, Kind::Hidden, theme.glass_clear, 14.0, on_page);
        let mut b = round_button(this, spec, name, ink3, cx);
        if id == "bar-more" || id == "bar-bold" {
            let open = if id == "bar-more" {
                this.menu_open
            } else {
                this.anim(id, Kind::Hidden).selected
            };
            spec.forced = None;
            let _ = spec;
            b = b.on_click(cx.listener(move |this, _, _, cx| {
                if id == "bar-more" {
                    this.menu_open = !this.menu_open;
                    let open = this.menu_open;
                    this.anim_mut(id, Kind::Hidden).selected = open;
                } else {
                    let a = this.anim_mut(id, Kind::Hidden);
                    a.selected = !a.selected;
                }
                cx.notify();
            }));
            if open && this.anim(id, Kind::Hidden).selected != open {
                this.anim_mut(id, Kind::Hidden).selected = open;
            }
        }
        pill = pill.child(b);
    }
    let pill_w = 5.0 * 28.0 + 4.0 * 2.0 + 8.0;

    // Scrolled a little, so lines of prose pass under the floating toolbar.
    let mut prose = div()
        .absolute()
        .top(px(-34.0))
        .left(px(80.0))
        .w(px(page_w - 160.0))
        .flex()
        .flex_col()
        .gap(px(14.0))
        .font_family(PROSE_FONT)
        .text_color(theme.ink[0].solid())
        .child(
            div()
                .text_size(px(22.0))
                .font_weight(FontWeight::BOLD)
                .line_height(px(40.0))
                .child("第三章　雾港"),
        );
    for paragraph in PROSE {
        prose = prose.child(
            div()
                .text_size(px(17.0))
                .line_height(px(32.0))
                .child(paragraph),
        );
    }

    let menu_rows: [(&str, &str, bool); 5] = [
        ("copy", "复制", false),
        ("arrow-out", "移到另一章", false),
        ("sprout", "新建构想", false),
        ("", "", false),
        ("trash", "删除", true),
    ];
    let mut menu = div()
        .id("menu")
        .absolute()
        .top(px(12.0 + 36.0 + 6.0))
        .left(px((page_w - pill_w) / 2.0 + 4.0 + 3.0 * 30.0 - 6.0))
        .w(px(240.0))
        .py(px(6.0))
        .rounded(px(16.0))
        .shadow(menu_shadow(theme))
        .flex()
        .flex_col()
        .child(slab_rim(this, "menu-rim", 16.0, theme));
    for (i, (name, label, danger)) in menu_rows.into_iter().enumerate() {
        if name.is_empty() {
            menu = menu.child(
                div()
                    .mx(px(12.0))
                    .my(px(5.0))
                    .h(px(0.5))
                    .bg(theme.ink[0].alpha(0.14)),
            );
            continue;
        }
        let ink = if danger {
            theme.destructive.solid()
        } else {
            theme.ink[1].solid()
        };
        menu = menu.child(
            div()
                .id(SharedString::from(format!("menu-row-{i}")))
                .mx(px(6.0))
                .h(px(30.0))
                .px(px(8.0))
                .rounded(px(4.0))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .text_color(ink)
                .hover(|s| s.bg(gpui::black().opacity(0.05)))
                .child(icon(name, 14.0, ink))
                .child(label),
        );
    }

    let card = div()
        .id("hover-card")
        .absolute()
        .top(px(452.0))
        .left(px(330.0))
        .w(px(320.0))
        .rounded(px(16.0))
        .shadow(menu_shadow(theme))
        .flex()
        .flex_col()
        .child(slab_rim(this, "card-rim", 16.0, theme))
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .px(px(14.0))
                .pt(px(12.0))
                .child(sand_mark(
                    "mark-square",
                    14.0,
                    14.0,
                    theme
                        .sand_on(theme.story[0], theme.paper_deep)
                        .alpha(theme.pigment),
                ))
                .child(
                    div()
                        .text_size(px(15.0))
                        .font_weight(FontWeight::MEDIUM)
                        .child("林岚"),
                )
                .child(div().text_color(theme.ink[2].solid()).child("人物")),
        )
        .child(
            div()
                .px(px(14.0))
                .pt(px(6.0))
                .pb(px(10.0))
                .text_color(theme.ink[1].solid())
                .line_height(px(20.0))
                .child("守塔人的女儿，从北边回到旧港。随身带着父亲留下的三封信。"),
        )
        .child(div().mx(px(14.0)).h(px(0.5)).bg(theme.ink[0].alpha(0.14)))
        .child({
            let mut row = div()
                .flex()
                .flex_row()
                .gap(px(4.0))
                .px(px(10.0))
                .py(px(6.0));
            let fill = theme.paper_deep;
            let on_card = ground(fill, fill, theme);
            for (id, name) in [
                ("card-edit", "edit"),
                ("card-locate", "locate"),
                ("card-branch", "branch"),
            ] {
                row = row.child(round_button(
                    this,
                    Spec::new(id, Kind::Hidden, theme.glass_clear, 14.0, on_card),
                    name,
                    theme.ink[2].solid(),
                    cx,
                ));
            }
            row
        });

    let page = div()
        .absolute()
        .top(px(16.0))
        .left(px(page_x))
        .w(px(page_w))
        .h(px(800.0))
        .overflow_hidden()
        .bg(theme.page.solid())
        .rounded(px(2.0))
        .shadow(vec![
            BoxShadow {
                color: theme.shadow_ink.alpha(theme.page_shadow.0),
                offset: point(px(0.0), px(1.0)),
                blur_radius: px(0.0),
                spread_radius: px(0.0),
                inset: false,
            },
            BoxShadow {
                color: theme.shadow_ink.alpha(theme.page_shadow.1),
                offset: point(px(0.0), px(5.0)),
                blur_radius: px(15.0),
                spread_radius: px(-15.0),
                inset: false,
            },
        ])
        .child(prose)
        .child(
            div()
                .absolute()
                .top(px(12.0))
                .left(px((page_w - pill_w) / 2.0))
                .child(pill),
        )
        .child(card)
        .children(this.menu_open.then_some(menu));

    div()
        .size_full()
        .relative()
        .child(page)
        .child(state_strip(this, theme, "l", theme.glass_clear, 56.0, cx))
        .child(state_strip(
            this,
            theme,
            "r",
            theme.story[1],
            WINDOW_W - 56.0 - 120.0,
            cx,
        ))
}

/// The same control held in each state, side by side.
fn state_strip(
    this: &Spike,
    theme: &Theme,
    side: &'static str,
    color: Rgb,
    x: f32,
    cx: &mut Context<Spike>,
) -> impl IntoElement {
    let desk = ground(theme.paper_deep, theme.paper_deep, theme);
    let states = [
        (Forced::Rest, "静止"),
        (Forced::Hover, "悬停"),
        (Forced::Pressed, "按下"),
        (Forced::Selected, "选中"),
    ];
    // Distinct ids per side, state and control, so 甲 keeps one bitmap each.
    const IDS: [[[&str; 3]; 4]; 2] = [
        [
            ["demo-l-round-0", "demo-l-pill-0", "demo-l-rest-0"],
            ["demo-l-round-1", "demo-l-pill-1", "demo-l-rest-1"],
            ["demo-l-round-2", "demo-l-pill-2", "demo-l-rest-2"],
            ["demo-l-round-3", "demo-l-pill-3", "demo-l-rest-3"],
        ],
        [
            ["demo-r-round-0", "demo-r-pill-0", "demo-r-rest-0"],
            ["demo-r-round-1", "demo-r-pill-1", "demo-r-rest-1"],
            ["demo-r-round-2", "demo-r-pill-2", "demo-r-rest-2"],
            ["demo-r-round-3", "demo-r-pill-3", "demo-r-rest-3"],
        ],
    ];
    let mut col = div()
        .absolute()
        .top(px(96.0))
        .left(px(x))
        .w(px(120.0))
        .flex()
        .flex_col()
        .gap(px(22.0));
    for (k, (state, label)) in states.into_iter().enumerate() {
        let id_set = IDS[usize::from(side != "l")][k];
        let round = round_button(
            this,
            Spec::new(id_set[0], Kind::Hidden, color, 14.0, desk).forced(state),
            "comment",
            theme.ink[2].solid(),
            cx,
        );
        let pill = glass_el(
            this,
            Spec::new(id_set[1], Kind::Hidden, color, 14.0, desk).forced(state),
            cx,
        )
        .h(px(28.0))
        .px(px(12.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .child(sand_mark(
            "blob-2",
            9.0,
            9.0,
            theme.sand_on(color, theme.paper_deep).alpha(theme.pigment),
        ))
        .child("第三章");
        let rest = glass_el(
            this,
            Spec::new(id_set[2], Kind::Rest, color, 2.0, desk).forced(state),
            cx,
        )
        .w(px(112.0))
        .h(px(40.0))
        .px(px(10.0))
        .flex()
        .items_center()
        .text_color(theme.ink[2].solid())
        .child("卡片");
        col = col.child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(
                    div()
                        .text_size(px(11.0))
                        .text_color(theme.ink[3].solid())
                        .child(label),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .gap(px(8.0))
                        .items_center()
                        .child(round)
                        .child(pill),
                )
                .child(rest),
        );
    }
    col
}

fn sea_canvas(
    sea: std::rc::Rc<std::cell::RefCell<crate::sea::Sea>>,
    theme: &Theme,
) -> impl IntoElement + use<> {
    let theme = theme.clone();
    canvas(
        |_, _, _| (),
        move |bounds, _, window, _| sea.borrow_mut().paint(bounds, &theme, window),
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

fn cover_images(this: &mut Spike, theme: &Theme) -> Vec<Arc<gpui::RenderImage>> {
    let dark = theme.dark;
    if !this.covers.sand.contains_key(&dark) {
        let images = this
            .covers
            .books
            .iter()
            .zip(&this.covers.sand_masks)
            .map(|(book, masks)| {
                let pixmap = covers::sand_cover_pixmap(
                    book,
                    masks,
                    |c| theme.sand_on(c, theme.paper_deep),
                    theme.pigment,
                );
                glass::render_image(covers::pixmap_to_image(&pixmap))
            })
            .collect();
        this.covers.sand.insert(dark, images);
    }
    this.covers.sand[&dark].clone()
}

fn heat_images(
    this: &mut Spike,
    theme: &Theme,
) -> (Arc<gpui::RenderImage>, Arc<gpui::RenderImage>) {
    let dark = theme.dark;
    let heat = &this.covers.heat;
    this.covers
        .heat_images
        .entry(dark)
        .or_insert_with(|| {
            let ink = theme.sand_on(theme.ink[2], theme.paper_deep);
            (
                glass::render_image(covers::mask_to_image(
                    heat.width,
                    heat.height,
                    &heat.dabs,
                    ink,
                    theme.pigment,
                )),
                glass::render_image(covers::mask_to_image(
                    heat.width,
                    heat.height,
                    &heat.loose,
                    ink,
                    theme.pigment,
                )),
            )
        })
        .clone()
}

fn shelf(
    this: &mut Spike,
    theme: &Theme,
    _window: &mut Window,
    cx: &mut Context<Spike>,
) -> impl IntoElement {
    let desk = ground(theme.paper_deep, theme.paper_deep, theme);
    let sand = cover_images(this, theme);
    let (dabs, loose) = heat_images(this, theme);
    let heat_w = this.covers.heat.width as f32 / 2.0;
    let heat_h = this.covers.heat.height as f32 / 2.0;
    let heat = glass_el(
        this,
        Spec::new("heat", Kind::Still, theme.glass_clear, 3.0, desk).origin(SAMPLE_ORIGINS[0]),
        cx,
    )
    .absolute()
    .top(px(28.0))
    .left(px(48.0))
    .p(px(14.0))
    .child(
        div()
            .relative()
            .w(px(heat_w))
            .h(px(heat_h))
            .child(
                img(loose)
                    .absolute()
                    .size_full()
                    .object_fit(ObjectFit::Fill),
            )
            .child(img(dabs).absolute().size_full().object_fit(ObjectFit::Fill)),
    );
    let ids: [(&'static str, &'static str); 4] = [
        ("card-0", "card-0-turn"),
        ("card-1", "card-1-turn"),
        ("card-2", "card-2-turn"),
        ("card-3", "card-3-turn"),
    ];
    let mut cards = div()
        .absolute()
        .top(px(196.0))
        .left(px(48.0))
        .flex()
        .flex_row()
        .gap(px(28.0));
    for (i, (card_id, turn_id)) in ids.into_iter().enumerate() {
        let cover = if i % 2 == 0 {
            this.covers.topo[i].clone()
        } else {
            sand[i].clone()
        };
        let title = this.covers.books[i].title;
        let turn = round_button(
            this,
            Spec::new(turn_id, Kind::Hidden, theme.glass_clear, 14.0, desk),
            "rotate",
            theme.ink[2].solid(),
            cx,
        );
        cards = cards.child(
            glass_el(
                this,
                Spec::new(card_id, Kind::Rest, theme.glass_clear, 3.0, desk)
                    .origin(if i % 2 == 0 { DENSE } else { SAMPLE_ORIGINS[2] }),
                cx,
            )
            .w(px(146.0))
            .flex()
            .flex_col()
            .p(px(10.0))
            .gap(px(10.0))
            .child(
                img(cover)
                    .w(px(126.0))
                    .h(px(226.0))
                    .rounded(px(2.0))
                    .object_fit(ObjectFit::Fill),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .text_size(px(15.0))
                            .font_family(PROSE_FONT)
                            .text_color(theme.ink[0].solid())
                            .child(title),
                    )
                    .child(turn),
            ),
        );
    }
    let orb = glass_el(
        this,
        Spec::new("new-book", Kind::Rest, theme.glass_clear, 23.0, desk),
        cx,
    )
    .absolute()
    .top(px(196.0 + 120.0))
    .left(px(48.0 + 4.0 * (146.0 + 28.0) + 12.0))
    .size(px(46.0))
    .flex()
    .items_center()
    .justify_center()
    .child(icon("plus", 22.0, theme.ink[2].solid()));
    let avatar = round_button(
        this,
        Spec::new("avatar", Kind::Rest, theme.glass_clear, 14.0, desk),
        "moon-left",
        theme.ink[2].solid(),
        cx,
    )
    .absolute()
    .top(px(28.0))
    .right(px(48.0));
    div()
        .id("shelf")
        .size_full()
        .relative()
        .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| {
            let at = (
                f32::from(event.position.x),
                f32::from(event.position.y) - TOP_BAR,
            );
            let now = std::time::Instant::now();
            if let Some((from, then)) = this.pointer
                && (now - then).as_millis() < 100
            {
                this.shelf_sea
                    .borrow_mut()
                    .wake(from, at, (now - then).as_secs_f32());
                cx.notify();
            }
            this.pointer = Some((at, now));
        }))
        .child(sea_canvas(this.shelf_sea.clone(), theme))
        .child(heat)
        .child(cards)
        .child(orb)
        .child(avatar)
}

fn sea_page(this: &mut Spike, theme: &Theme, cx: &mut Context<Spike>) -> impl IntoElement {
    let desk = ground(theme.paper_deep, theme.paper_deep, theme);
    let loading = this.loading;
    if this.anim("sea-loading", Kind::Rest).selected != loading {
        this.anim_mut("sea-loading", Kind::Rest).selected = loading;
    }
    let toggle = round_button(
        this,
        Spec::new("sea-loading", Kind::Rest, theme.glass_clear, 14.0, desk),
        "loader",
        theme.ink[2].solid(),
        cx,
    )
    .absolute()
    .top(px(16.0))
    .right(px(16.0))
    .on_click(cx.listener(|this, _, _, cx| {
        this.loading = !this.loading;
        let on = this.loading;
        this.sea.borrow_mut().loading(on, cx);
        cx.notify();
    }));
    div()
        .id("sea")
        .size_full()
        .relative()
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|this, event: &MouseDownEvent, _, cx| {
                let x = f32::from(event.position.x);
                let y = f32::from(event.position.y) - TOP_BAR;
                this.sea.borrow_mut().drop_at(x, y, 1.2);
                cx.notify();
            }),
        )
        .child(sea_canvas(this.sea.clone(), theme))
        .child(toggle)
}

const ICON_COLORS: usize = 6;

fn icon_color(theme: &Theme, i: usize) -> Rgb {
    match i {
        0 => theme.ink[2],
        1 => theme.accent,
        2 => theme.story[0],
        3 => theme.story[2],
        4 => theme.destructive,
        _ => theme.story[3],
    }
}

fn icons_page(this: &mut Spike, theme: &Theme, cx: &mut Context<Spike>) -> impl IntoElement {
    let color = icon_color(theme, this.icon_color);
    let size = this.icon_size;
    let mut swatches = div().flex().flex_row().gap(px(10.0)).items_center();
    for i in 0..ICON_COLORS {
        let c = icon_color(theme, i);
        swatches = swatches.child(
            div()
                .id(SharedString::from(format!("swatch-{i}")))
                .size(px(18.0))
                .rounded(px(9.0))
                .bg(c.solid())
                .when(this.icon_color == i, |d| {
                    d.border(px(1.5)).border_color(theme.ink[0].solid())
                })
                .cursor_pointer()
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.icon_color = i;
                    cx.notify();
                })),
        );
    }
    for (s, label) in [(16.0, "16"), (24.0, "24"), (48.0, "48")] {
        swatches = swatches.child(seg(
            format!("icon-size-{label}"),
            label,
            this.icon_size == s,
            theme,
            move |this, _| this.icon_size = s,
            cx,
        ));
    }
    let names = this.assets.icon_names.clone();
    let per_row = if size > 30.0 { 6 } else { 12 };
    let cell = size + 12.0;
    let shown: Vec<String> = if size > 30.0 {
        names.iter().take(36).cloned().collect()
    } else {
        names.clone()
    };
    let mut panels = div().flex().flex_row().gap(px(28.0));
    for (way, label) in [
        (IconWay::Embed, "内嵌位图"),
        (IconWay::Vector, "转矢量"),
        (IconWay::Tint, "预着色"),
    ] {
        let mut grid = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .w(px(cell * per_row as f32));
        for name in &shown {
            let el: AnyElement = match way {
                IconWay::Embed => svg()
                    .path(icon_embed_path(name))
                    .size(px(size))
                    .text_color(color.solid())
                    .into_any_element(),
                IconWay::Vector => svg()
                    .path(icon_vector_path(name))
                    .size(px(size))
                    .text_color(color.solid())
                    .into_any_element(),
                IconWay::Tint => {
                    let image = this
                        .tints
                        .borrow_mut()
                        .get(name, this.assets.icon(name), color);
                    img(image)
                        .size(px(size))
                        .object_fit(ObjectFit::Fill)
                        .into_any_element()
                }
            };
            grid = grid.child(
                div()
                    .size(px(cell))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(el),
            );
        }
        panels = panels.child(
            div()
                .flex()
                .flex_col()
                .gap(px(10.0))
                .child(div().text_color(theme.ink[2].solid()).child(label))
                .child(grid),
        );
    }
    div()
        .size_full()
        .p(px(28.0))
        .flex()
        .flex_col()
        .gap(px(18.0))
        .child(swatches)
        .child(panels)
}

fn covers_page(this: &mut Spike, theme: &Theme) -> impl IntoElement {
    let sand = cover_images(this, theme);
    let (dabs, loose) = heat_images(this, theme);
    let mut row = div().flex().flex_row().gap(px(16.0));
    for (i, book) in this.covers.books.iter().enumerate() {
        row = row.child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(
                    img(this.covers.topo[i].clone())
                        .w(px(126.0))
                        .h(px(226.0))
                        .rounded(px(2.0))
                        .object_fit(ObjectFit::Fill),
                )
                .child(div().font_family(PROSE_FONT).child(book.title)),
        );
    }
    for (i, book) in this.covers.books.iter().enumerate() {
        row = row.child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(
                    img(sand[i].clone())
                        .w(px(126.0))
                        .h(px(226.0))
                        .object_fit(ObjectFit::Fill),
                )
                .child(div().font_family(PROSE_FONT).child(book.title)),
        );
    }
    let heat_w = this.covers.heat.width as f32 / 2.0;
    let heat_h = this.covers.heat.height as f32 / 2.0;
    div()
        .size_full()
        .p(px(40.0))
        .flex()
        .flex_col()
        .gap(px(36.0))
        .child(row)
        .child(
            div()
                .relative()
                .w(px(heat_w))
                .h(px(heat_h))
                .child(
                    img(loose)
                        .absolute()
                        .size_full()
                        .object_fit(ObjectFit::Fill),
                )
                .child(img(dabs).absolute().size_full().object_fit(ObjectFit::Fill)),
        )
}
