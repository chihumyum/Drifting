//! The workspace tour (M24) drawn offscreen: screenshots into `<dir>/m24/`,
//! the first step and the timeline's, light and dark.
//!
//! GPUI runs headless (its test platform with the real macOS text system
//! and Metal drawing into a texture): nothing opens on screen. The
//! workspace is a mock built from dr-ui's parts: the left sidebar with its
//! Panel Tabs, a chapter list and the account cell; Project Home on the
//! paper with its 新建 section and the timeline's toggle; the right
//! sidebar's tabs. Its words are the interface's own strings and a made-up
//! book; every control the tour points at is an anchor.
//!
//! ```text
//! cargo run -p dr-view-sea --features capture --example tour-capture -- ../docs/rust-rewrite/modules
//! ```

use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::Result;
use dr_i18n::keys;
use dr_shell::{Services, SettingsFile, ShellInfo, t};
use dr_ui::{
    Appearance, Theme, anim,
    components::{Button, IconButton, SandCell},
    fonts::{Role, weight},
    glass::{self, Ground},
    sand::{Icon, Kind},
    style::DrStyled as _,
    theme,
    tokens::{space, surface},
};
use dr_view_sea::tour::{self, anchor, ids};
use gpui::{
    AnyElement, AnyWindowHandle, AppContext as _, Context, HeadlessAppContext, IntoElement,
    ParentElement as _, Render, SharedString, Styled as _, Window, div, px, size,
};

const W: f32 = 1280.0;
const H: f32 = 800.0;
const LEFT: f32 = 248.0;
const RIGHT: f32 = 264.0;
/// The title bar's strip over the sidebars (the traffic lights' row).
const TITLE_BAR: f32 = 38.0;
const VERSION: &str = "0.2.0-dev";

/// A made-up book.
const BOOK: &str = "雾港";
const CHAPTERS: [&str; 6] = ["雾里的码头", "灯塔", "旧港来信", "潮汐表", "钟声", "回航"];

struct Desk;

impl Render for Desk {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let tab = |label: SharedString, current: bool| {
            div()
                .font_role(Role::Structure)
                .type_px(s.label, s.line_body)
                .text_color(if current { p.ink(1) } else { p.ink(3) }.solid())
                .child(label)
        };
        let tab_row = |tabs: Vec<AnyElement>| {
            div()
                .h(px(32.0))
                .px(px(space::S6))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(space::S7))
                .children(tabs)
        };
        let left = div()
            .absolute()
            .left_0()
            .top_0()
            .w(px(LEFT))
            .h_full()
            .flex()
            .flex_col()
            .child(div().h(px(TITLE_BAR)))
            .child(tab_row(vec![
                anchor(
                    ids::LEFT_PANEL_TAB,
                    tab(t(cx, keys::left_sidebar::tabs::CHAPTERS), true),
                )
                .into_any_element(),
                anchor(
                    ids::LEFT_PANEL_TAB,
                    tab(t(cx, keys::left_sidebar::tabs::ELEMENTS), false),
                )
                .into_any_element(),
                anchor(
                    ids::LEFT_PANEL_TAB,
                    tab(t(cx, keys::left_sidebar::tabs::DRIFTS), false),
                )
                .into_any_element(),
            ]))
            .child(
                div()
                    .h(px(36.0))
                    .px(px(space::S5))
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .font_role(Role::Index)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.ink(3).solid())
                            .child("6 · 41,280"),
                    )
                    .child(anchor(
                        ids::SUPER_VIEW_ENTRY,
                        IconButton::new("whole-book", Icon::OpenBook),
                    )),
            )
            .child(div().px(px(space::S3)).flex().flex_col().children(
                CHAPTERS.iter().enumerate().map(|(i, name)| {
                    SandCell::new(SharedString::from(format!("chapter-{i}")), *name)
                        .mark(Kind::Chapter(i as u8))
                        .selected(i == 0)
                }),
            ))
            .child(div().flex_1())
            .child(
                div()
                    .flex_none()
                    .h(px(s.row_height + 14.0))
                    .px(px(space::S5))
                    .border_t(px(surface::HAIRLINE))
                    .border_color(p.subtle_hairline())
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(space::S1))
                    .child(div().flex_1())
                    .child(anchor(
                        ids::PROJECT_HOME,
                        IconButton::new("home", Icon::Torii),
                    ))
                    .child(anchor(
                        ids::NOTIFICATIONS,
                        IconButton::new("bell", Icon::Furin),
                    )),
            );
        let create = div()
            .flex()
            .flex_col()
            .gap(px(space::S4))
            .child(
                div()
                    .font_role(Role::Structure)
                    .type_px(s.heading, s.line_body)
                    .text_color(p.ink(2).solid())
                    .child(t(cx, keys::guide::workspace::create::TITLE)),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .gap(px(space::S3))
                    .children(
                        [
                            keys::left_sidebar::tabs::CHAPTERS,
                            keys::left_sidebar::tabs::DRIFTS,
                            keys::left_sidebar::tabs::ELEMENTS,
                        ]
                        .into_iter()
                        .enumerate()
                        .map(|(i, key)| {
                            Button::new(SharedString::from(format!("new-{i}")), t(cx, key))
                                .icon(Icon::Plus)
                        }),
                    ),
            );
        let paper = glass::surface(
            Ground::flat(p.page),
            div()
                .absolute()
                .left(px(LEFT))
                .top(px(TITLE_BAR))
                .w(px(W - LEFT - RIGHT))
                .h(px(H - TITLE_BAR - space::S3))
                .bg(p.page.solid())
                .rounded(px(surface::PAGE_RADIUS))
                .border(px(surface::HAIRLINE))
                .border_color(p.hairline())
                .child(
                    div()
                        .absolute()
                        .left(px(64.0))
                        .right(px(64.0))
                        .top(px(72.0))
                        .flex()
                        .flex_col()
                        .gap(px(space::S9))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(space::S2))
                                .child(
                                    div()
                                        .font_role(Role::Prose)
                                        .type_px(34.0, 44.0)
                                        .weight(weight::REGULAR)
                                        .text_color(p.ink(1).solid())
                                        .child(BOOK),
                                )
                                .child(
                                    div()
                                        .font_role(Role::Index)
                                        .type_px(s.caption, s.line_caption)
                                        .text_color(p.ink(3).solid())
                                        .child("6 · 41,280"),
                                ),
                        )
                        .child(anchor(ids::HOME_CREATE, create)),
                )
                .child(anchor(
                    ids::TIMELINE_TOGGLE,
                    div()
                        .absolute()
                        .right(px(space::S6))
                        .bottom(px(space::S6))
                        .child(IconButton::new("timeline", Icon::LanesStagger).floating()),
                )),
        );
        let right = div()
            .absolute()
            .right_0()
            .top_0()
            .w(px(RIGHT))
            .h_full()
            .flex()
            .flex_col()
            .child(div().h(px(TITLE_BAR)))
            .child(tab_row(vec![
                tab(t(cx, keys::right_sidebar::tabs::REVIEW), false).into_any_element(),
                tab(t(cx, keys::right_sidebar::tabs::LIBRARY), false).into_any_element(),
                tab(t(cx, keys::right_sidebar::tabs::STATS), false).into_any_element(),
                anchor(
                    ids::AGENT_TAB,
                    tab(t(cx, keys::right_sidebar::tabs::COMPANION), true),
                )
                .into_any_element(),
            ]));
        glass::surface(
            Ground::flat(p.desk),
            div()
                .relative()
                .size_full()
                .bg(p.desk.solid())
                .font_role(Role::Ui)
                .type_px(s.body, s.line_body)
                .text_color(p.ink(1).solid())
                .child(left)
                .child(paper)
                .child(right)
                .children(tour::layer(false, window, cx)),
        )
    }
}

struct Capture {
    cx: HeadlessAppContext,
    window: AnyWindowHandle,
    view: gpui::Entity<Desk>,
}

impl Capture {
    fn draw(&mut self) -> Result<()> {
        let view = self.view.clone();
        self.cx.update_window(self.window, |_, window, cx| {
            window.simulate_next_frame(cx);
            view.update(cx, |_, cx| cx.notify());
            window.draw(cx).clear(cx);
        })?;
        self.cx.run_until_parked();
        Ok(())
    }

    fn settle(&mut self) -> Result<()> {
        for _ in 0..4 {
            self.draw()?;
        }
        Ok(())
    }

    fn step(&mut self) -> Option<usize> {
        self.cx
            .update_window(self.window, |_, window, cx| {
                tour::current(window, cx).map(|s| s.step)
            })
            .ok()
            .flatten()
    }

    fn press(&mut self, action: impl gpui::Action) -> Result<()> {
        self.cx.update_window(self.window, |_, window, cx| {
            window.dispatch_action(Box::new(action), cx)
        })?;
        self.settle()
    }
}

fn main() -> Result<()> {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .unwrap_or_else(|| "../docs/rust-rewrite/modules".into()),
    );
    let dir = root.join("m24");
    std::fs::create_dir_all(&dir)?;
    let text_system = gpui_platform::current_platform(true).text_system();
    let mut cx = HeadlessAppContext::with_platform(
        text_system,
        Arc::new(dr_ui::Assets::new()),
        gpui_platform::current_headless_renderer,
    );
    cx.allow_parking();
    cx.update(|cx| -> Result<()> {
        dr_ui::init(cx)?;
        let info = ShellInfo {
            app_name: "Drifting Next",
            bundle_id: "cc.drifting.next.dev",
            version: VERSION,
            url_scheme: "drifting-next-dev",
            forced_appearance: Some(Appearance::Light),
        };
        let mut file = SettingsFile::in_memory();
        file.set(
            dr_shell::settings::registry::UI_LOCALE,
            "zh-CN".into(),
            None,
        )
        .ok();
        dr_shell::init(info, Services::default(), file, cx);
        tour::init(cx);
        Ok(())
    })?;
    let window = cx.open_window(size(px(W), px(H)), |_, cx| cx.new(|_| Desk))?;
    let view = window.entity(&cx)?;
    let mut c = Capture {
        cx,
        window: window.into(),
        view,
    };
    c.settle()?;
    // The book has just opened: the tour comes up after its delay.
    c.cx.update_window(c.window, |_, window, cx| tour::maybe_start(window, cx))?;
    c.draw()?;
    c.cx.advance_clock(tour::START_DELAY);
    c.settle()?;
    anyhow::ensure!(c.step() == Some(0), "the tour did not come up");
    for appearance in [Appearance::Light, Appearance::Dark] {
        c.cx.update(|cx| theme::force_appearance(Some(appearance), cx));
        for (name, step) in [("panels", 0), ("timeline", 3)] {
            for _ in 0..8 {
                let Some(at) = c.step().filter(|at| *at != step) else {
                    break;
                };
                if at < step {
                    c.press(tour::Next)?;
                } else {
                    c.press(tour::Back)?;
                }
            }
            anyhow::ensure!(c.step() == Some(step), "the tour is not on step {step}");
            // A still moment once ring and card have landed and the words
            // are in: the clock stops, so the ring's drift holds.
            let t0 = Instant::now();
            anim::freeze(Some(t0));
            c.settle()?;
            anim::freeze(Some(t0 + Duration::from_secs(2)));
            c.settle()?;
            let image = c.cx.capture_screenshot(c.window)?;
            let file = format!("tour-{name}-{}.png", appearance.slug());
            image.save(dir.join(&file))?;
            println!("wrote {file}");
            anim::freeze(None);
        }
    }
    Ok(())
}
