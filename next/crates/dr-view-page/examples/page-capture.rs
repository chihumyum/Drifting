//! The chapter page (M03) drawn offscreen in the shell: screenshots into
//! `<dir>/m03/`, light and dark.
//!
//! GPUI runs headless (its test platform with the real macOS text system
//! and Metal drawing into a texture): nothing opens on screen. The library
//! is dr-testkit's showcase; 《慢钟》 (with its acts) gets an empty chapter
//! after its first one, through F3's commands.
//!
//! ```text
//! cargo run -p dr-view-page --features capture --example page-capture -- ../docs/rust-rewrite/modules
//! ```

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail};
use dr_shell::nav::{Open, Target};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_ui::{Appearance, theme};
use dr_workspace::Actor;
use gpui::{AnyWindowHandle, AppContext as _, Context, Entity, HeadlessAppContext, px, size};
use serde_json::{Value, json};

const W: f32 = 1280.0;
const H: f32 = 800.0;
const VERSION: &str = "0.2.0-dev";

fn call(ws: &dr_workspace::Workspace, name: &str, input: Value) -> Result<Value> {
    Ok(ws.call(&Actor::User, name, input)?["output"].clone())
}

/// The showcase in a temporary library, 《慢钟》 with an empty chapter after
/// its first. Returns the book, its first chapter
/// and the empty one.
fn library() -> Result<(
    tempfile::TempDir,
    dr_workspace::Workspace,
    String,
    String,
    String,
)> {
    let dir = tempfile::tempdir()?;
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION))?;
    for book in dr_testkit::samples::showcase(dr_testkit::seed::DEFAULT_SEED)? {
        dr_testkit::seed::write_book(&lib, &book).map_err(|e| anyhow::anyhow!("{e}"))?;
    }
    lib.close()?;
    let ws = dr_workspace::Workspace::open_dir(&root, VERSION)?;
    ws.library().rebuild_stale_indexes()?;
    let books = call(&ws, "book.list", json!({}))?;
    let book = books
        .as_array()
        .into_iter()
        .flatten()
        .find(|b| b["name"].as_str() == Some("慢钟"))
        .and_then(|b| b["id"].as_str())
        .context("《慢钟》 is in the showcase")?
        .to_owned();
    let chapters = call(&ws, "chapter.list", json!({ "book": book }))?;
    let first = chapters[0]["id"].as_str().context("a chapter")?.to_owned();
    // 《慢钟》 has its acts; a book without gets one at its head.
    if call(&ws, "act.list", json!({ "book": book }))?
        .as_array()
        .is_none_or(|a| a.is_empty())
    {
        call(
            &ws,
            "act.create",
            json!({ "book": book, "name": "停摆之年" }),
        )?;
    }
    let empty = call(
        &ws,
        "chapter.create",
        json!({ "book": book, "title": "无人来取的那只钟", "place": { "after": first } }),
    )?["id"]
        .as_str()
        .context("the new chapter")?
        .to_owned();
    Ok((dir, ws, book, first, empty))
}

struct Headless {
    cx: HeadlessAppContext,
    window: AnyWindowHandle,
    view: Entity<Workspace>,
}

impl Headless {
    fn draw(&mut self) -> Result<()> {
        let view = self.view.clone();
        self.cx.update_window(self.window, |_, window, cx| {
            window.simulate_next_frame(cx);
            view.update(cx, |_, cx| cx.notify());
            window.draw(cx).clear(cx);
        })
    }

    fn wait(&mut self, what: &str, done: impl Fn(&mut Headless) -> bool) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            self.draw()?;
            self.cx.run_until_parked();
            if done(self) {
                return Ok(());
            }
            if Instant::now() > deadline {
                bail!("timed out waiting for {what}");
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// A little over the longest motion, reading F3 meanwhile.
    fn settle(&mut self) -> Result<()> {
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(700) {
            self.draw()?;
            self.cx.run_until_parked();
            std::thread::sleep(Duration::from_millis(16));
        }
        Ok(())
    }

    fn set(&mut self, f: impl FnOnce(&mut Workspace, &mut gpui::Window, &mut Context<Workspace>)) {
        let view = self.view.clone();
        self.cx
            .update_window(self.window, |_, window, cx| {
                view.update(cx, |ws, cx| f(ws, window, cx))
            })
            .ok();
    }

    fn page_ready(&mut self, doc: &str) -> bool {
        self.cx
            .update(|cx| dr_view_page::page_views(doc, cx).is_some())
    }

    fn save(&mut self, dir: &std::path::Path, name: &str) -> Result<()> {
        self.settle()?;
        let image = self.cx.capture_screenshot(self.window)?;
        image.save(dir.join(name))?;
        println!("wrote {name}");
        Ok(())
    }
}

fn main() -> Result<()> {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .unwrap_or_else(|| "../docs/rust-rewrite/modules".into()),
    );
    let dir = root.join("m03");
    std::fs::create_dir_all(&dir)?;
    let (_lib_dir, library, book, first, empty) = library()?;
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
        let services = Services {
            library: Some(library),
            ..Services::default()
        };
        dr_shell::init(info, services, file, cx);
        dr_view_page::init(cx);
        Ok(())
    })?;
    let window = cx.open_window(size(px(W), px(H)), |window, cx| {
        cx.new(|cx| Workspace::new(window, cx))
    })?;
    let view = window.entity(&cx)?;
    let mut h = Headless {
        cx,
        window: window.into(),
        view,
    };
    let id = book.clone();
    h.set(move |ws, window, cx| ws.open_book(&id, window, cx));
    h.wait("the book", |h| {
        let view = h.view.clone();
        h.cx.update(|cx| view.read(cx).book.id == book)
    })?;
    let chapter = |id: &str| Target::from_key(&format!("chapter:{id}")).expect("a chapter");
    let (first_doc, empty_doc) = (format!("node:{first}"), format!("node:{empty}"));
    for appearance in [Appearance::Light, Appearance::Dark] {
        h.cx.update(|cx| theme::force_appearance(Some(appearance), cx));
        let a = appearance.slug();
        // A chapter's head: the folio, the title, the synopsis, the rule.
        let target = chapter(&first);
        h.set(move |ws, _, cx| ws.open(target, Open::KEEP, cx));
        h.wait("the first chapter's page", |h| h.page_ready(&first_doc))?;
        h.save(&dir, &format!("page-head-{a}.png"))?;
        // An empty chapter: the hint, and ⁂ turned into its actions.
        let target = chapter(&empty);
        h.set(move |ws, _, cx| ws.open(target, Open::KEEP, cx));
        h.wait("the empty chapter's page", |h| h.page_ready(&empty_doc))?;
        h.settle()?;
        let doc = empty_doc.clone();
        h.cx.update_window(h.window, |_, window, cx| {
            if let Some((_, end)) = dr_view_page::page_views(&doc, cx) {
                end.update(cx, |e, cx| e.open_actions(window, cx));
            }
        })
        .ok();
        h.save(&dir, &format!("page-empty-{a}.png"))?;
        // The whole book: the act's title page above its first chapter.
        h.set(|ws, _, cx| ws.open(Target::Book, Open::KEEP, cx));
        h.settle()?;
        h.save(&dir, &format!("page-book-{a}.png"))?;
    }
    Ok(())
}
