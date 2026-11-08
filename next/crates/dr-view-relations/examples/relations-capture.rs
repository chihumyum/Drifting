//! Relations and relation types (M17) drawn offscreen, light and dark, into
//! `<dir>/m17/`:
//!
//! ```text
//! cargo run -p dr-view-relations --features capture --example relations-capture -- ../docs/rust-rewrite/modules
//! ```
//!
//! GPUI runs headless (its test platform with the real macOS text system and
//! Metal drawing into a texture): nothing opens on screen. The library is
//! dr-testkit's 《阿Q正传》, seeded into a temporary folder and read through
//! F3. A workspace window opens the book (the section takes the names from
//! it); 阿Q's 「关联」 fills a window of its own, as wide as the paper (the
//! element page does not host it yet).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_ui::{Appearance, theme};
use dr_view_relations::model::{Filter, end};
use dr_view_relations::{DeleteTypeDialog, MenuFor, Relations};
use dr_workspace::Actor;
use gpui::{AnyWindowHandle, AppContext as _, Entity, HeadlessAppContext, Render, px, size};

const W: f32 = 820.0;
const H: f32 = 760.0;
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
            Ok(())
        })?;
        Ok(Headless {
            cx,
            library,
            book: book_id,
            _dir: dir,
        })
    }

    fn element(&self, name: &str) -> Result<String> {
        let list = self.library.call(
            &Actor::User,
            "element.list",
            serde_json::json!({ "book": self.book }),
        )?;
        list["output"]
            .as_array()
            .and_then(|a| a.iter().find(|e| e["name"] == name))
            .and_then(|e| e["id"].as_str())
            .map(str::to_owned)
            .ok_or_else(|| anyhow::anyhow!("{name} in the book"))
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

    /// Draws for a little over the longest motion (520 ms).
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

/// The delete question as a window of its own (the shell shows it over the
/// workspace).
struct Dialog(Entity<DeleteTypeDialog>);

impl Render for Dialog {
    fn render(
        &mut self,
        _: &mut gpui::Window,
        _: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        self.0.clone()
    }
}

/// The section scrolled to its top inside a page-coloured window.
struct Page(Entity<Relations>);

impl Render for Page {
    fn render(
        &mut self,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        use gpui::{ParentElement as _, Styled as _};
        let p = dr_ui::Theme::of(window, cx).palette;
        gpui::div()
            .size_full()
            .bg(p.page.solid())
            .pt(px(4.0))
            .child(self.0.clone())
    }
}

fn capture(dir: PathBuf) -> Result<()> {
    let mut h = Headless::new()?;
    let out = dir.join("m17");
    let aq = end("element", &h.element("阿Q")?);
    let baiyan = end("element", &h.element("赵白眼")?);
    let tuguci = h.element("土谷祠")?;
    // The workspace opens the book; the section reads its names.
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
        let owner = aq.clone();
        let window = h.cx.open_window(size(px(W), px(H)), move |window, cx| {
            let r = cx.new(|cx| Relations::new(owner, weak, window, cx));
            cx.new(|_| Page(r))
        })?;
        let page = window.entity(&h.cx)?;
        let view = h.cx.update(|cx| page.read(cx).0.clone());
        let window: AnyWindowHandle = window.into();
        h.cx.update_window(window, |_, window, _| window.activate_window())
            .ok();
        h.wait(window, |h| h.cx.update(|cx| view.read(cx).is_loaded()))?;

        // 阿Q's cards.
        h.settle(window)?;
        h.save(window, &out, &format!("relations-cards-{suffix}.png"))?;

        // A card's type menu (阿Q → 土谷祠, 住在).
        let row = h.cx.update(|cx| {
            view.read(cx)
                .rows()
                .iter()
                .find(|r| r.other.id == tuguci)
                .map(|r| r.id.clone())
        });
        if let Some(row) = row {
            h.cx.update(|cx| view.update(cx, |r, cx| r.toggle_menu(MenuFor::Row(row), cx)));
            h.settle(window)?;
            h.save(window, &out, &format!("relations-type-menu-{suffix}.png"))?;
            h.cx.update(|cx| view.update(cx, |r, cx| r.toggle_menu(MenuFor::Pending, cx)));
            h.cx.update(|cx| view.update(cx, |r, cx| r.toggle_menu(MenuFor::Pending, cx)));
        }

        // The picker: 要素, 「赵」, 赵白眼 → 阿Q waiting for 欺辱.
        let bully = h.cx.update(|cx| {
            view.read(cx)
                .types()
                .iter()
                .find(|t| t.name == "欺辱")
                .map(|t| t.id.clone())
        });
        h.cx.update(|cx| {
            view.update(cx, |r, cx| {
                r.set_picking(true, cx);
                r.set_filter(Filter::Element, cx);
                r.query_field().update(cx, |q, cx| q.set_text("赵", cx));
                r.choose(baiyan.clone(), cx);
                r.reverse_pending(cx);
                if let Some(id) = &bully {
                    r.set_pending_type(id, cx);
                }
            })
        });
        h.settle(window)?;
        h.save(window, &out, &format!("relations-picker-{suffix}.png"))?;
        h.cx.update(|cx| view.update(cx, |r, cx| r.set_picking(false, cx)));

        // The types.
        h.cx.update_window(window, |_, window, cx| {
            view.update(cx, |r, cx| r.toggle_manager(window, cx))
        })
        .ok();
        let m = h.cx.update(|cx| view.read(cx).manager()).expect("open");
        h.wait(window, |h| h.cx.update(|cx| m.read(cx).is_loaded()))?;
        h.settle(window)?;
        h.save(window, &out, &format!("relations-types-{suffix}.png"))?;

        // A colour row.
        let first = h.cx.update(|cx| {
            m.read(cx)
                .types()
                .iter()
                .find(|t| t.name == "冤家")
                .map(|t| t.id.clone())
        });
        if let Some(id) = first.clone() {
            h.cx.update(|cx| m.update(cx, |m, cx| m.toggle_colors(&id, cx)));
            h.settle(window)?;
            h.save(window, &out, &format!("relations-colors-{suffix}.png"))?;
            h.cx.update(|cx| m.update(cx, |m, cx| m.toggle_colors(&id, cx)));
        }

        // A new type's editor.
        h.cx.update_window(window, |_, window, cx| {
            m.update(cx, |m, cx| m.start_new(None, window, cx))
        })
        .ok();
        h.settle(window)?;
        h.save(window, &out, &format!("relations-editor-{suffix}.png"))?;
        h.cx.update(|cx| m.update(cx, |m, cx| m.cancel(cx)));
        h.cx.update(|cx| view.update(cx, |r, cx| r.close_manager(cx)));

        // The delete question.
        if let Some(id) = first {
            let (lib, book) = (h.library.clone(), h.book.clone());
            let dialog = h.cx.open_window(size(px(W), px(420.0)), move |_, cx| {
                let d = cx.new(|cx| DeleteTypeDialog::new(lib, book, id, "冤家".into(), cx));
                cx.new(|_| Dialog(d))
            })?;
            let dialog: AnyWindowHandle = dialog.into();
            h.settle(dialog)?;
            h.save(dialog, &out, &format!("relations-delete-{suffix}.png"))?;
            h.close(dialog);
        }
        h.close(window);
    }
    Ok(())
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let Some(dir) = args.next() else {
        bail!("usage: relations-capture <docs/rust-rewrite/modules>");
    };
    capture(PathBuf::from(dir))
}
