//! The 构想 panel (M16) drawn offscreen, light and dark, into `<dir>/m16/`:
//!
//! ```text
//! cargo run -p dr-view-ideas --features capture --example ideas-capture -- ../docs/rust-rewrite/modules
//! ```
//!
//! GPUI runs headless (its test platform with the real macOS text system and
//! Metal drawing into a texture): nothing opens on screen. The library is
//! dr-testkit's 《阿Q正传》, seeded into a temporary folder, given a group
//! 「结构」 with a sub-group 「细节」 and a group 「别处」 through F3, two
//! ideas moved into them and one resting. A workspace window opens the
//! book; the panel and its head fill a window as wide as a sidebar.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_ui::{Appearance, theme};
use dr_view_ideas::{IdeaPanel, PanelHead};
use dr_workspace::Actor;
use gpui::{AnyWindowHandle, AppContext as _, Entity, HeadlessAppContext, Render, px, size};

const W: f32 = 300.0;
const H: f32 = 560.0;
const VERSION: &str = "0.2.0-dev";

struct Headless {
    cx: HeadlessAppContext,
    library: dr_workspace::Workspace,
    book: String,
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
        let book = dr_testkit::samples::a_q()?;
        dr_testkit::seed::write_book(&lib, &book).map_err(|e| anyhow::anyhow!("{e}"))?;
        let book_id = book.book_id().to_string();
        lib.close()?;
        let library = dr_workspace::Workspace::open_dir(&root, VERSION)?;
        let services_lib = library.clone();
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
                library: Some(services_lib),
                ..Services::default()
            };
            dr_shell::init(info, services, file, cx);
            dr_view_ideas::init(cx);
            Ok(())
        })?;
        Ok(Headless {
            cx,
            library,
            book: book_id,
            _dir: dir,
        })
    }

    fn draw(&mut self, window: AnyWindowHandle) -> Result<()> {
        self.cx.update_window(window, |root, window, cx| {
            window.simulate_next_frame(cx);
            cx.notify(root.entity_id());
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

    fn settle(&mut self, window: AnyWindowHandle) -> Result<()> {
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(700) {
            self.draw(window)?;
            self.cx.run_until_parked();
            std::thread::sleep(Duration::from_millis(16));
        }
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

    fn close(&mut self, window: AnyWindowHandle) {
        self.cx
            .update_window(window, |_, window, _| window.remove_window())
            .ok();
        self.cx.run_until_parked();
    }
}

/// The head over the list, on the sidebar's ground, as the shell lays a
/// module's panel out.
struct Sidebar {
    head: Entity<PanelHead>,
    list: Entity<IdeaPanel>,
}

impl Render for Sidebar {
    fn render(
        &mut self,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        use gpui::{ParentElement as _, Styled as _};
        let p = dr_ui::Theme::of(window, cx).palette;
        gpui::div()
            .size_full()
            .bg(p.desk.solid())
            .flex()
            .flex_col()
            .child(
                gpui::div()
                    .h(px(34.0))
                    .px(px(12.0))
                    .child(self.head.clone()),
            )
            .child(gpui::div().flex_1().min_h_0().child(self.list.clone()))
    }
}

fn capture(dir: PathBuf) -> Result<()> {
    let mut h = Headless::new()?;
    let out = dir.join("m16");
    // Groups, two ideas in them, one resting.
    let lib = h.library.clone();
    let book = h.book.clone();
    let a = dr_view_ideas::data::create_group(&lib, &book, "结构", None)?;
    let b = dr_view_ideas::data::create_group(&lib, &book, "细节", Some(&a))?;
    dr_view_ideas::data::create_group(&lib, &book, "别处", None)?;
    let list = lib.call(
        &Actor::User,
        "idea.list",
        serde_json::json!({ "book": book }),
    )?;
    let ids: Vec<String> = list["output"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|i| i["id"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    if ids.len() >= 3 {
        dr_view_ideas::data::move_idea(&lib, &book, &ids[0], Some(&a))?;
        dr_view_ideas::data::move_idea(&lib, &book, &ids[1], Some(&b))?;
        dr_view_ideas::data::set_status(&lib, &book, &ids[2], "resting")?;
    }
    let ws_window =
        h.cx.open_window(size(px(1200.0), px(800.0)), |window, cx| {
            cx.new(|cx| Workspace::new(window, cx))
        })?;
    let ws = ws_window.entity(&h.cx)?;
    let ws_any: AnyWindowHandle = ws_window.into();
    h.wait(ws_any, |h| h.cx.update(|cx| !ws.read(cx).book.is_empty()))?;
    for (appearance, suffix) in [(Appearance::Light, "light"), (Appearance::Dark, "dark")] {
        h.cx.update(|cx| theme::force_appearance(Some(appearance), cx));
        let weak = ws.downgrade();
        let window = h.cx.open_window(size(px(W), px(H)), move |_, cx| {
            let (list, head) = dr_view_ideas::make_panel(weak, cx);
            cx.new(|_| Sidebar { head, list })
        })?;
        let root = window.entity(&h.cx)?;
        let panel = h.cx.update(|cx| root.read(cx).list.clone());
        let window: AnyWindowHandle = window.into();
        h.wait(window, |h| {
            h.cx.update(|cx| panel.read(cx).tree().group_ids().len() == 3)
        })?;

        // The panel: 结构 with 细节 under it, 别处, the loose ideas (one
        // resting, muted).
        h.settle(window)?;
        h.save(window, &out, &format!("ideas-panel-{suffix}.png"))?;

        // 结构's card.
        h.cx.update(|cx| panel.update(cx, |p, cx| p.show_card(Some(a.clone()), cx)));
        h.settle(window)?;
        h.save(window, &out, &format!("ideas-group-card-{suffix}.png"))?;
        h.cx.update(|cx| panel.update(cx, |p, cx| p.show_card(None, cx)));

        // The sort menu.
        h.cx.update(|cx| {
            panel.update(cx, |p, cx| {
                p.sort_open = true;
                cx.notify();
            })
        });
        h.settle(window)?;
        h.save(window, &out, &format!("ideas-sort-{suffix}.png"))?;
        h.cx.update(|cx| {
            panel.update(cx, |p, cx| {
                p.sort_open = false;
                cx.notify();
            })
        });

        // Renaming 别处 in place.
        let other = h.cx.update(|cx| {
            panel
                .read(cx)
                .tree()
                .groups
                .iter()
                .find(|n| n.group.name == "别处")
                .map(|n| n.group.id.clone())
        });
        if let Some(other) = other {
            h.cx.update_window(window, |_, window, cx| {
                panel.update(cx, |p, cx| p.start_rename(&other, window, cx))
            })
            .ok();
            h.settle(window)?;
            h.save(window, &out, &format!("ideas-rename-{suffix}.png"))?;
            h.cx.update(|cx| panel.update(cx, |p, cx| p.finish_rename(None, cx)));
        }

        // Every group folded.
        h.cx.update(|cx| panel.update(cx, |p, cx| p.toggle_all(cx)));
        h.settle(window)?;
        h.save(window, &out, &format!("ideas-folded-{suffix}.png"))?;
        h.close(window);
    }
    Ok(())
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let Some(dir) = args.next() else {
        bail!("usage: ideas-capture <docs/rust-rewrite/modules>");
    };
    capture(PathBuf::from(dir))
}
