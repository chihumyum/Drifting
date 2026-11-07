//! The dr-ui gallery: every component, light and dark.
//!
//! `cargo run -p dr-ui --example gallery` opens one window. The top row
//! switches the page and forces light or dark inside the app (the system
//! setting is left alone). With `--features capture`, `--capture <dir>`
//! writes the screenshots offscreen and `--bench <file>` measures frames;
//! neither opens a window. See docs/rust-rewrite/foundations/f5-ui.md.
//!
//! Every word in it is synthetic.

mod capture;
mod pages;

use gpui::{
    App, AppContext as _, Bounds, Context, Entity, IntoElement, ParentElement, Render, Styled,
    Window, WindowBounds, WindowOptions, div, px, size,
};

use dr_ui::{
    Appearance, Theme,
    components::Segmented,
    fonts::Role,
    glass::{self, Ground},
    input::TextField,
    sand::Icon,
    style::DrStyled,
    theme,
};

pub const WINDOW_W: f32 = 1280.0;
pub const WINDOW_H: f32 = 800.0;
pub const TOP_BAR: f32 = 44.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Page {
    Tokens,
    Controls,
    Floating,
    Sand,
    Motion,
}

impl Page {
    pub const ALL: [Page; 5] = [
        Page::Tokens,
        Page::Controls,
        Page::Floating,
        Page::Sand,
        Page::Motion,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Page::Tokens => "令牌",
            Page::Controls => "控件",
            Page::Floating => "浮层",
            Page::Sand => "砂笔",
            Page::Motion => "过渡",
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            Page::Tokens => "tokens",
            Page::Controls => "controls",
            Page::Floating => "floating",
            Page::Sand => "sand",
            Page::Motion => "motion",
        }
    }
}

pub struct Gallery {
    pub page: Page,
    pub appearance: Appearance,
    pub switches: [bool; 2],
    pub scope: bool,
    pub chips: [bool; 4],
    pub segment: usize,
    pub pill: usize,
    pub choice: usize,
    pub title: Entity<TextField>,
    pub search: Entity<TextField>,
    pub locked: Entity<TextField>,
    pub menu_open: bool,
    pub dialog_open: bool,
    pub notice: bool,
    pub cell: usize,
    pub readouts: [f32; 4],
    pub sheet: usize,
    pub panel: usize,
    /// The pushed panel is open (a click on its selected tab closes it).
    pub panel_open: bool,
    /// The wave's pills in their dragged order (chapter numbers).
    pub wave_order: Vec<usize>,
    /// Font size, line height, paragraph spacing, paper width.
    pub numbers: [f64; 4],
    pub thinking: bool,
    /// Hold every hover card and list open (captures).
    pub hold_open: bool,
    /// Show the things that turn on their own (busy button, loading marks,
    /// indeterminate progress). Off for measuring a still window.
    pub loaders: bool,
}

impl Gallery {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Gallery {
        let title =
            cx.new(|cx| TextField::new("field-title", window, cx).with_text("第三章　雾港"));
        let search = cx.new(|cx| {
            let mut f = TextField::new("field-search", window, cx)
                .icon(Icon::Search)
                .placeholder("搜索");
            f.set_meta(Some("3 / 12".into()), cx);
            f
        });
        let locked = cx.new(|cx| {
            let mut f = TextField::new("field-locked", window, cx).with_text("林岚");
            f.set_disabled(true, cx);
            f
        });
        Gallery {
            page: Page::Controls,
            appearance: Appearance::Light,
            switches: [false, true],
            scope: true,
            chips: [true, false, false, true],
            segment: 0,
            pill: 1,
            choice: 2,
            title,
            search,
            locked,
            menu_open: false,
            dialog_open: false,
            notice: true,
            cell: 1,
            readouts: [0.82, 0.46, 0.64, 0.18],
            sheet: 0,
            panel: 0,
            panel_open: true,
            wave_order: (0..6).collect(),
            numbers: [17.0, 1.5, 1.0, 720.0],
            thinking: true,
            hold_open: false,
            loaders: !std::env::args().any(|a| a == "--quiet"),
        }
    }

    pub fn set_appearance(&mut self, appearance: Appearance, cx: &mut Context<Self>) {
        self.appearance = appearance;
        theme::force_appearance(Some(appearance), cx);
        cx.notify();
    }
}

impl Render for Gallery {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = Theme::of(window, cx);
        let p = t.palette;
        let pages = Page::ALL.iter().map(|p| p.label());
        let selected = Page::ALL.iter().position(|x| *x == self.page).unwrap_or(0);
        let entity = cx.entity();
        let look = entity.clone();
        let bar = div()
            .h(px(TOP_BAR))
            .flex_none()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(28.0))
            .pl(px(84.0))
            .border_b(px(0.5))
            .border_color(p.hairline())
            .child(
                Segmented::new("gallery-pages", pages, selected).on_change(move |i, _, cx| {
                    entity.update(cx, |g, cx| {
                        g.page = Page::ALL[i];
                        cx.notify();
                    })
                }),
            )
            .child(
                Segmented::new(
                    "gallery-appearance",
                    ["浅", "深"],
                    usize::from(self.appearance == Appearance::Dark),
                )
                .on_change(move |i, _, cx| {
                    look.update(cx, |g, cx| {
                        let a = if i == 0 {
                            Appearance::Light
                        } else {
                            Appearance::Dark
                        };
                        g.set_appearance(a, cx);
                    })
                }),
            );
        let page = match self.page {
            Page::Tokens => pages::tokens(self, window, cx).into_any_element(),
            Page::Controls => pages::controls(self, window, cx).into_any_element(),
            Page::Floating => pages::floating(self, window, cx).into_any_element(),
            Page::Sand => pages::sand(self, window, cx).into_any_element(),
            Page::Motion => pages::motion(self, window, cx).into_any_element(),
        };
        glass::surface(
            Ground::flat(p.desk),
            div()
                .size_full()
                .flex()
                .flex_col()
                .bg(p.desk.solid())
                .font_role(Role::Ui)
                .type_px(t.scale.body, t.scale.line_body)
                .text_color(p.ink(2).solid())
                .child(bar)
                .child(div().relative().flex_1().overflow_hidden().child(page)),
        )
    }
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let value = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .map(std::path::PathBuf::from)
    };
    // Say so before any window opens: the fonts are built, not committed.
    if let Err(missing) = dr_ui::fonts::locate() {
        eprintln!("{missing}");
        std::process::exit(1);
    }
    if let Some(dir) = value("--capture") {
        return capture::run(dir);
    }
    if let Some(file) = value("--bench") {
        return capture::bench(file);
    }
    gpui_platform::application()
        .with_assets(dr_ui::Assets::new())
        .run(|cx: &mut App| {
            if let Err(missing) = dr_ui::init(cx) {
                eprintln!("{missing}");
                cx.quit();
                return;
            }
            theme::force_appearance(Some(Appearance::Light), cx);
            let bounds = Bounds::centered(None, size(px(WINDOW_W), px(WINDOW_H)), cx);
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    ..Default::default()
                },
                |window, cx| cx.new(|cx| Gallery::new(window, cx)),
            )
            .expect("open the gallery window");
            cx.activate(true);
        });
    Ok(())
}
