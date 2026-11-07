//! `--capture <dir>` and `--bench <file>`: the gallery drawn offscreen.
//!
//! Both run GPUI headless (its test platform, the real macOS text system and
//! the Metal renderer drawing into a texture), so they need no
//! screen-recording permission, open no window and keep working while
//! another app is in front. Build with `--features capture`.

use std::path::PathBuf;

use anyhow::Result;

#[cfg(not(feature = "capture"))]
pub fn run(_dir: PathBuf) -> Result<()> {
    anyhow::bail!("build the gallery with --features capture to write screenshots")
}

#[cfg(not(feature = "capture"))]
pub fn bench(_file: PathBuf) -> Result<()> {
    anyhow::bail!("build the gallery with --features capture to measure frames")
}

#[cfg(feature = "capture")]
pub use headless::{bench, run};

#[cfg(feature = "capture")]
mod headless {
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };

    use super::*;
    use gpui::{
        AnyWindowHandle, AppContext as _, Entity, HeadlessAppContext, Modifiers, MouseButton,
        MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, PlatformInput, Point, point, px,
        size,
    };

    use crate::{Gallery, Page, WINDOW_H, WINDOW_W};
    use dr_ui::{Appearance, anim, theme};

    pub struct Headless {
        pub cx: HeadlessAppContext,
        pub window: AnyWindowHandle,
        pub view: Entity<Gallery>,
        /// How long `dr_ui::init` (registering the fonts) took, ms.
        pub init_ms: f32,
        /// The first frame of the first page, ms (fonts first used).
        pub first_frame_ms: f32,
    }

    impl Headless {
        pub fn new() -> Result<Headless> {
            let text_system = gpui_platform::current_platform(true).text_system();
            let mut cx = HeadlessAppContext::with_platform(
                text_system,
                Arc::new(dr_ui::Assets::new()),
                gpui_platform::current_headless_renderer,
            );
            let started = Instant::now();
            cx.update(|cx| -> Result<()> {
                dr_ui::init(cx)?;
                theme::force_appearance(Some(Appearance::Light), cx);
                Ok(())
            })?;
            let init_ms = started.elapsed().as_secs_f32() * 1000.0;
            let window = cx.open_window(size(px(WINDOW_W), px(WINDOW_H)), |window, cx| {
                cx.new(|cx| Gallery::new(window, cx))
            })?;
            let view = window.entity(&cx)?;
            let mut h = Headless {
                cx,
                window: window.into(),
                view,
                init_ms,
                first_frame_ms: 0.0,
            };
            h.first_frame_ms = h.draw()?.0;
            Ok(h)
        }

        pub fn set(&mut self, f: impl FnOnce(&mut Gallery, &mut gpui::Context<Gallery>)) {
            let view = self.view.clone();
            self.cx.update(|cx| view.update(cx, f));
        }

        /// One frame: re-render, lay out and paint. Returns its CPU time in
        /// ms and how many next-frame requests it left behind.
        pub fn draw(&mut self) -> Result<(f32, usize)> {
            let view = self.view.clone();
            self.cx.update_window(self.window, |_, window, cx| {
                // Deliver the frame requests the last frame made, then draw.
                let pending = window.simulate_next_frame(cx);
                view.update(cx, |_, cx| cx.notify());
                let started = Instant::now();
                window.draw(cx).clear(cx);
                (started.elapsed().as_secs_f32() * 1000.0, pending)
            })
        }

        /// How many frame requests the last drawn frame left pending.
        pub fn pending(&mut self) -> Result<usize> {
            self.cx
                .update_window(self.window, |_, window, cx| window.simulate_next_frame(cx))
        }

        pub fn send(&mut self, event: PlatformInput) -> Result<()> {
            self.cx.update_window(self.window, |_, window, cx| {
                window.dispatch_event(event, cx);
            })?;
            Ok(())
        }

        pub fn move_to(&mut self, at: Point<Pixels>) -> Result<()> {
            self.send(PlatformInput::MouseMove(MouseMoveEvent {
                position: at,
                pressed_button: None,
                modifiers: Modifiers::default(),
            }))
        }

        /// A move with the left button held (a drag).
        pub fn drag_to(&mut self, at: Point<Pixels>) -> Result<()> {
            self.send(PlatformInput::MouseMove(MouseMoveEvent {
                position: at,
                pressed_button: Some(MouseButton::Left),
                modifiers: Modifiers::default(),
            }))
        }

        pub fn press(&mut self, at: Point<Pixels>) -> Result<()> {
            self.send(PlatformInput::MouseDown(MouseDownEvent {
                button: MouseButton::Left,
                position: at,
                modifiers: Modifiers::default(),
                click_count: 1,
                first_mouse: false,
            }))
        }

        pub fn release(&mut self, at: Point<Pixels>) -> Result<()> {
            self.send(PlatformInput::MouseUp(MouseUpEvent {
                button: MouseButton::Left,
                position: at,
                modifiers: Modifiers::default(),
                click_count: 1,
            }))
        }

        /// Focuses the inputs page's chapter title and has the input
        /// method mark `pinyin` at its end.
        pub fn compose_in_title(&mut self, pinyin: &str) -> Result<()> {
            use gpui::{EntityInputHandler as _, Focusable as _};
            let view = self.view.clone();
            self.cx.update_window(self.window, |_, window, cx| {
                let area = view.read(cx).chapter_title.clone();
                window.focus(&area.focus_handle(cx), cx);
                let end = pinyin.encode_utf16().count();
                area.update(cx, |a, cx| {
                    a.replace_and_mark_text_in_range(None, pinyin, Some(end..end), window, cx)
                });
            })?;
            Ok(())
        }

        pub fn save(&mut self, dir: &std::path::Path, name: &str) -> Result<()> {
            let image = self.cx.capture_screenshot(self.window)?;
            image.save(dir.join(name))?;
            println!("wrote {name}");
            Ok(())
        }

        /// Draws frames at 60 a second of real time for `seconds`, timing each.
        pub fn frames(&mut self, seconds: f32) -> Result<Vec<f32>> {
            let started = Instant::now();
            let mut next = started;
            let mut times = Vec::new();
            while started.elapsed().as_secs_f32() < seconds {
                times.push(self.draw()?.0);
                next += Duration::from_micros(16_667);
                if let Some(wait) = next.checked_duration_since(Instant::now()) {
                    std::thread::sleep(wait);
                }
            }
            Ok(times)
        }
    }

    /// The controls page's font size knob (its value 17 of 12–28), found by
    /// the page's layout.
    const FONT_SIZE_KNOB: Point<Pixels> = point(px(800.0), px(318.0));

    /// The motion page's tab dock, at rest (its marks' middle).
    const DOCK: Point<Pixels> = point(px(392.0), px(511.0));

    fn settle(h: &mut Headless) -> Result<()> {
        // Fonts, SVG tiles and hover cards' first layout take a few frames.
        for _ in 0..4 {
            h.draw()?;
        }
        Ok(())
    }

    pub fn run(dir: PathBuf) -> Result<()> {
        std::fs::create_dir_all(&dir)?;
        let mut h = Headless::new()?;
        for appearance in [Appearance::Light, Appearance::Dark] {
            h.set(|g, cx| {
                g.set_appearance(appearance, cx);
                g.hold_open = true;
                g.thinking = false;
            });
            for page in Page::ALL {
                h.set(|g, cx| {
                    g.page = page;
                    g.dialog_open = false;
                    cx.notify();
                });
                // On the controls page the pointer rests on the font size's
                // knob, so its halo shows; on the inputs page on the book
                // card's trash; elsewhere it is out of the way.
                let (tx, ty) = crate::pages::INPUTS_TRASH;
                h.move_to(match page {
                    Page::Controls => FONT_SIZE_KNOB,
                    Page::Inputs => point(px(tx), px(ty)),
                    _ => point(px(WINDOW_W - 4.0), px(WINDOW_H - 4.0)),
                })?;
                // The chapter title holds the caret, mid-composition.
                if page == Page::Inputs {
                    h.compose_in_title("deng ta")?;
                }
                // A still moment: the clock stops so drifts and spinners hold.
                let t0 = Instant::now();
                anim::freeze(Some(t0));
                settle(&mut h)?;
                anim::freeze(Some(t0 + Duration::from_secs(2)));
                settle(&mut h)?;
                h.save(&dir, &format!("{}-{}.png", page.slug(), appearance.slug()))?;
                anim::freeze(None);
                if page == Page::Inputs {
                    // Letting go discards the composition.
                    h.cx.update_window(h.window, |_, window, cx| window.blur(cx))?;
                }
            }
            // The dialog over the floating page.
            h.set(|g, cx| {
                g.page = Page::Floating;
                g.hold_open = false;
                g.dialog_open = true;
                cx.notify();
            });
            let t0 = Instant::now();
            anim::freeze(Some(t0 + Duration::from_secs(2)));
            settle(&mut h)?;
            h.save(&dir, &format!("dialog-{}.png", appearance.slug()))?;
            anim::freeze(None);
            // Transitions caught mid-way: the wave between pills, the page
            // dissolving, the panel being pushed, a sand frame being drawn.
            h.set(|g, cx| {
                g.page = Page::Motion;
                g.dialog_open = false;
                g.pill = 0;
                g.sheet = 0;
                g.panel = 0;
                cx.notify();
            });
            let t0 = Instant::now();
            anim::freeze(Some(t0));
            settle(&mut h)?;
            h.set(|g, cx| {
                g.pill = 4;
                g.sheet = 1;
                g.panel = 1;
                cx.notify();
            });
            h.draw()?;
            anim::freeze(Some(t0 + Duration::from_millis(140)));
            settle(&mut h)?;
            h.save(&dir, &format!("motion-midway-{}.png", appearance.slug()))?;
            // A pill in the hand: the third chapter picked up and carried
            // down and right; 150ms later its copy is still catching up.
            let t2 = t0 + Duration::from_secs(2);
            anim::freeze(Some(t2));
            settle(&mut h)?;
            let pick = point(px(255.0), px(crate::TOP_BAR + 46.0));
            h.press(pick)?;
            h.draw()?;
            for k in 1..=6 {
                let f = k as f32 / 6.0;
                h.drag_to(point(pick.x + px(190.0 * f), pick.y + px(64.0 * f)))?;
                h.draw()?;
            }
            for step in 1..=3 {
                anim::freeze(Some(t2 + Duration::from_millis(50 * step)));
                h.draw()?;
            }
            h.save(&dir, &format!("motion-drag-{}.png", appearance.slug()))?;
            h.release(point(pick.x + px(190.0), pick.y + px(64.0)))?;
            h.draw()?;
            // The tab dock under the hand: its marks growing into pills,
            // caught 120 ms in.
            let t3 = t0 + Duration::from_secs(4);
            anim::freeze(Some(t3));
            h.move_to(DOCK)?;
            h.draw()?;
            anim::freeze(Some(t3 + Duration::from_millis(120)));
            settle(&mut h)?;
            h.save(&dir, &format!("motion-dock-grow-{}.png", appearance.slug()))?;
            // A pill carried along the open row: the third chapter past the
            // next two, which make way on the spring (caught 150 ms in).
            let t4 = t3 + Duration::from_secs(1);
            anim::freeze(Some(t4));
            settle(&mut h)?;
            let lift = point(px(130.0), px(514.0));
            h.press(lift)?;
            h.draw()?;
            for k in 1..=6 {
                let f = k as f32 / 6.0;
                h.drag_to(point(lift.x + px(200.0 * f), lift.y + px(4.0 * f)))?;
                h.draw()?;
            }
            for step in 1..=3 {
                anim::freeze(Some(t4 + Duration::from_millis(50 * step)));
                h.draw()?;
            }
            h.save(
                &dir,
                &format!("motion-dock-reorder-{}.png", appearance.slug()),
            )?;
            h.release(point(lift.x + px(200.0), lift.y + px(4.0)))?;
            h.draw()?;
            anim::freeze(None);
            // Away again: the dock folds back once its wait is over.
            h.move_to(point(px(WINDOW_W - 4.0), px(WINDOW_H - 4.0)))?;
            h.draw()?;
            h.cx.advance_clock(
                dr_ui::tokens::motion::dwell::DOCK_COLLAPSE + Duration::from_millis(20),
            );
            h.cx.run_until_parked();
            h.draw()?;
            h.set(|g, cx| {
                g.page = Page::Sand;
                g.cell = 0;
                cx.notify();
            });
            let t1 = t0 + Duration::from_secs(3);
            anim::freeze(Some(t1));
            settle(&mut h)?;
            h.set(|g, cx| {
                g.cell = 2;
                cx.notify();
            });
            h.draw()?;
            anim::freeze(Some(t1 + Duration::from_millis(260)));
            settle(&mut h)?;
            h.save(&dir, &format!("sand-drawing-{}.png", appearance.slug()))?;
            anim::freeze(None);
            h.set(|g, cx| {
                g.cell = 1;
                g.dock_order = (0..5).collect();
                g.pill = 1;
                g.sheet = 0;
                g.panel = 0;
                cx.notify();
            });
        }
        Ok(())
    }

    fn percentile(values: &[f32], p: f32) -> f32 {
        if values.is_empty() {
            return 0.0;
        }
        let mut v = values.to_vec();
        v.sort_by(|a, b| a.total_cmp(b));
        v[((v.len() - 1) as f32 * p).round() as usize]
    }

    fn summary(values: &[f32]) -> String {
        format!(
            r#"{{"n": {}, "p50": {:.3}, "p95": {:.3}, "max": {:.3}}}"#,
            values.len(),
            percentile(values, 0.5),
            percentile(values, 0.95),
            values.iter().copied().fold(0.0, f32::max)
        )
    }

    /// The window position of the controls page's secondary button, found
    /// by its layout: buttons start at (32, TOP_BAR + 32).
    fn button_point() -> Point<Pixels> {
        point(px(32.0 + 80.0 + 60.0), px(crate::TOP_BAR + 32.0 + 15.0))
    }

    pub fn bench(file: PathBuf) -> Result<()> {
        let mut h = Headless::new()?;
        let mut out = vec![format!(
            r#""start": {{"init_ms": {:.2}, "first_frame_ms": {:.2}}}"#,
            h.init_ms, h.first_frame_ms
        )];
        h.set(|g, _| g.loaders = false);
        for page in Page::ALL {
            h.set(|g, cx| {
                g.page = page;
                g.thinking = false;
                cx.notify();
            });
            settle(&mut h)?;
            // Let every transition land, then see whether anything still
            // asks for frames.
            std::thread::sleep(Duration::from_millis(700));
            h.draw()?;
            h.draw()?;
            let pending = h.pending()?;
            let times: Vec<f32> = (0..60)
                .map(|_| h.draw().map(|d| d.0))
                .collect::<Result<_>>()?;
            out.push(format!(
                r#""{}": {{"frame_requests_at_rest": {}, "full_redraw_ms": {}}}"#,
                page.slug(),
                pending,
                summary(&times)
            ));
        }
        // What turns on its own: two loading marks and an indeterminate
        // progress line on the floating page, frame after frame.
        h.set(|g, cx| {
            g.page = Page::Floating;
            g.loaders = true;
            cx.notify();
        });
        settle(&mut h)?;
        let loaders = h.frames(1.0)?;
        let loader_requests = h.pending()?;
        out.push(format!(
            r#""loaders_turning": {{"frame_ms": {}, "frame_requests": {}}}"#,
            summary(&loaders),
            loader_requests
        ));
        h.set(|g, _| g.loaders = false);
        // Hover: the pointer on a secondary button sets its rim drifting.
        h.set(|g, cx| {
            g.page = Page::Controls;
            cx.notify();
        });
        settle(&mut h)?;
        h.move_to(button_point())?;
        let hover = h.frames(2.0)?;
        let drifting = h.pending()?;
        h.press(button_point())?;
        let press = h.frames(0.5)?;
        h.release(button_point())?;
        h.move_to(point(px(WINDOW_W - 4.0), px(WINDOW_H - 4.0)))?;
        let settle_frames = h.frames(0.6)?;
        std::thread::sleep(Duration::from_millis(400));
        h.draw()?;
        h.draw()?;
        let after = h.pending()?;
        // A hovered rim only drifts (one tile in 15s), so it is redrawn about
        // 30 times a second, not on every refresh: what that costs a core.
        let interval = anim::interval_for(dr_ui::glass::FLOW_PX_PER_S)
            .map_or(1000.0 / 120.0, |d| d.as_secs_f32() * 1000.0);
        out.push(format!(
            r#""hover_drift": {{"frame_ms": {}, "next_frame_requests_while_drifting": {}, "redraw_interval_ms": {:.1}, "core_share_p50": {:.3}}}"#,
            summary(&hover),
            drifting,
            interval,
            percentile(&hover, 0.5) / interval
        ));
        out.push(format!(r#""press": {{"frame_ms": {}}}"#, summary(&press)));
        out.push(format!(
            r#""release_and_leave": {{"frame_ms": {}, "frame_requests_after": {}}}"#,
            summary(&settle_frames),
            after
        ));
        let json = format!(
            "{{\n  \"note\": \"CPU time of window.draw (layout + paint) per frame, release build, 1280x800 at 2x, headless Metal\",\n  {}\n}}\n",
            out.join(",\n  ")
        );
        std::fs::write(&file, json)?;
        println!("wrote {}", file.display());
        Ok(())
    }
}
