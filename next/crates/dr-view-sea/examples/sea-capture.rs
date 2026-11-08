//! 字海 (M24) drawn offscreen: screenshots into `<dir>/m24/`, light and dark.
//!
//! GPUI runs headless (its test platform with the real macOS text system
//! and Metal drawing into a texture): nothing opens on screen. The clock is
//! frozen and the sea is run forward by hand between frames, so every
//! screenshot is one chosen moment. The cards are a synthetic shelf.
//!
//! ```text
//! cargo run -p dr-view-sea --features capture --example sea-capture -- ../docs/rust-rewrite/modules
//! cargo run --release -p dr-view-sea --features capture --example sea-capture -- --bench
//! ```
//!
//! `--bench` draws no screenshots: it times 120 frames (after 30 to warm
//! the glyph cache) of a drop every 250 ms under the shelf, then of a wait
//! with its rain and word, at 1280 × 800, and prints the CPU time of each
//! frame (layout, the sea, the glass; GPUI builds the scene, the GPU work
//! is not in it).

use std::{path::PathBuf, rc::Rc, sync::Arc, time::Duration};

use anyhow::Result;
use dr_shell::{Services, SettingsFile, ShellInfo};
use dr_ui::{Appearance, fonts::Role, style::DrStyled as _, theme, theme::Theme};
use dr_view_sea::{
    HoldKind, Sea, SeaGlass, char_sea,
    first_run::{self, Done, FirstRun, FolderSource, FolderStep},
    on_sea,
};
use gpui::{
    AnyView, App, AppContext as _, Context, Entity, HeadlessAppContext, IntoElement,
    ParentElement as _, Render, SharedString, Styled as _, Window, div, point, px, size,
};

const W: f32 = 1280.0;
const H: f32 = 800.0;
const VERSION: &str = "0.2.0-dev";
const BOOKS: [&str; 5] = ["慢钟", "夜车", "灯塔笔记", "北方来信", "雾港"];
const BOOKS_EN: [&str; 5] = [
    "The Slow Clock",
    "Night Train",
    "Lighthouse Notes",
    "Letters North",
    "Fog Harbour",
];

/// No folder chosen yet on this device.
struct NoFolder;

impl FolderSource for NoFolder {
    fn chosen(&self, _: &App) -> Option<SharedString> {
        None
    }
    fn choose(&self, _: &mut Window, _: &mut App) {}
    fn turn_off(&self, _: Done, _: &mut Window, _: &mut App) {}
}

#[derive(Clone, Copy, PartialEq)]
enum Scene {
    /// The shelf on still water.
    Still,
    /// A ring from a press passing under the cards.
    Ring,
    /// A full-window wait.
    Loading,
    /// A first run: the app's name stands on the sea.
    Title,
    /// The first-run card.
    Card,
    /// The sample landing on the shelf, its rim waiting.
    Landing,
}

struct Board {
    scene: Scene,
    english: bool,
    first_run: Option<Entity<FirstRun>>,
}

const CARD: (f32, f32) = (126.0, 186.0);

fn shelf(english: bool, waiting: bool, window: &mut Window, cx: &mut App) -> impl IntoElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let names = if english { BOOKS_EN } else { BOOKS };
    div()
        .absolute()
        .top(px(250.0))
        .left_0()
        .right_0()
        .flex()
        .flex_row()
        .justify_center()
        .gap(px(36.0))
        .children(names.iter().enumerate().map(|(i, name)| {
            let glass = SeaGlass::resting(2.0).waiting(waiting && i == 0);
            on_sea(
                ("book", i),
                glass,
                div()
                    .w(px(CARD.0))
                    .h(px(CARD.1))
                    .p(px(14.0))
                    .flex()
                    .flex_col()
                    .justify_end()
                    .child(
                        div()
                            .font_role(Role::Structure)
                            .type_px(15.0, 20.0)
                            .text_color(p.ink(1).solid())
                            .child(SharedString::from(*name)),
                    ),
            )
        }))
}

impl Render for Board {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let sea = Sea::of(window, cx);
        let root = div().size_full().relative().child(char_sea(&sea));
        match self.scene {
            Scene::Still | Scene::Ring => root.child(shelf(self.english, false, window, cx)),
            Scene::Landing => root.child(shelf(self.english, true, window, cx)),
            Scene::Loading | Scene::Title => root,
            Scene::Card => root.children(self.first_run.clone().map(AnyView::from)),
        }
    }
}

fn draw(
    cx: &mut HeadlessAppContext,
    handle: gpui::AnyWindowHandle,
    view: &Entity<Board>,
) -> Result<()> {
    cx.update_window(handle, |_, window, cx| {
        window.simulate_next_frame(cx);
        view.update(cx, |_, cx| cx.notify());
        window.draw(cx).clear(cx);
    })?;
    cx.run_until_parked();
    Ok(())
}

fn main() -> Result<()> {
    let arg = std::env::args().nth(1);
    let bench = arg.as_deref() == Some("--bench");
    let root = PathBuf::from(arg.unwrap_or_else(|| "../docs/rust-rewrite/modules".into()));
    let dir = root.join("m24");
    if !bench {
        std::fs::create_dir_all(&dir)?;
    }
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
        first_run::add_step(cx, |_, _| Some(Rc::new(FolderStep::new(Rc::new(NoFolder)))));
        Ok(())
    })?;
    let window = cx.open_window(size(px(W), px(H)), |_, cx| {
        cx.new(|_| Board {
            scene: Scene::Still,
            english: false,
            first_run: None,
        })
    })?;
    let view = window.entity(&cx)?;
    let handle: gpui::AnyWindowHandle = window.into();
    // One clock for every shot, always moving forward (the sea's latches
    // and delays are measured on it).
    let mut now = std::time::Instant::now();
    if bench {
        return measure(&mut cx, handle, &view, now);
    }
    let shots = [
        (Scene::Still, false, "sea-still"),
        (Scene::Ring, false, "sea-ring"),
        (Scene::Loading, false, "sea-loading"),
        (Scene::Title, false, "first-run-title"),
        (Scene::Card, false, "first-run-card"),
        (Scene::Landing, false, "first-run-landing"),
        (Scene::Ring, true, "sea-ring-en"),
    ];
    for appearance in [Appearance::Light, Appearance::Dark] {
        cx.update(|cx| theme::force_appearance(Some(appearance), cx));
        for (scene, english, name) in shots {
            if english && appearance == Appearance::Dark {
                continue;
            }
            cx.update(|cx| {
                dr_shell::Settings::update(cx, |f| {
                    f.set(
                        dr_shell::settings::registry::UI_LOCALE,
                        (if english { "en" } else { "zh-CN" }).into(),
                        None,
                    )
                    .ok()
                })
            });
            dr_ui::anim::freeze(Some(now));
            let mut holds = Vec::new();
            cx.update_window(handle, |_, window, cx| -> Result<()> {
                let sea = Sea::of(window, cx);
                let first_run = (scene == Scene::Card).then(|| {
                    cx.new(|cx| {
                        let mut run = FirstRun::new(window, cx, |_, _| {});
                        run.show_card(window, cx);
                        run
                    })
                });
                view.update(cx, |b, cx| {
                    b.scene = scene;
                    b.english = english;
                    b.first_run = first_run;
                    cx.notify();
                });
                match scene {
                    Scene::Still | Scene::Ring | Scene::Landing => {
                        holds.push(sea.hold(HoldKind::Surface, window))
                    }
                    Scene::Loading => holds.push(sea.hold(HoldKind::Loading, window)),
                    Scene::Title => {
                        holds.push(sea.hold(HoldKind::Title, window));
                        holds.push(sea.hold(HoldKind::Rain, window));
                    }
                    Scene::Card => {}
                }
                Ok(())
            })??;
            // Two frames: the sea lays its sheet and reads the glass.
            draw(&mut cx, handle, &view)?;
            draw(&mut cx, handle, &view)?;
            let run = |cx: &mut HeadlessAppContext, seconds: f32| -> Result<()> {
                cx.update_window(handle, |_, window, cx| Sea::of(window, cx).run_for(seconds))?;
                Ok(())
            };
            let mut frames: Vec<(f32, u32)> = Vec::new();
            let mut advance = |cx: &mut HeadlessAppContext, seconds: f32| -> Result<()> {
                // Each frame moves the frozen clock on by 50 ms, and the sea
                // with it. The draw is timed (layout, sea, glass and all).
                for _ in 0..(seconds * 20.0).round() as usize {
                    now += Duration::from_millis(50);
                    dr_ui::anim::freeze(Some(now));
                    let started = std::time::Instant::now();
                    draw(cx, handle, &view)?;
                    let ms = started.elapsed().as_secs_f32() * 1000.0;
                    let cells = cx.update_window(handle, |_, window, cx| {
                        Sea::of(window, cx).drawn_characters()
                    })?;
                    frames.push((ms, cells));
                }
                draw(cx, handle, &view)
            };
            match scene {
                Scene::Still | Scene::Card => advance(&mut cx, 1.0)?,
                Scene::Title => advance(&mut cx, 1.1)?,
                Scene::Loading => advance(&mut cx, 1.6)?,
                Scene::Ring => {
                    cx.update_window(handle, |_, window, cx| {
                        Sea::of(window, cx).press(point(px(470.0), px(330.0)), 1.2, window)
                    })?;
                    advance(&mut cx, 0.45)?;
                }
                Scene::Landing => {
                    cx.update_window(handle, |_, window, cx| {
                        Sea::of(window, cx).press(
                            point(px(W / 2.0 - 2.0 * (CARD.0 + 36.0)), px(343.0)),
                            1.3,
                            window,
                        )
                    })?;
                    advance(&mut cx, 0.35)?;
                }
            }
            if !frames.is_empty() {
                let mut ms: Vec<f32> = frames.iter().map(|f| f.0).collect();
                ms.sort_by(f32::total_cmp);
                let at = |q: f32| ms[((ms.len() - 1) as f32 * q).round() as usize];
                let cells = frames.iter().map(|f| f.1).max().unwrap_or(0);
                println!(
                    "{name} {}: {} frames, draw p50 {:.1} ms p95 {:.1} ms, up to {cells} characters",
                    appearance.slug(),
                    ms.len(),
                    at(0.5),
                    at(0.95)
                );
            }
            let image = cx.capture_screenshot(handle)?;
            let file = format!("{name}-{}.png", appearance.slug());
            image.save(dir.join(&file))?;
            println!("wrote {file}");
            drop(holds);
            // Let the sea go still and off before the next shot.
            cx.update(|cx| view.update(cx, |b, _| b.first_run = None));
            for _ in 0..3 {
                now += Duration::from_secs(9);
                dr_ui::anim::freeze(Some(now));
                run(&mut cx, 9.0)?;
                draw(&mut cx, handle, &view)?;
            }
        }
    }
    dr_ui::anim::freeze(None);
    Ok(())
}

/// Times steady frames: a drop every 250 ms under the shelf, then a wait.
fn measure(
    cx: &mut HeadlessAppContext,
    handle: gpui::AnyWindowHandle,
    view: &Entity<Board>,
    mut now: std::time::Instant,
) -> Result<()> {
    for (scene, label) in [(Scene::Still, "drops"), (Scene::Loading, "loading")] {
        let hold = cx.update_window(handle, |_, window, cx| {
            view.update(cx, |b, cx| {
                b.scene = scene;
                cx.notify();
            });
            let kind = if scene == Scene::Loading {
                HoldKind::Loading
            } else {
                HoldKind::Surface
            };
            Sea::of(window, cx).hold(kind, window)
        })?;
        let mut rand = dr_view_sea::model::Rand::new(9);
        let mut times = Vec::new();
        let mut cells = Vec::new();
        let mut moving = Vec::new();
        let mut drawing = Vec::new();
        for frame in 0..150 {
            now += Duration::from_micros(16_667);
            dr_ui::anim::freeze(Some(now));
            if scene == Scene::Still && frame % 15 == 0 {
                let (x, y) = (
                    W * (0.15 + 0.7 * rand.next()),
                    H * (0.15 + 0.7 * rand.next()),
                );
                cx.update_window(handle, |_, window, cx| {
                    Sea::of(window, cx).press(point(px(x), px(y)), 1.2, window)
                })?;
            }
            let started = std::time::Instant::now();
            draw(cx, handle, view)?;
            if frame >= 30 {
                times.push(started.elapsed().as_secs_f32() * 1000.0);
                let (n, (m, d)) = cx.update_window(handle, |_, window, cx| {
                    let sea = Sea::of(window, cx);
                    (sea.drawn_characters(), sea.frame_times())
                })?;
                cells.push(n);
                moving.push(m);
                drawing.push(d);
            }
        }
        cells.sort();
        let pct = |v: &mut Vec<f32>, q: f32| {
            v.sort_by(f32::total_cmp);
            v[((v.len() - 1) as f32 * q).round() as usize]
        };
        println!(
            "{label}: {} frames, whole frame p50 {:.1} ms p95 {:.1} ms; the sea moving p50 {:.2} ms, drawing p50 {:.1} ms p95 {:.1} ms; characters p50 {}",
            times.len(),
            pct(&mut times, 0.5),
            pct(&mut times, 0.95),
            pct(&mut moving, 0.5),
            pct(&mut drawing, 0.5),
            pct(&mut drawing, 0.95),
            cells[cells.len() / 2]
        );
        drop(hold);
        for _ in 0..3 {
            now += Duration::from_secs(9);
            dr_ui::anim::freeze(Some(now));
            cx.update_window(handle, |_, window, cx| Sea::of(window, cx).run_for(9.0))?;
            draw(cx, handle, view)?;
        }
    }
    dr_ui::anim::freeze(None);
    Ok(())
}
