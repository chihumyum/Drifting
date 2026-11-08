//! The gallery's six pages.

use gpui::{
    AnyElement, Context, Div, ElementId, InteractiveElement, IntoElement, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, Window, canvas, div,
    prelude::FluentBuilder as _, px,
};

use dr_ui::{
    Theme,
    components::{
        Button, CardAction, CardBody, Chip, Choice, ColorSwatch, Dialog, DockMark, DockTab,
        EmptyState, HoverCard, IconButton, Loading, Menu, MenuItem, MenuWidth, NotificationPill,
        NumberField, PanelIconButton, Pill, PillGroup, Progress, Range, RowIcon, SandCell,
        ScopeToggle, Segmented, Select, Switch, TabDock, overlay,
    },
    fonts::{self, Role, weight},
    glass::{self, Ground, Held, Kind, Mode, Spec, Tone},
    sand::{self, Icon, KindMark, Readout},
    style::DrStyled,
    tokens::{Easing, Rgb, Story, glass as g, motion, radius},
    transitions::{PageTurn, Push},
};

use crate::Gallery;

fn col() -> Div {
    div().flex().flex_col()
}

fn row() -> Div {
    div().flex().flex_row().items_center()
}

/// A tiny faint label (state names, token names).
fn tag(text: impl Into<SharedString>, t: &Theme) -> impl IntoElement {
    div()
        .font_role(Role::Index)
        .type_px(t.scale.caption - 2.0, t.scale.line_caption - 2.0)
        .text_color(t.palette.ink(4).solid())
        .child(text.into())
}

/// A sheet of paper: the page colour, its edge and fall.
fn paper(t: &Theme) -> Div {
    let p = t.palette;
    div()
        .bg(p.page.solid())
        .rounded(px(radius::SM))
        .shadow(vec![
            gpui::BoxShadow {
                color: p.shadow_ink.alpha(p.page_shadow.0),
                offset: gpui::point(px(0.0), px(1.0)),
                blur_radius: px(0.0),
                spread_radius: px(0.0),
                inset: false,
            },
            gpui::BoxShadow {
                color: p.shadow_ink.alpha(p.page_shadow.1),
                offset: gpui::point(px(0.0), px(5.0)),
                blur_radius: px(15.0),
                spread_radius: px(-15.0),
                inset: false,
            },
        ])
}

const PROSE: [&str; 3] = [
    "灯转到第九圈，海面上那点光还在。林岚把信纸叠回信封，又抽出来，借着灯的扫光把背面那行铅笔字看了一遍。",
    "守塔人上楼来添油，看见她坐在窗边，便把油壶放在门口，没有进来。他说码头那边的雾要到后半夜才散。",
    "她把窗推开一点，冷风灌进来，信纸在桌上翻了个面。背面最后一个字她先前没认出，这会儿看清了。",
];

// ── 令牌 ────────────────────────────────────────────────────────────────

pub fn tokens(
    _g: &mut Gallery,
    window: &mut Window,
    cx: &mut Context<Gallery>,
) -> impl IntoElement {
    let t = Theme::of(window, cx);
    let p = t.palette;
    let s = t.scale;
    let swatch = |c: Rgb, name: &'static str| {
        col()
            .gap(px(4.0))
            .child(
                div()
                    .size(px(44.0))
                    .rounded(px(radius::SM))
                    .bg(c.solid())
                    .border(px(0.5))
                    .border_color(p.hairline()),
            )
            .child(tag(name, &t))
    };
    let surfaces = row()
        .gap(px(12.0))
        .child(swatch(p.desk, "desk"))
        .child(swatch(p.paper, "paper"))
        .child(swatch(p.page, "page"))
        .child(swatch(p.glass_clear, "glass"))
        .child(swatch(p.accent, "accent"))
        .child(swatch(p.danger, "danger"))
        .child(swatch(p.comment, "comment"));
    let inks = row().gap(px(12.0)).children((1..=6).map(|n| {
        swatch(
            p.ink(n),
            ["ink-1", "ink-2", "ink-3", "ink-4", "ink-5", "ink-6"][n - 1],
        )
    }));
    let stories = row()
        .gap(px(12.0))
        .children(Story::ALL.iter().enumerate().map(|(i, s)| {
            swatch(
                p.story(*s),
                [
                    "story-1", "story-2", "story-3", "story-4", "story-5", "story-6",
                ][i],
            )
        }));
    let sample = "漂流 Drifting 1942";
    let face = |role: Role, w: gpui::FontWeight, size: f32, name: &'static str| {
        row()
            .gap(px(16.0))
            .child(div().w(px(140.0)).child(tag(name, &t)))
            .child(
                div()
                    .font_role(role)
                    .weight(w)
                    .type_px(size, size * 1.5)
                    .text_color(p.ink(1).solid())
                    .child(sample),
            )
    };
    let faces = col()
        .gap(px(6.0))
        .child(face(Role::Ui, weight::REGULAR, s.body, "sans 400"))
        .child(face(Role::Ui, weight::MEDIUM, s.body, "sans 500"))
        .child(face(Role::Ui, weight::SEMIBOLD, s.body, "sans 600"))
        .child(face(
            Role::Structure,
            weight::REGULAR,
            s.heading + 3.0,
            "serif 400",
        ))
        .child(face(
            Role::Prose,
            weight::BOLD,
            s.heading + 3.0,
            "serif 700",
        ))
        .child(face(Role::Index, weight::REGULAR, s.secondary, "mono 400"));
    let scale = col().gap(px(2.0)).children(
        [
            (s.heading, "heading"),
            (s.emphasis, "emphasis"),
            (s.body, "body"),
            (s.secondary, "secondary"),
            (s.caption, "caption"),
        ]
        .map(|(size, name)| {
            row()
                .gap(px(16.0))
                .child(div().w(px(140.0)).child(tag(format!("{name} {size}"), &t)))
                .child(
                    div()
                        .type_px(size, size * 1.45)
                        .text_color(p.ink(2).solid())
                        .child("守塔人上楼来添油"),
                )
        }),
    );
    let radii = row().gap(px(16.0)).children(
        [
            (radius::XS, "1"),
            (radius::SM, "2"),
            (radius::MD, "3"),
            (radius::MENU_ROW, "4"),
            (radius::SHEET, "16"),
        ]
        .map(|(r, name)| {
            col()
                .gap(px(4.0))
                .child(
                    div()
                        .size(px(44.0))
                        .rounded(px(r))
                        .border(px(1.0))
                        .border_color(p.ink(4).solid()),
                )
                .child(tag(name, &t))
        }),
    );
    let curve = |easing: Option<Easing>, name: &'static str| {
        let color = p.ink(2);
        let axis = p.hairline();
        col()
            .gap(px(4.0))
            .child(
                div().size(px(72.0)).child(
                    canvas(
                        |_, _, _| (),
                        move |bounds, _, window, _| {
                            window.paint_quad(gpui::outline(
                                bounds,
                                axis,
                                gpui::BorderStyle::Solid,
                            ));
                            let w = f32::from(bounds.size.width);
                            let h = f32::from(bounds.size.height);
                            for i in 0..=48 {
                                let x = i as f32 / 48.0;
                                let y = match easing {
                                    Some(e) => e.at(x),
                                    None => motion::spring_progress(
                                        x * motion::SPRING_DURATION.as_secs_f32(),
                                    ),
                                };
                                let at = bounds.origin
                                    + gpui::point(px(x * w - 1.0), px((1.0 - y) * h - 1.0));
                                window.paint_quad(
                                    gpui::fill(
                                        gpui::Bounds::new(at, gpui::size(px(2.0), px(2.0))),
                                        color.solid(),
                                    )
                                    .corner_radii(px(1.0)),
                                );
                            }
                        },
                    )
                    .size_full(),
                ),
            )
            .child(tag(name, &t))
    };
    let curves = row()
        .gap(px(20.0))
        .child(curve(Some(motion::STRUCTURAL.easing), "structural 420"))
        .child(curve(Some(motion::PUSH.easing), "push 265"))
        .child(curve(Some(motion::PAGE_BLEND.easing), "page 180"))
        .child(curve(Some(motion::DOCK_PILL.easing), "dock 340"))
        .child(curve(None, "spring 520"));
    let _ = fonts::SANS;
    div()
        .id("tokens")
        .size_full()
        .overflow_y_scroll()
        .p(px(32.0))
        .flex()
        .flex_row()
        .gap(px(56.0))
        .child(
            col()
                .gap(px(24.0))
                .child(surfaces)
                .child(inks)
                .child(stories)
                .child(radii)
                .child(curves),
        )
        .child(col().gap(px(28.0)).child(faces).child(scale))
}

// ── 控件 ────────────────────────────────────────────────────────────────

/// The editor's four numbers as the settings show them: a slider and the
/// number beside it, then the same pair disabled.
fn numbers(g: &Gallery, t: &Theme, cx: &mut Context<Gallery>) -> impl IntoElement {
    let p = t.palette;
    let specs: [(&str, f64, f64, f64, u32, &str); 4] = [
        ("字号", 12.0, 28.0, 1.0, 0, "px"),
        ("行距", 1.0, 2.0, 0.02, 2, ""),
        ("段间距", 0.0, 2.5, 0.05, 2, "em"),
        ("纸张宽度", 480.0, 1280.0, 10.0, 0, "px"),
    ];
    let e = cx.entity();
    let line = |name: &'static str| {
        row().gap(px(14.0)).child(
            div()
                .w(px(64.0))
                .type_px(t.scale.secondary, t.scale.line_body)
                .text_color(p.ink(2).solid())
                .child(name),
        )
    };
    let mut list = col().gap(px(12.0));
    for (i, (name, min, max, step, decimals, unit)) in specs.iter().copied().enumerate() {
        let value = g.numbers[i];
        let (e1, e2) = (e.clone(), e.clone());
        list = list.child(
            line(name)
                .child(
                    Range::new(
                        ElementId::Name(format!("range-{i}").into()),
                        value,
                        min,
                        max,
                    )
                    .step(step)
                    .label(name)
                    .on_change(move |v, _, cx| {
                        e1.update(cx, |g, cx| {
                            g.numbers[i] = v;
                            cx.notify();
                        })
                    }),
                )
                .child(
                    NumberField::new(
                        ElementId::Name(format!("number-{i}").into()),
                        value,
                        min,
                        max,
                    )
                    .decimals(decimals)
                    .unit(unit)
                    .label(name)
                    .on_change(move |v, _, cx| {
                        e2.update(cx, |g, cx| {
                            g.numbers[i] = v;
                            cx.notify();
                        })
                    }),
                ),
        );
    }
    list.child(
        line("自动保存")
            .child(
                Range::new("range-off", 30.0, 5.0, 120.0)
                    .step(5.0)
                    .disabled(true),
            )
            .child(
                NumberField::new("number-off", 30.0, 5.0, 120.0)
                    .unit("s")
                    .disabled(true),
            ),
    )
}

fn held_strip(t: &Theme, window: &mut Window, cx: &mut Context<Gallery>) -> impl IntoElement {
    let p = t.palette;
    let names = ["静止", "悬停", "按下", "选中"];
    let mut grid = col().gap(px(14.0));
    for (k, held) in Held::ALL.iter().enumerate() {
        let flow = 37.0;
        let mut line = row()
            .gap(px(10.0))
            .child(div().w(px(36.0)).child(tag(names[k], t)));
        for tone in [Tone::Clear, Tone::Story(Story::S2)] {
            let round = glass::GlassState::held(Kind::Hidden, Mode::default(), *held, flow);
            let pill = glass::GlassState::held(Kind::Rest, Mode::default(), *held, flow);
            let card = glass::GlassState::held(Kind::Rest, Mode::default(), *held, flow);
            line = line
                .child(
                    div()
                        .relative()
                        .size(px(g::ROUND))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(glass::held_layer(
                            round,
                            Spec::new(tone, g::ROUND / 2.0),
                            *t,
                        ))
                        .child(sand::icon(Icon::Comment, g::ROUND_ICON, p.ink(3).solid())),
                )
                .child(
                    div()
                        .relative()
                        .h(px(g::PILL_HEIGHT))
                        .px(px(10.0))
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .child(glass::held_layer(
                            pill,
                            Spec::new(tone, g::PILL_HEIGHT / 2.0).origin(glass::SAMPLE_ORIGINS[2]),
                            *t,
                        ))
                        .child(
                            KindMark::new(
                                ElementId::Name(format!("held-mark-{k}-{tone:?}").into()),
                                sand::Kind::Chapter(2),
                            )
                            .color(tone.rgb(p)),
                        )
                        .child("第三章"),
                )
                .child(
                    div()
                        .relative()
                        .w(px(96.0))
                        .h(px(36.0))
                        .px(px(10.0))
                        .flex()
                        .items_center()
                        .text_color(p.ink(3).solid())
                        .child(glass::held_layer(
                            card,
                            Spec::new(tone, radius::SM).origin(glass::SAMPLE_ORIGINS[0]),
                            *t,
                        ))
                        .child("卡片"),
                );
        }
        grid = grid.child(line);
    }
    let _ = (window, cx);
    grid
}

pub fn controls(
    g: &mut Gallery,
    window: &mut Window,
    cx: &mut Context<Gallery>,
) -> impl IntoElement {
    let t = Theme::of(window, cx);
    let p = t.palette;
    let e = cx.entity();
    let buttons = row()
        .gap(px(10.0))
        .child(Button::new("b-primary", "发送").primary().icon(Icon::Lift))
        .child(Button::new("b-secondary", "本会话允许"))
        .child(
            Button::new("b-danger", "移到最近删除")
                .danger()
                .icon(Icon::Trash),
        )
        .child(Button::new("b-text", "查看原始参数").text())
        .child(Button::new("b-busy", "导出").busy(g.loaders))
        .child(Button::new("b-off", "继续").primary().disabled(true));
    let small = row()
        .gap(px(10.0))
        .child(Button::new("b-sm-1", "恢复").small().icon(Icon::Rotate))
        .child(Button::new("b-sm-2", "删除").small().danger());
    let rounds = row()
        .gap(px(10.0))
        .child(IconButton::new("i-plus", Icon::Plus))
        .child(IconButton::new("i-search", Icon::Search))
        .child(IconButton::new("i-lock", Icon::LockShut).selected(true))
        .child(IconButton::new("i-send", Icon::Lift).tone(Tone::Accent))
        .child(IconButton::new("i-off", Icon::Split).disabled(true));
    // The paper's toolbar: a long pill of round buttons floating on the page.
    let tray = glass::glass_box(
        "tray",
        Kind::Surface,
        Mode::default(),
        false,
        Spec::new(Tone::Clear, (g::PILL_HEIGHT + 2.0 * g::TRAY_PADDING) / 2.0)
            .origin(glass::SAMPLE_ORIGINS[0])
            .rim(12.0)
            .filled(p.page),
        window,
        cx,
    )
    .flex()
    .flex_row()
    .gap(px(2.0))
    .p(px(g::TRAY_PADDING))
    .rounded_full()
    .bg(p.page.solid())
    .children(
        [
            Icon::FmtBold,
            Icon::Comment,
            Icon::Search,
            Icon::More,
            Icon::Split,
        ]
        .iter()
        .enumerate()
        .map(|(i, icon)| {
            IconButton::new(ElementId::Name(format!("tray-{i}").into()), *icon)
                .in_tray()
                .selected(i == 0)
        }),
    );
    let sheet = glass::surface(
        Ground::flat(p.page),
        paper(&t)
            .w(px(460.0))
            .p(px(20.0))
            .flex()
            .flex_col()
            .gap(px(14.0))
            .child(
                row()
                    .gap(px(10.0))
                    .child(IconButton::new("i-float", Icon::MoonLeft).floating())
                    .child(tray),
            )
            .child(
                div()
                    .font_role(Role::Prose)
                    .type_px(17.0, 30.0)
                    .text_color(p.ink(1).solid())
                    .child(PROSE[0]),
            ),
    );
    let (s0, s1, scope) = (g.switches[0], g.switches[1], g.scope);
    let (e1, e2, e3) = (e.clone(), e.clone(), e.clone());
    let toggles = row()
        .gap(px(14.0))
        .child(Switch::new("sw-0", s0).on_change(move |on, _, cx| {
            e1.update(cx, |g, cx| {
                g.switches[0] = on;
                cx.notify();
            })
        }))
        .child(Switch::new("sw-1", s1).on_change(move |on, _, cx| {
            e2.update(cx, |g, cx| {
                g.switches[1] = on;
                cx.notify();
            })
        }))
        .child(Switch::new("sw-2", true).disabled(true))
        .child(
            ScopeToggle::new("scope", "当前", scope).on_change(move |on, _, cx| {
                e3.update(cx, |g, cx| {
                    g.scope = on;
                    cx.notify();
                })
            }),
        )
        .child(ScopeToggle::new("scope-off", "当前", false).disabled(true));
    let chip_data = [
        ("人物", Story::S1, 12),
        ("地点", Story::S3, 4),
        ("物件", Story::S4, 0),
        ("时期", Story::S2, 7),
    ];
    let chips = row()
        .gap(px(8.0))
        .children(chip_data.iter().enumerate().map(|(i, (name, story, n))| {
            let e = e.clone();
            Chip::new(
                ElementId::Name(format!("chip-{i}").into()),
                *name,
                g.chips[i],
            )
            .color(p.story(*story))
            .count(*n)
            .on_change(move |on, _, cx| {
                e.update(cx, |g, cx| {
                    g.chips[i] = on;
                    cx.notify();
                })
            })
        }));
    let es = e.clone();
    let segmented =
        Segmented::new("seg", ["全部", "批注", "TODO"], g.segment).on_change(move |i, _, cx| {
            es.update(cx, |g, cx| {
                g.segment = i;
                cx.notify();
            })
        });
    let ep = e.clone();
    let pills = PillGroup::new(
        "pills",
        vec![
            Pill::new("第一章").mark(sand::Kind::Chapter(0), Some(p.story(Story::S1))),
            Pill::new("第二章").mark(sand::Kind::Chapter(3), Some(p.story(Story::S2))),
            Pill::new("林岚").mark(sand::Kind::Element, Some(p.story(Story::S3))),
            Pill::new("北岸").mark(sand::Kind::Storyline, Some(p.story(Story::S4))),
            Pill::new("全书").mark(sand::Kind::All, None),
        ],
        g.pill,
    )
    .on_change(move |i, _, cx| {
        ep.update(cx, |g, cx| {
            g.pill = i;
            cx.notify();
        })
    });
    let ec = e.clone();
    let select = Select::new(
        "select",
        vec![
            Choice::new(
                RowIcon::Mark(sand::Kind::Storyline, Some(p.story(Story::S1))),
                "主线",
            ),
            Choice::new(
                RowIcon::Mark(sand::Kind::Storyline, Some(p.story(Story::S2))),
                "北岸",
            ),
            Choice::new(
                RowIcon::Mark(sand::Kind::Storyline, Some(p.story(Story::S3))),
                "旧码头",
            ),
            Choice::new(
                RowIcon::Mark(sand::Kind::Storyline, Some(p.story(Story::S5))),
                "第七圈",
            ),
            Choice::new(
                RowIcon::Mark(sand::Kind::Storyline, Some(p.story(Story::S6))),
                "雾港",
            ),
        ],
        g.choice,
    )
    .force_open(g.hold_open)
    .on_change(move |i, _, cx| {
        ec.update(cx, |g, cx| {
            g.choice = i;
            cx.notify();
        })
    });
    let fields = col()
        .gap(px(10.0))
        .w(px(320.0))
        .child(g.title.clone())
        .child(g.search.clone())
        .child(g.locked.clone());
    div()
        .size_full()
        .p(px(32.0))
        .flex()
        .flex_row()
        .gap(px(48.0))
        .child(
            col()
                .gap(px(22.0))
                .child(buttons)
                .child(small)
                .child(rounds)
                .child(sheet)
                .child(toggles)
                .child(chips)
                .child(row().gap(px(24.0)).child(segmented).child(pills))
                .child(
                    row()
                        .gap(px(24.0))
                        .items_start()
                        .child(fields)
                        .child(select),
                ),
        )
        .child(
            col()
                .gap(px(44.0))
                .child(held_strip(&t, window, cx))
                .child(numbers(g, &t, cx)),
        )
}

// ── 输入 ────────────────────────────────────────────────────────────────

/// The book card's trash on the inputs page (the capture rests the pointer
/// on it): the card is pinned 32px from the page's bottom left.
#[cfg(feature = "capture")]
pub const INPUTS_TRASH: (f32, f32) = (266.0, crate::WINDOW_H - 32.0 - CARD_H + 26.0);
const CARD_W: f32 = 260.0;
const CARD_H: f32 = 88.0;

pub fn inputs(g: &mut Gallery, window: &mut Window, cx: &mut Context<Gallery>) -> impl IntoElement {
    let t = Theme::of(window, cx);
    let p = t.palette;
    // Project Home's head: the book's title edited where it stands, its
    // introduction under it, both in the page's own type.
    let home = glass::surface(
        Ground::flat(p.page),
        paper(&t)
            .w(px(560.0))
            .px(px(40.0))
            .py(px(36.0))
            .flex()
            .flex_col()
            .gap(px(18.0))
            .child(
                div()
                    .font_role(Role::Prose)
                    .type_px(34.0, 44.0)
                    .text_color(p.ink(1).solid())
                    .child(g.book_title.clone()),
            )
            .child(
                div()
                    .font_role(Role::Prose)
                    .type_px(15.0, 26.0)
                    .text_color(p.ink(2).solid())
                    .child(g.intro.clone()),
            ),
    );
    // A chapter's head: a title that wraps, an empty synopsis, the rule
    // and the first paragraph.
    let chapter = glass::surface(
        Ground::flat(p.page),
        paper(&t)
            .w(px(560.0))
            .px(px(40.0))
            .py(px(36.0))
            .flex()
            .flex_col()
            .child(
                div()
                    .mb(px(10.0))
                    .font_role(Role::Prose)
                    .type_px(42.0, 54.0)
                    .text_color(p.ink(1).solid())
                    .child(g.chapter_title.clone()),
            )
            .child(
                div()
                    .mb(px(28.0))
                    .font_role(Role::Prose)
                    .type_px(15.5, 26.0)
                    .text_color(p.ink(3).solid())
                    .child(g.synopsis.clone()),
            )
            .child(div().mb(px(28.0)).h(px(1.0)).bg(p.rule.solid()))
            .child(
                div()
                    .font_role(Role::Prose)
                    .type_px(17.0, 30.0)
                    .text_color(p.ink(1).solid())
                    .child(PROSE[0]),
            ),
    );
    // A book card's corner: its edit and its trash, which turns the
    // danger's colour under the pointer.
    let card = paper(&t)
        .absolute()
        .left(px(32.0))
        .bottom(px(32.0))
        .w(px(CARD_W))
        .h(px(CARD_H))
        .p(px(14.0))
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(
            row()
                .items_start()
                .justify_between()
                .child(
                    div()
                        .font_role(Role::Prose)
                        .type_px(17.0, 24.0)
                        .text_color(p.ink(1).solid())
                        .child("雾港纪事"),
                )
                .child(
                    row()
                        .child(PanelIconButton::new("card-edit", Icon::Edit))
                        .child(PanelIconButton::new("card-trash", Icon::Trash).danger()),
                ),
        )
        .child(
            div()
                .font_role(Role::Index)
                .type_px(t.scale.caption, t.scale.line_caption)
                .text_color(p.ink(3).solid())
                .child("32,418 字 · 3 天前"),
        );
    div()
        .relative()
        .size_full()
        .p(px(32.0))
        .flex()
        .flex_row()
        .items_start()
        .gap(px(40.0))
        .child(
            col()
                .gap(px(28.0))
                .child(home)
                .child(div().w(px(560.0)).child(g.summary.clone())),
        )
        .child(col().gap(px(28.0)).child(chapter).child(swatches(&t)))
        .child(card)
}

/// Colour swatches: a storyline's dash, a category's corner, a colour with
/// its value written beside it.
fn swatches(t: &Theme) -> impl IntoElement {
    let p = t.palette;
    row()
        .gap(px(20.0))
        .items_center()
        .child(ColorSwatch::new("swatch-storyline", p.story(Story::S2)).mark(sand::Kind::Storyline))
        .child(ColorSwatch::new("swatch-category", p.story(Story::S4)).mark(sand::Kind::Category))
        .child(ColorSwatch::new("swatch-accent", p.accent).show_value())
}

// ── 浮层 ────────────────────────────────────────────────────────────────

fn menu_240(t: &Theme) -> Menu {
    Menu::new("menu-240")
        .item(MenuItem::new("m-copy", Icon::Copy, "复制"))
        .item(MenuItem::new("m-move", Icon::ArrowOut, "移到另一章"))
        .item(MenuItem::new(
            "m-drift",
            RowIcon::Mark(sand::Kind::Drift { loose: false }, None),
            "新建构想",
        ))
        .separator(t)
        .section("写作状态", t)
        .item(MenuItem::new("m-draft", Icon::BrushLifted, "草稿").checked(true))
        .item(MenuItem::new("m-done", Icon::BrushLaid, "完成").current(true))
        .separator(t)
        .item(MenuItem::new("m-trash", Icon::Trash, "删除").danger())
}

fn menu_320(t: &Theme) -> Menu {
    let p = t.palette;
    Menu::new("menu-320")
        .width(MenuWidth::Wide)
        .item(
            MenuItem::new(
                "w-ch",
                RowIcon::Mark(sand::Kind::Chapter(1), Some(p.story(Story::S2))),
                "转换为章节",
            )
            .trailing("⌘⇧C"),
        )
        .item(MenuItem::new(
            "w-el",
            RowIcon::Mark(sand::Kind::Element, Some(p.story(Story::S3))),
            "转换为要素",
        ))
        .item(MenuItem::new(
            "w-cat",
            RowIcon::Mark(sand::Kind::Category, Some(p.story(Story::S5))),
            "更改类目",
        ))
        .item(
            MenuItem::new(
                "w-mat",
                RowIcon::Mark(sand::Kind::Material, None),
                "移到素材夹",
            )
            .trailing("3"),
        )
}

fn card(t: &Theme) -> AnyElement {
    let p = t.palette;
    CardBody::new("card-lin", "林岚")
        .mark(sand::Kind::Element, Some(p.story(Story::S1)))
        .count("2,431")
        .meta(
            row()
                .gap(px(4.0))
                .child(
                    KindMark::new("card-meta-mark", sand::Kind::Storyline)
                        .color(p.story(Story::S2)),
                )
                .child("北岸"),
        )
        .meta(
            row()
                .gap(px(4.0))
                .child(
                    KindMark::new("card-meta-cat", sand::Kind::Category).color(p.story(Story::S1)),
                )
                .child("人物"),
        )
        .summary("守塔人的女儿，从北边回到旧港。随身带着父亲留下的三封信。")
        .section(vec![
            CardAction::new("ca-open", Icon::ArrowOut, "打开").into_any_element(),
            CardAction::new("ca-locate", Icon::Locate, "在全书里定位").into_any_element(),
            CardAction::new("ca-group", Icon::Folder, "更改分组").into_any_element(),
        ])
        .section(vec![
            CardAction::new("ca-del", Icon::Trash, "删除")
                .danger()
                .into_any_element(),
        ])
        .into_any_element()
}

pub fn floating(
    g: &mut Gallery,
    window: &mut Window,
    cx: &mut Context<Gallery>,
) -> impl IntoElement {
    let t = Theme::of(window, cx);
    let p = t.palette;
    let e = cx.entity();
    let hold = g.hold_open;
    let cell = |id: &'static str, name: &'static str, kind: sand::Kind, color: Rgb| {
        row()
            .id(id)
            .h(px(t.scale.row_height))
            .px(px(10.0))
            .gap(px(8.0))
            .child(KindMark::new(ElementId::Name(format!("{id}-mark").into()), kind).color(color))
            .child(name)
    };
    let hover_target = HoverCard::new(
        "hover-lin",
        cell("cell-lin", "林岚", sand::Kind::Element, p.story(Story::S1)),
        |window, cx| card(&Theme::of(window, cx)),
    )
    .force_open(hold);
    let more_bounds = overlay::use_bounds("more-bounds", window, cx);
    let em = e.clone();
    let more = div()
        .relative()
        .child(overlay::probe(more_bounds.clone()))
        .child(
            IconButton::new("i-more", Icon::More)
                .selected(g.menu_open)
                .on_click(move |_, _, cx| {
                    em.update(cx, |g, cx| {
                        g.menu_open = !g.menu_open;
                        cx.notify();
                    })
                }),
        );
    let floated = (g.menu_open)
        .then(|| *more_bounds.read(cx))
        .flatten()
        .map(|b| {
            let ed = e.clone();
            overlay::float(
                overlay::Place::below(b, 6.0),
                overlay::Layer::Popover,
                div()
                    .on_mouse_down_out(move |_, _, cx| {
                        ed.update(cx, |g, cx| {
                            g.menu_open = false;
                            cx.notify();
                        })
                    })
                    .child(menu_240(&t)),
            )
        });
    let ed = e.clone();
    let open_dialog = Button::new("open-dialog", "删除这本书…")
        .danger()
        .icon(Icon::Trash)
        .on_click(move |_, _, cx| {
            ed.update(cx, |g, cx| {
                g.dialog_open = true;
                cx.notify();
            })
        });
    let en = e.clone();
    let notice_toggle = Button::new("toggle-notice", "通知").on_click(move |_, _, cx| {
        en.update(cx, |g, cx| {
            g.notice = !g.notice;
            cx.notify();
        })
    });
    let dialog = g.dialog_open.then(|| {
        let close = e.clone();
        let cancel = e.clone();
        let confirm = e.clone();
        Dialog::new("dialog", "永久删除《雾港》？")
            .eyebrow("最近删除")
            .subtitle("书里的 24 章、61 个要素和全部快照会一起删除。")
            .body(
                row()
                    .gap(px(10.0))
                    .child(Switch::new("dlg-switch", true))
                    .child("同时删除导出的 Markdown 文件夹"),
            )
            .status(Progress::new(Some(0.4)))
            .action(Button::new("dlg-cancel", "取消").on_click(move |_, _, cx| {
                cancel.update(cx, |g, cx| {
                    g.dialog_open = false;
                    cx.notify();
                })
            }))
            .action(
                Button::new("dlg-ok", "永久删除")
                    .danger()
                    .icon(Icon::Trash)
                    .on_click(move |_, _, cx| {
                        confirm.update(cx, |g, cx| {
                            g.dialog_open = false;
                            cx.notify();
                        })
                    }),
            )
            .on_close(move |_, cx| {
                close.update(cx, |g, cx| {
                    g.dialog_open = false;
                    cx.notify();
                })
            })
    });
    div()
        .size_full()
        .p(px(32.0))
        .flex()
        .flex_row()
        .gap(px(40.0))
        .child(col().gap(px(24.0)).child(menu_240(&t)).child(menu_320(&t)))
        .child(
            col()
                .gap(px(18.0))
                .w(px(300.0))
                .child(
                    row()
                        .gap(px(10.0))
                        .child(more)
                        .child(open_dialog)
                        .child(notice_toggle),
                )
                .child(hover_target)
                .child(div().h(px(260.0)).when(!hold, |el| el.child(card(&t)))),
        )
        .child(
            col()
                .gap(px(28.0))
                .w(px(320.0))
                .child(
                    EmptyState::new("empty-el", "还没有要素")
                        .mark(sand::Kind::Element)
                        .action(Button::new("empty-new", "新建要素")),
                )
                .child(
                    EmptyState::new("empty-view", "这里还空着")
                        .icon(Icon::Furin)
                        .hint("新建章节", "⌘N")
                        .hint("全局搜索", "⌘K")
                        .hint("时间线", "⌘⇧T"),
                )
                .when(g.loaders, |el| {
                    el.child(
                        row()
                            .gap(px(28.0))
                            .child(Loading::new("load-block").label("载入中").immediate())
                            .child(
                                Loading::new("load-inline")
                                    .inline()
                                    .label("同步")
                                    .immediate(),
                            ),
                    )
                })
                .child(
                    col()
                        .gap(px(14.0))
                        .child(Progress::new(Some(0.62)))
                        .when(g.loaders, |el| el.child(Progress::new(None))),
                )
                .child(
                    col()
                        .gap(px(10.0))
                        .child(
                            NotificationPill::new("notice", "已导出到「雾港.driftingbook」")
                                .icon(Icon::StatusDone)
                                .shown(g.notice),
                        )
                        .child(
                            NotificationPill::new("notice-2", "同步失败，稍后重试")
                                .icon(Icon::StatusWarning)
                                .danger()
                                .action(Button::new("notice-retry", "重试")),
                        ),
                ),
        )
        .children(floated)
        .children(dialog)
}

// ── 砂笔 ────────────────────────────────────────────────────────────────

pub fn sand(g: &mut Gallery, window: &mut Window, cx: &mut Context<Gallery>) -> impl IntoElement {
    let t = Theme::of(window, cx);
    let p = t.palette;
    let e = cx.entity();
    let icons = div()
        .w(px(560.0))
        .flex()
        .flex_row()
        .flex_wrap()
        .gap(px(10.0))
        .children(
            Icon::ALL
                .iter()
                .filter(|i| **i != Icon::Thinking)
                .map(|icon| {
                    div()
                        .size(px(24.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(sand::icon(*icon, 16.0, p.ink(2).solid()))
                }),
        );
    let kinds = [
        sand::Kind::Chapter(0),
        sand::Kind::Chapter(1),
        sand::Kind::Chapter(2),
        sand::Kind::Chapter(3),
        sand::Kind::Chapter(4),
        sand::Kind::Chapter(5),
        sand::Kind::Element,
        sand::Kind::Storyline,
        sand::Kind::Category,
        sand::Kind::Drift { loose: false },
        sand::Kind::Drift { loose: true },
        sand::Kind::DriftGroup,
        sand::Kind::Material,
        sand::Kind::All,
    ];
    let marks = |hollow: bool, scale: f32| {
        row()
            .gap(px(12.0))
            .children(kinds.iter().enumerate().map(move |(i, k)| {
                let color = p.story(Story::ALL[i % 6]);
                KindMark::new(
                    ElementId::Name(format!("k-{hollow}-{scale}-{i}").into()),
                    *k,
                )
                .color(color)
                .hollow(hollow)
                .scale(scale)
            }))
    };
    let names = [
        ("第一章　灯塔", sand::Kind::Chapter(0), Story::S1),
        ("第二章　北岸", sand::Kind::Chapter(1), Story::S2),
        ("林岚", sand::Kind::Element, Story::S3),
        ("守塔人", sand::Kind::Element, Story::S4),
    ];
    let cells = col()
        .w(px(260.0))
        .gap(px(6.0))
        .children(names.iter().enumerate().map(|(i, (name, kind, story))| {
            let e = e.clone();
            let place = matches!(kind, sand::Kind::Chapter(_));
            SandCell::new(ElementId::Name(format!("cell-{i}").into()), *name)
                .mark(*kind)
                .color(p.story(*story))
                .font(if place { Role::Structure } else { Role::Ui })
                .selected(g.cell == i)
                .on_click(move |_, _, cx| {
                    e.update(cx, |g, cx| {
                        g.cell = i;
                        cx.notify();
                    })
                })
        }))
        // A lane that opens nothing: no ring.
        .child(
            SandCell::new("cell-loose", "未归属")
                .mark(sand::Kind::Storyline)
                .hollow(true)
                .disabled(true),
        );
    let labels = ["本周", "本月", "全书", "待写"];
    let er = e.clone();
    let readouts = col()
        .w(px(300.0))
        .gap(px(10.0))
        .children(labels.iter().enumerate().map(|(i, label)| {
            row()
                .gap(px(12.0))
                .child(
                    div()
                        .w(px(40.0))
                        .font_role(Role::Index)
                        .text_color(p.ink(3).solid())
                        .child(*label),
                )
                .child(
                    div().flex_1().child(
                        Readout::new(ElementId::Name(format!("ro-{i}").into()), g.readouts[i])
                            .color(p.story(Story::ALL[i])),
                    ),
                )
        }))
        .child(
            Button::new("ro-shuffle", "换一组")
                .small()
                .on_click(move |_, _, cx| {
                    er.update(cx, |g, cx| {
                        g.readouts.rotate_left(1);
                        cx.notify();
                    })
                }),
        );
    let thinking = row()
        .gap(px(14.0))
        .child(sand::thinking(16.0, p.ink(2).solid(), g.thinking, window))
        .child(sand::thinking(16.0, p.ink(2).solid(), false, window));
    div()
        .size_full()
        .p(px(32.0))
        .flex()
        .flex_row()
        .gap(px(48.0))
        .child(
            col()
                .gap(px(24.0))
                .child(icons)
                .child(marks(false, 1.0))
                .child(marks(true, 1.0))
                .child(marks(false, 2.0)),
        )
        .child(
            col()
                .gap(px(28.0))
                .child(cells)
                .child(readouts)
                .child(thinking),
        )
}

// ── 过渡 ────────────────────────────────────────────────────────────────

pub fn motion(g: &mut Gallery, window: &mut Window, cx: &mut Context<Gallery>) -> impl IntoElement {
    let t = Theme::of(window, cx);
    let p = t.palette;
    let e = cx.entity();
    let sheets: [(&str, &str); 3] = [
        ("第三章　雾港", PROSE[0]),
        ("第四章　信", PROSE[1]),
        ("第五章　回", PROSE[2]),
    ];
    let es = e.clone();
    let turn = col()
        .gap(px(12.0))
        .child(row().gap(px(10.0)).children((0..3).map(|i| {
            let es = es.clone();
            Pill::new(sheets[i].0);
            IconButton::new(
                ElementId::Name(format!("sheet-{i}").into()),
                [Icon::FileText, Icon::Comment, Icon::OpenBook][i],
            )
            .selected(g.sheet == i)
            .on_click(move |_, _, cx| {
                es.update(cx, |g, cx| {
                    g.sheet = i;
                    cx.notify();
                })
            })
        })))
        .child(div().w(px(520.0)).h(px(300.0)).child(PageTurn::new(
            "turn",
            sheets[g.sheet].0,
            move |key, window, cx| {
                let t = Theme::of(window, cx);
                let p = t.palette;
                let (title, body) = sheets
                    .iter()
                    .find(|(title, _)| *title == key.as_ref())
                    .copied()
                    .unwrap_or(sheets[0]);
                paper(&t)
                    .size_full()
                    .p(px(36.0))
                    .flex()
                    .flex_col()
                    .gap(px(14.0))
                    .font_role(Role::Prose)
                    .text_color(p.ink(1).solid())
                    .child(div().type_px(22.0, 36.0).weight(weight::BOLD).child(title))
                    .child(div().type_px(17.0, 30.0).child(body))
                    .into_any_element()
            },
        )));
    let panels = ["章节", "要素", "构想"];
    let ep = e.clone();
    let panel_open = g.panel_open;
    let push = col()
        .gap(px(12.0))
        .child(
            // A sidebar half's Panel Tabs: the block rides the panel's push
            // and a click on the open tab closes the half.
            Segmented::new("push-tabs", panels, g.panel)
                .font(Role::Structure)
                .text_size(t.scale.label)
                .motion(motion::PUSH)
                .report_selected()
                .on_change(move |i, _, cx| {
                    ep.update(cx, |g, cx| {
                        if i == g.panel {
                            g.panel_open = !g.panel_open;
                        } else {
                            g.panel = i;
                            g.panel_open = true;
                        }
                        cx.notify();
                    })
                }),
        )
        .child(
            div()
                .w(px(260.0))
                .h(px(300.0))
                .border_l(px(0.5))
                .border_r(px(0.5))
                .border_color(p.hairline())
                .when(panel_open, |el| {
                    el.child(Push::new(
                        "push",
                        panels[g.panel],
                        g.panel,
                        move |key, window, cx| {
                            let t = Theme::of(window, cx);
                            let p = t.palette;
                            let rows: Vec<(&str, sand::Kind)> = match key.as_ref() {
                                "章节" => vec![
                                    ("第一章　灯塔", sand::Kind::Chapter(0)),
                                    ("第二章　北岸", sand::Kind::Chapter(1)),
                                    ("第三章　雾港", sand::Kind::Chapter(2)),
                                ],
                                "要素" => vec![
                                    ("林岚", sand::Kind::Element),
                                    ("守塔人", sand::Kind::Element),
                                    ("旧港", sand::Kind::Element),
                                ],
                                _ => vec![
                                    ("雾里的回声", sand::Kind::Drift { loose: false }),
                                    ("第三封信", sand::Kind::Drift { loose: true }),
                                ],
                            };
                            div()
                                .size_full()
                                .bg(p.desk.solid())
                                .py(px(8.0))
                                .flex()
                                .flex_col()
                                .children(rows.into_iter().enumerate().map(|(i, (name, kind))| {
                                    row()
                                        .h(px(t.scale.row_height))
                                        .px(px(12.0))
                                        .gap(px(8.0))
                                        .child(
                                            KindMark::new(
                                                ElementId::Name(format!("push-{}-{i}", key).into()),
                                                kind,
                                            )
                                            .color(p.story(Story::ALL[i])),
                                        )
                                        .child(name)
                                }))
                                .into_any_element()
                        },
                    ))
                }),
        );
    let ew = e.clone();
    // The selected pill is a chapter; dragging reorders the row and the
    // selection stays with its chapter.
    let order = g.wave_order.clone();
    let chosen = g.pill.min(5);
    let selected = order.iter().position(|c| *c == chosen).unwrap_or(0);
    let pick = order.clone();
    let ed = e.clone();
    let wave = PillGroup::new(
        "wave",
        order
            .iter()
            .map(|&c| {
                Pill::new(format!("第{}章", ["一", "二", "三", "四", "五", "六"][c]))
                    .mark(sand::Kind::Chapter(c as u8), Some(p.story(Story::ALL[c])))
                    .preview(c == 5)
            })
            .collect(),
        selected,
    )
    .on_change(move |i, _, cx| {
        let c = pick[i];
        ew.update(cx, |g, cx| {
            g.pill = c;
            cx.notify();
        })
    })
    .draggable(WaveDrag, move |drag: &WaveDrag, to, _, cx| {
        ed.update(cx, |g, cx| {
            let c = g.wave_order.remove(drag.0);
            g.wave_order.insert(to, c);
            cx.notify();
        })
    });
    div()
        .size_full()
        .p(px(32.0))
        .flex()
        .flex_col()
        .gap(px(28.0))
        .child(wave)
        .child(row().gap(px(48.0)).items_start().child(turn).child(push))
        .child(
            row()
                .w(px(720.0))
                .justify_center()
                .child(dock(g, window, cx)),
        )
}

/// A wave pill in the hand: where it was picked up.
struct WaveDrag(usize);

/// A dock pill in the hand.
struct DockDrag(usize);

/// The tab dock: chapters, an element, a split of two elements and a
/// drift (a preview), marks at rest and pills under the hand.
fn dock(g: &Gallery, window: &mut Window, cx: &mut Context<Gallery>) -> impl IntoElement {
    let t = Theme::of(window, cx);
    let p = t.palette;
    let story = |i: usize| Some(p.story(Story::ALL[i]));
    let tab = |i: usize| -> DockTab {
        match i {
            0 => DockTab::new(Pill::new("第三章　雾港").mark(sand::Kind::Chapter(2), story(2))),
            1 => DockTab::new(Pill::new("第四章　信").mark(sand::Kind::Chapter(3), story(3))),
            2 => DockTab::new(Pill::new("林岚").mark(sand::Kind::Element, story(0))),
            3 => {
                let halves = [("守塔人", story(1)), ("旧港", story(4))];
                DockTab::new(
                    Pill::new("守塔人　旧港")
                        .key("split")
                        .mark(sand::Kind::Element, story(1))
                        .content(move |window, cx| {
                            let p = Theme::of(window, cx).palette;
                            let mut both = row().gap(px(8.0));
                            for (n, (name, color)) in halves.into_iter().enumerate() {
                                if n > 0 {
                                    both = both.child(
                                        div().w(px(1.0)).h(px(12.0)).bg(p.rule_strong.solid()),
                                    );
                                }
                                let mark = KindMark::new(
                                    ElementId::Name(format!("dock-split-{n}").into()),
                                    sand::Kind::Element,
                                );
                                let mark = match color {
                                    Some(c) => mark.color(c),
                                    None => mark,
                                };
                                both = both.child(row().gap(px(6.0)).child(mark).child(name));
                            }
                            both.into_any_element()
                        }),
                )
                .marks(
                    halves.map(|(_, color)| DockMark::new(sand::Kind::Element, color)),
                    0,
                )
            }
            _ => DockTab::new(
                Pill::new("雾里的回声")
                    .mark(sand::Kind::Drift { loose: false }, None)
                    .preview(true),
            ),
        }
    };
    let order = g.dock_order.clone();
    let active = order.iter().position(|&i| i == g.dock_active);
    let (pick, ed, el) = (order.clone(), cx.entity(), cx.entity());
    let ec = cx.entity();
    let locked = g.dock_locked;
    TabDock::new("dock", order.iter().map(|&i| tab(i)).collect(), active)
        .locked(locked)
        .leading(move |_, _| {
            let el = el.clone();
            IconButton::new(
                "dock-lock",
                if locked {
                    Icon::LockShut
                } else {
                    Icon::LockOpen
                },
            )
            .label(if locked {
                "收回小点"
            } else {
                "保持展开"
            })
            .selected(locked)
            .on_click(move |_, _, cx| {
                el.update(cx, |g, cx| {
                    g.dock_locked = !g.dock_locked;
                    cx.notify();
                })
            })
            .into_any_element()
        })
        .trailing(|_, _| {
            IconButton::new("dock-new", Icon::Plus)
                .label("新建")
                .into_any_element()
        })
        .on_change(move |i, _, cx| {
            let tab = pick[i];
            ec.update(cx, |g, cx| {
                g.dock_active = tab;
                cx.notify();
            })
        })
        .draggable(DockDrag, move |drag: &DockDrag, to, _, cx| {
            ed.update(cx, |g, cx| {
                let tab = g.dock_order.remove(drag.0);
                g.dock_order.insert(to, tab);
                cx.notify();
            })
        })
}

#[allow(dead_code)]
fn _unused(_: Div, _: Easing, _: Rgb) {}
