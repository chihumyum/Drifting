//! Drifting's editor on a real library: the showcase seed, one chapter in a
//! window, every keystroke persisted through the workspace.
//!
//! ```text
//! cargo run -p dr-editor --example edit                 # a window
//! cargo run -p dr-editor --example edit -- --check      # no window: edit, close, reopen, verify
//! cargo run -p dr-editor --example edit -- --fresh      # seed the library again first
//! cargo run -p dr-editor --example edit -- --search 钟   # the word the status line searches for
//! ```
//!
//! The library lives in the development build's data directory (its own
//! folder, `dr-editor-example`, next to the app's `library`); the first run
//! writes `dr_testkit::seed`'s showcase preset into it. The window's status
//! line shows the book's word count and the search hits for `--search`, read
//! from the workspace once a second: they follow the typing once F2 has
//! indexed the open chapter (it does that when the document goes idle).
//! Close the window and run it again: the text is still there.

use std::path::{Path, PathBuf};
use std::time::Duration;

use dr_editor::{ChapterEditor, EditorSettings, SessionSource};
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace};
use gpui::{
    App, AppContext, Bounds, Context, Entity, Focusable, KeyBinding, Render, SharedString, Window,
    WindowBounds, WindowOptions, actions, div, prelude::*, px, size,
};
use gpui_prose::text::{ORIGIN_USER, ProseDoc};
use serde_json::{Value, json};

actions!(dr_editor_example, [Quit]);

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn out(ws: &Workspace, name: &str, input: Value) -> Result<Value, String> {
    ws.call(&Actor::User, name, input)
        .map(|v| v["output"].clone())
        .map_err(|e| format!("{name}: {e}"))
}

fn library_root() -> Result<PathBuf, String> {
    let dirs = dr_platform::AppDirs::for_identity(dr_platform::Identity::current())
        .map_err(|e| format!("data directory: {e}"))?;
    Ok(dirs.data.join("dr-editor-example"))
}

/// Writes the showcase seed into an empty library.
fn seed_if_empty(root: &Path, fresh: bool) -> Result<(), String> {
    if fresh && root.exists() {
        std::fs::remove_dir_all(root).map_err(|e| format!("remove {}: {e}", root.display()))?;
    }
    if root.join("library.sqlite").exists() {
        return Ok(());
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let seeded = seed::generate(Preset::Showcase, seed::DEFAULT_SEED).map_err(|e| e.to_string())?;
    let lib = dr_store::Library::open(root, dr_workspace::library_options(VERSION))
        .map_err(|e| e.to_string())?;
    let n = seeded.write_to(&lib).map_err(|e| e.to_string())?;
    lib.close().map_err(|e| e.to_string())?;
    eprintln!("seeded {n} documents (showcase) into {}", root.display());
    Ok(())
}

/// The first book with chapters, and its first chapter: `(book, doc, title)`.
fn pick_chapter(ws: &Workspace) -> Result<(String, String, String), String> {
    let books = out(ws, "book.list", json!({}))?;
    for b in books.as_array().into_iter().flatten() {
        let book = b["id"].as_str().unwrap_or_default().to_owned();
        let chapters = out(ws, "chapter.list", json!({"book": book}))?;
        if let Some(c) = chapters.as_array().and_then(|c| c.first()) {
            let id = c["id"].as_str().unwrap_or_default();
            let title = c["title"].as_str().unwrap_or_default().to_owned();
            return Ok((book, format!("node:{id}"), title));
        }
    }
    Err("no book with a chapter in the library".into())
}

fn words(ws: &Workspace, book: &str) -> u64 {
    out(ws, "book.get", json!({"book": book}))
        .ok()
        .and_then(|v| v["words"].as_u64())
        .unwrap_or(0)
}

fn hits(ws: &Workspace, book: &str, query: &str) -> usize {
    out(ws, "book.search", json!({"book": book, "query": query}))
        .ok()
        .and_then(|v| {
            v.as_array()
                .map(Vec::len)
                .or_else(|| v["hits"].as_array().map(Vec::len))
        })
        .unwrap_or(0)
}

/// The book's word count once F2's background indexing has settled (a
/// freshly seeded library is indexed after it opens).
fn settled_words(ws: &Workspace, book: &str) -> u64 {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let mut last = words(ws, book);
    loop {
        std::thread::sleep(Duration::from_millis(400));
        let now = words(ws, book);
        if (now == last && now > 0) || std::time::Instant::now() > deadline {
            return now;
        }
        last = now;
    }
}

fn first_paragraph(ws: &Workspace, doc: &str) -> Result<String, String> {
    Ok(
        out(ws, "prose.read", json!({"doc": doc}))?["paragraphs"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    )
}

/// No window: type into the chapter through the editor's text source, close
/// the workspace, open it again and check the text, the search index and the
/// word count; then take the edit out again the same way.
fn check(root: &Path) -> Result<(), String> {
    const PROBE: &str = "编辑器检查";
    let ws = Workspace::open_dir(root, VERSION).map_err(|e| e.to_string())?;
    let (book, doc_id, title) = pick_chapter(&ws)?;
    let before = first_paragraph(&ws, &doc_id)?;
    let words_before = settled_words(&ws, &book);
    {
        let source = SessionSource::open(&ws, &doc_id).map_err(|e| e.to_string())?;
        let mut doc = ProseDoc::open(Box::new(source));
        let end = doc.line(0).chars;
        doc.replace(end..end, PROBE, ORIGIN_USER);
    }
    ws.before_quit();
    ws.shutdown().map_err(|e| e.to_string())?;

    let ws = Workspace::open_dir(root, VERSION).map_err(|e| e.to_string())?;
    let after = first_paragraph(&ws, &doc_id)?;
    let found = hits(&ws, &book, PROBE);
    let words_after = settled_words(&ws, &book);
    println!("chapter      {title} ({doc_id})");
    println!("persisted    {}", after == format!("{before}{PROBE}"));
    println!("search hits  {found}");
    println!("words        {words_before} -> {words_after}");
    // dr-text counts each Chinese character as a word.
    let ok = after == format!("{before}{PROBE}")
        && found > 0
        && words_after == words_before + PROBE.chars().count() as u64;
    {
        let source = SessionSource::open(&ws, &doc_id).map_err(|e| e.to_string())?;
        let mut doc = ProseDoc::open(Box::new(source));
        let end = doc.line(0).chars;
        doc.delete(end - PROBE.chars().count()..end, ORIGIN_USER);
    }
    ws.before_quit();
    let restored = first_paragraph(&ws, &doc_id)? == before;
    ws.shutdown().map_err(|e| e.to_string())?;
    println!("restored     {restored}");
    if ok && restored {
        println!("ok");
        Ok(())
    } else {
        Err("the check failed".into())
    }
}

struct Root {
    ws: Workspace,
    book: String,
    title: String,
    query: String,
    editor: Entity<ChapterEditor>,
    status: SharedString,
}

impl Root {
    fn refresh_status(&mut self, cx: &mut Context<Self>) {
        let status = format!(
            "{} · {} words · “{}”: {} hits",
            self.title,
            words(&self.ws, &self.book),
            self.query,
            hits(&self.ws, &self.book, &self.query)
        );
        if status != self.status.as_ref() {
            self.status = status.into();
            cx.notify();
        }
    }
}

impl Render for Root {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(div().flex_1().child(self.editor.clone()))
            .child(
                div()
                    .px(px(16.))
                    .py(px(6.))
                    .text_size(px(12.))
                    .child(self.status.clone()),
            )
    }
}

fn window(root: PathBuf, query: String) -> Result<(), String> {
    let ws = Workspace::open_dir(&root, VERSION).map_err(|e| e.to_string())?;
    let (book, doc_id, title) = pick_chapter(&ws)?;
    eprintln!("editing {title} ({doc_id}) in {}", root.display());
    gpui_platform::application().run(move |cx: &mut App| {
        cx.bind_keys([KeyBinding::new("cmd-q", Quit, None)]);
        cx.on_action(|_: &Quit, cx| cx.quit());
        gpui_prose::bind_keys(cx);
        let bounds = Bounds::centered(None, size(px(900.), px(760.)), cx);
        let opened = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            |window, cx| {
                let editor = cx.new(|cx| {
                    ChapterEditor::open(
                        ws.clone(),
                        &book,
                        &doc_id,
                        EditorSettings::default(),
                        window,
                        cx,
                    )
                    .expect("open the chapter")
                });
                let focus = editor.read(cx).editor().read(cx).focus_handle(cx);
                window.focus(&focus, cx);
                cx.new(|cx| {
                    let mut root = Root {
                        ws: ws.clone(),
                        book: book.clone(),
                        title: title.clone(),
                        query: query.clone(),
                        editor,
                        status: SharedString::default(),
                    };
                    root.refresh_status(cx);
                    cx.spawn(async move |this, cx| {
                        loop {
                            cx.background_executor().timer(Duration::from_secs(1)).await;
                            if this.update(cx, |root, cx| root.refresh_status(cx)).is_err() {
                                break;
                            }
                        }
                    })
                    .detach();
                    root
                })
            },
        );
        if let Err(e) = opened {
            eprintln!("open the window: {e}");
            cx.quit();
        }
        cx.on_window_closed(|cx, _| cx.quit()).detach();
        cx.activate(true);
    });
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |f: &str| args.iter().any(|a| a == f);
    let query = args
        .iter()
        .position(|a| a == "--search")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_else(|| "钟".into());
    let run = || -> Result<(), String> {
        let root = library_root()?;
        seed_if_empty(&root, flag("--fresh"))?;
        if flag("--check") {
            check(&root)
        } else {
            window(root, query)
        }
    };
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
