//! The bottom timeline (M14) drawn offscreen, light and dark, into
//! `<dir>/m14/`:
//!
//! ```text
//! cargo run -p dr-view-timeline --features capture --example timeline-capture -- ../docs/rust-rewrite/modules
//! ```
//!
//! GPUI runs headless (its test platform with the real macOS text system and
//! Metal drawing into a texture): nothing opens on screen. The library is
//! dr-testkit's 《慢钟》, seeded into a temporary folder and read through F3.
//! The timeline is drawn on its own, as wide as a window and as high as the
//! Bottom Panel, until the shell hosts it under the paper.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail};
use dr_shell::nav::{Open, Target};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_ui::{Appearance, theme};
use dr_view_timeline::BottomTimeline;
use dr_view_timeline::model::{Axis, RAIL_WIDTH, STRIP_HEIGHT};
use dr_workspace::{
    Actor,
    commands::chapter::{ChapterUpdate, ChapterUpdateIn},
};
use gpui::{
    AnyWindowHandle, AppContext as _, Context, Entity, HeadlessAppContext, IntoElement, Modifiers,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement as _, PlatformInput,
    Render, Styled as _, Window, div, point, px, size,
};

const W: f32 = 1280.0;
const VERSION: &str = "0.2.0-dev";

struct Host {
    _ws: Entity<Workspace>,
    timeline: Entity<BottomTimeline>,
    /// Empty room above the timeline (where a hover card rises).
    above: f32,
}

impl Render for Host {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = dr_ui::Theme::of(window, cx).palette;
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(p.desk.solid())
            .child(div().h(px(self.above)).flex_none())
            .child(div().flex_1().min_h_0().child(self.timeline.clone()))
    }
}

struct Headless {
    cx: HeadlessAppContext,
    library: dr_workspace::Workspace,
    _dir: tempfile::TempDir,
}

impl Headless {
    fn new() -> Result<Headless> {
        let text_system = gpui_platform::current_platform(true).text_system();
        let mut cx = HeadlessAppContext::with_platform(
            text_system,
            Arc::new(dr_ui::Assets::new()),
            gpui_platform::current_headless_renderer,
        );
        cx.allow_parking();
        let dir = tempfile::tempdir()?;
        let root = dir.path().join("library");
        let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION))?;
        let book = dr_testkit::samples::slow_clock()?;
        dr_testkit::seed::write_book(&lib, &book).map_err(|e| anyhow::anyhow!("{e}"))?;
        lib.close()?;
        let library = dr_workspace::Workspace::open_dir(&root, VERSION)?;
        library.library().rebuild_stale_indexes()?;
        let services_library = library.clone();
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
            let services = Services {
                library: Some(services_library),
                ..Services::default()
            };
            dr_shell::init(info, services, file, cx);
            Ok(())
        })?;
        Ok(Headless {
            cx,
            library,
            _dir: dir,
        })
    }

    /// A window `height` high with the timeline and its workspace.
    fn window(&mut self, height: f32) -> Result<(AnyWindowHandle, Entity<Host>)> {
        self.window_above(height, 0.0)
    }

    /// The same, the timeline under `above` px of room.
    fn window_above(&mut self, height: f32, above: f32) -> Result<(AnyWindowHandle, Entity<Host>)> {
        let window = self.cx.open_window(size(px(W), px(height)), |window, cx| {
            let ws = cx.new(|cx| Workspace::new(window, cx));
            let timeline = dr_view_timeline::make(ws.downgrade(), cx);
            cx.new(|_| Host {
                _ws: ws,
                timeline,
                above,
            })
        })?;
        let host = window.entity(&self.cx)?;
        let window: AnyWindowHandle = window.into();
        self.cx
            .update_window(window, |_, window, _| window.activate_window())?;
        Ok((window, host))
    }

    fn draw(&mut self, window: AnyWindowHandle) -> Result<()> {
        self.cx.update_window(window, |_, window, cx| {
            window.simulate_next_frame(cx);
            window.refresh();
            window.draw(cx).clear(cx);
        })
    }

    fn wait(
        &mut self,
        window: AnyWindowHandle,
        done: impl Fn(&mut Headless) -> bool,
    ) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            self.draw(window)?;
            self.cx.run_until_parked();
            if done(self) {
                return Ok(());
            }
            if Instant::now() > deadline {
                bail!("timed out");
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    /// Draws for a little over the longest motion (420 ms).
    fn settle(&mut self, window: AnyWindowHandle) -> Result<()> {
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(600) {
            self.draw(window)?;
            self.cx.run_until_parked();
            std::thread::sleep(Duration::from_millis(16));
        }
        Ok(())
    }

    fn input(&mut self, window: AnyWindowHandle, event: PlatformInput) -> Result<()> {
        self.cx.update_window(window, |_, window, cx| {
            window.dispatch_event(event, cx);
        })?;
        self.cx.run_until_parked();
        Ok(())
    }

    /// Writes the window as a 256-colour PNG (as dr-shell's capture does).
    fn save(&mut self, window: AnyWindowHandle, dir: &Path, name: &str) -> Result<()> {
        let image = self.cx.capture_screenshot(window)?;
        let (w, h) = image.dimensions();
        let rgba = image.into_raw();
        let quant = color_quant::NeuQuant::new(10, 256, &rgba);
        let indices: Vec<u8> = rgba
            .as_chunks::<4>()
            .0
            .iter()
            .map(|px| quant.index_of(px) as u8)
            .collect();
        let palette: Vec<u8> = quant
            .color_map_rgba()
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|c| [c[0], c[1], c[2]])
            .collect();
        std::fs::create_dir_all(dir)?;
        let file = std::io::BufWriter::new(std::fs::File::create(dir.join(name))?);
        let mut encoder = png::Encoder::new(file, w, h);
        encoder.set_color(png::ColorType::Indexed);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_palette(palette);
        encoder.set_compression(png::Compression::High);
        encoder.write_header()?.write_image_data(&indices)?;
        println!("wrote {}", dir.join(name).display());
        Ok(())
    }
}

fn timeline(h: &mut Headless, host: &Entity<Host>) -> Entity<BottomTimeline> {
    h.cx.update(|cx| host.read(cx).timeline.clone())
}

fn capture(dir: PathBuf) -> Result<()> {
    let mut h = Headless::new()?;
    let out = dir.join("m14");
    // One chapter off every storyline (for 未归属) and one off the narrative
    // axis (for 未放置), so both have something to show.
    let book = {
        let (window, host) = h.window(180.0)?;
        let t = timeline(&mut h, &host);
        h.wait(window, |h| h.cx.update(|cx| t.read(cx).layout().placed > 0))?;
        let layout = h.cx.update(|cx| t.read(cx).layout());
        let ws_book = h.cx.update(|cx| host.read(cx)._ws.read(cx).book.id.clone());
        let loose = layout.lanes[2]
            .clips
            .last()
            .context("a third lane")?
            .clone();
        h.library
            .run::<ChapterUpdate>(
                &Actor::User,
                ChapterUpdateIn {
                    book: ws_book.clone(),
                    id: loose.id.clone(),
                    remove_storylines: loose.storylines.clone(),
                    primary_storyline: Some(None),
                    ..ChapterUpdateIn::default()
                },
            )
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        let waiting = layout.lanes[0]
            .clips
            .last()
            .context("a first lane")?
            .clone();
        h.library
            .run::<ChapterUpdate>(
                &Actor::User,
                ChapterUpdateIn {
                    book: ws_book.clone(),
                    id: waiting.id.clone(),
                    narrative_order: Some(None),
                    ..ChapterUpdateIn::default()
                },
            )
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        ws_book
    };
    let _ = book;
    for (appearance, suffix) in [(Appearance::Light, "light"), (Appearance::Dark, "dark")] {
        h.cx.update(|cx| theme::force_appearance(Some(appearance), cx));

        // Reading order at the Bottom Panel's height, a chapter open.
        let (window, host) = h.window(180.0)?;
        let t = timeline(&mut h, &host);
        h.wait(window, |h| {
            h.cx.update(|cx| t.read(cx).layout().unaffiliated > 0)
        })?;
        let open =
            h.cx.update(|cx| t.read(cx).layout().lanes[0].clips[1].clone());
        let ws = h.cx.update(|cx| host.read(cx)._ws.clone());
        let target = Target::Chapter(open.id.parse()?);
        h.cx.update(|cx| ws.update(cx, |ws, cx| ws.open(target, Open::KEEP, cx)));
        h.settle(window)?;
        h.save(window, &out, &format!("timeline-{suffix}.png"))?;

        // A chapter in the hand, over the next lane.
        let layout = h.cx.update(|cx| t.read(cx).layout());
        let body =
            h.cx.update(|cx| t.read(cx).body_bounds())
                .context("the lanes' box")?;
        let row = (f32::from(body.size.height) - STRIP_HEIGHT) / layout.lanes.len() as f32;
        let c = layout.lanes[1].clips[0].clone();
        let order = c.book_order.unwrap_or(0.0);
        let x = f32::from(body.origin.x) + RAIL_WIDTH + layout.scale.x(order) + 20.0;
        let y = f32::from(body.origin.y) + STRIP_HEIGHT + row * 1.5;
        let start = point(px(x), px(y));
        h.input(
            window,
            PlatformInput::MouseDown(MouseDownEvent {
                button: MouseButton::Left,
                position: start,
                modifiers: Modifiers::none(),
                click_count: 1,
                first_mouse: false,
            }),
        )?;
        for (dx, dy) in [(6.0, 0.0), (60.0, row * 0.6), (150.0, row * 1.05)] {
            h.input(
                window,
                PlatformInput::MouseMove(MouseMoveEvent {
                    position: point(px(x + dx), px(y + dy)),
                    pressed_button: Some(MouseButton::Left),
                    modifiers: Modifiers::none(),
                }),
            )?;
            h.draw(window)?;
        }
        // Caught mid-way: the slab trails the hand on its spring.
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(70) {
            h.draw(window)?;
            std::thread::sleep(Duration::from_millis(8));
        }
        h.save(window, &out, &format!("timeline-drag-{suffix}.png"))?;
        // Let go over the header: no lane, nothing moves.
        h.input(
            window,
            PlatformInput::MouseUp(MouseUpEvent {
                button: MouseButton::Left,
                position: point(px(x), px(10.0)),
                modifiers: Modifiers::none(),
                click_count: 1,
            }),
        )?;
        h.cx.update_window(window, |_, window, _| window.remove_window())?;

        // Narrative order with 未归属 shown (one lane higher) and 未放置 open.
        let (window, host) = h.window(250.0)?;
        let t = timeline(&mut h, &host);
        h.wait(window, |h| {
            h.cx.update(|cx| t.read(cx).layout().unaffiliated > 0)
        })?;
        h.cx.update(|cx| {
            t.update(cx, |t, cx| {
                t.set_axis(Axis::Narrative, cx);
                // Zoomed out so the pins show.
                t.set_zoom(0.5, cx);
                t.toggle_unaffiliated(cx);
                t.toggle_unplaced(cx);
            })
        });
        h.wait(window, |h| h.cx.update(|cx| t.read(cx).pins().len() >= 5))?;
        h.settle(window)?;
        h.save(window, &out, &format!("timeline-narrative-{suffix}.png"))?;
        h.cx.update_window(window, |_, window, _| window.remove_window())?;

        // Hover cards: an act's (reading order) and a pin's (narrative
        // order), each rising over the room above. A slab's and a lane's
        // card are the shell's page card, which nothing can hold open
        // offscreen yet.
        for (name, axis) in [("act", Axis::Book), ("pin", Axis::Narrative)] {
            let (window, host) = h.window_above(470.0, 290.0)?;
            let t = timeline(&mut h, &host);
            h.wait(window, |h| {
                h.cx.update(|cx| t.read(cx).layout().placed > 0 && t.read(cx).pins().len() >= 5)
            })?;
            let key = h.cx.update(|cx| {
                let t = t.read(cx);
                let book = host.read(cx)._ws.read(cx).book.clone();
                match name {
                    "act" => format!("timeline-act-card-{}", book.acts[1].id),
                    _ => format!("timeline-pin-card-{}", t.pins()[1].id),
                }
            });
            h.cx.update(|cx| {
                t.update(cx, |t, cx| {
                    t.set_axis(axis, cx);
                    t.set_zoom(0.5, cx);
                    t.hold_card(Some(key), cx);
                })
            });
            h.settle(window)?;
            h.save(window, &out, &format!("timeline-card-{name}-{suffix}.png"))?;
            h.cx.update_window(window, |_, window, _| window.remove_window())?;
        }
    }
    Ok(())
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let Some(dir) = args.next() else {
        bail!("usage: timeline-capture <docs/rust-rewrite/modules>");
    };
    capture(PathBuf::from(dir))
}
