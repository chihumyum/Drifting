//! `DRIFTING_CHECK=editor` / `editor-verify`: development builds only. The
//! app drives its own window the way the author would, to check the editor
//! in the real app (F6's third milestone):
//!
//! - `editor`: open the book's first chapter, type 「编辑器验收」, Enter,
//!   「第二段」 (the text through the editor's input handler, the entry point
//!   the system's input method uses; Enter, ⌘Z, ⌘⇧Z and ⌘[ as keystrokes
//!   through the keymap), undo it all and redo it, open the second chapter
//!   and go back, read the book's word count and the search hits, then quit
//!   through the quit flow;
//! - `editor-verify`: after a restart, find the first chapter open again
//!   with the text in it, delete it again (selected and Backspace) and quit.
//!
//! Each run prints one line per step to stderr and exits with the app;
//! a failed step prints `check failed` and quits too.

use std::time::{Duration, Instant};

use dr_shell::Workspace;
use dr_shell::nav::{Open, Target};
use dr_shell::workspace::editors::ChapterEditor;
use dr_workspace::Actor;
use gpui::{
    AnyWindowHandle, App, AppContext as _, AsyncApp, Entity, EntityInputHandler, Focusable as _,
    Keystroke, WindowHandle,
};
use serde_json::{Value, json};

pub const CHECK_ENV: &str = "DRIFTING_CHECK";

const FIRST: &str = "编辑器验收";
const SECOND: &str = "第二段";

/// Starts the check `DRIFTING_CHECK` names, if any (debug builds only).
pub fn start(cx: &mut App) {
    if !cfg!(debug_assertions) {
        return;
    }
    let verify = match std::env::var(CHECK_ENV).ok().as_deref() {
        Some("editor") => false,
        Some("editor-verify") => true,
        _ => return,
    };
    cx.spawn(async move |cx| {
        let result = if verify {
            verify_run(cx).await
        } else {
            write_run(cx).await
        };
        match result {
            Ok(()) => eprintln!("check passed"),
            Err(error) => eprintln!("check failed: {error}"),
        }
        cx.update(dr_shell::quit::request);
    })
    .detach();
}

type Check<T> = Result<T, String>;

async fn pause(cx: &AsyncApp, ms: u64) {
    cx.background_executor()
        .timer(Duration::from_millis(ms))
        .await;
}

/// Polls `f` on the main thread every 20 ms until it gives a value, at most
/// `secs` seconds.
async fn until<T>(
    cx: &mut AsyncApp,
    what: &str,
    secs: u64,
    mut f: impl FnMut(&mut App) -> Option<T>,
) -> Check<T> {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Some(v) = cx.update(&mut f) {
            return Ok(v);
        }
        if Instant::now() > deadline {
            return Err(format!("timed out waiting for {what}"));
        }
        pause(cx, 20).await;
    }
}

fn workspace(cx: &App) -> Option<WindowHandle<Workspace>> {
    cx.windows()
        .into_iter()
        .find_map(|w| w.downcast::<Workspace>())
}

fn library(cx: &App) -> Option<dr_workspace::Workspace> {
    cx.try_global::<dr_shell::Services>()
        .and_then(|s| s.library.clone())
}

fn read_ws<T>(cx: &mut App, f: impl FnOnce(&Workspace, &App) -> T) -> Option<T> {
    let handle = workspace(cx)?;
    handle.read_with(cx, |ws, cx| f(ws, cx)).ok()
}

fn out(lib: &dr_workspace::Workspace, name: &str, input: Value) -> Check<Value> {
    lib.call(&Actor::User, name, input)
        .map(|v| v["output"].clone())
        .map_err(|e| format!("{name}: {e}"))
}

fn stored(lib: &dr_workspace::Workspace, doc: &str) -> Check<Vec<String>> {
    Ok(out(lib, "prose.read", json!({"doc": doc}))?["paragraphs"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| p["text"].as_str().unwrap_or_default().to_owned())
        .collect())
}

/// The book's word count and the search hits, once F2 has indexed the open
/// documents (the quit hook makes it now) and the stale rest (F2 catches
/// those up only after 500 ms without a write, and these reads come sooner).
fn counted(lib: &dr_workspace::Workspace, book: &str) -> Check<(u64, usize)> {
    lib.before_quit();
    lib.library()
        .rebuild_stale_indexes()
        .map_err(|e| format!("stale indexes: {e}"))?;
    let words = out(lib, "book.get", json!({"book": book}))?["words"]
        .as_u64()
        .unwrap_or(0);
    let hits = out(lib, "book.search", json!({"book": book, "query": FIRST}))?;
    let hits = hits
        .as_array()
        .or_else(|| hits["hits"].as_array())
        .map_or(0, Vec::len);
    Ok((words, hits))
}

/// The book is read; its id and first two chapters.
async fn book(cx: &mut AsyncApp) -> Check<(String, Target, Target)> {
    // Without DRIFTING_BOOK the window opens on the bookshelf: open the
    // book opened last, else the library's first.
    until(cx, "the window", 30, |cx| {
        let handle = workspace(cx)?;
        let shelf = handle.read_with(cx, |ws, _| ws.shelf_open).ok()?;
        if shelf {
            let lib = library(cx)?;
            let last = dr_shell::Settings::read(cx).last_book().map(str::to_owned);
            let ids: Vec<String> = lib
                .library()
                .docs(None, Some("book"))
                .ok()?
                .into_iter()
                .filter_map(|d| d.doc_id.strip_prefix("book:").map(str::to_owned))
                .collect();
            let id = last
                .filter(|l| ids.contains(l))
                .or_else(|| ids.first().cloned())?;
            eprintln!("check: on the bookshelf; opening a book");
            handle
                .update(cx, |ws, window, cx| ws.open_book(&id, window, cx))
                .ok()?;
        }
        Some(())
    })
    .await?;
    until(cx, "the book", 30, |cx| {
        read_ws(cx, |ws, _| {
            (ws.book.chapters.len() >= 2).then(|| {
                let chapter = |i: usize| -> Option<Target> {
                    ws.book.chapters[i].id.parse().ok().map(Target::Chapter)
                };
                Some((ws.book_id.clone(), chapter(0)?, chapter(1)?))
            })?
        })
        .flatten()
    })
    .await
}

/// `target`'s editor, open and holding the keyboard.
async fn focused_editor(cx: &mut AsyncApp, target: &Target) -> Check<Entity<ChapterEditor>> {
    let target = target.clone();
    until(cx, "the editor", 10, move |cx| {
        let handle = workspace(cx)?;
        let editor = handle
            .read_with(cx, |ws, _| ws.editor_of(&target).cloned())
            .ok()??;
        let focused = handle
            .update(cx, |_, window, cx| {
                let prose = editor.read(cx).editor().focus_handle(cx);
                window.focused(cx) == Some(prose)
            })
            .ok()?;
        focused.then_some(editor)
    })
    .await
}

fn window_of(cx: &mut AsyncApp) -> Check<AnyWindowHandle> {
    cx.update(|cx| workspace(cx).map(Into::into))
        .ok_or_else(|| "no workspace window".to_owned())
}

/// Types `text` through the focused editor's input handler.
async fn type_text(cx: &mut AsyncApp, editor: &Entity<ChapterEditor>, text: &str) -> Check<()> {
    let window = window_of(cx)?;
    for c in text.chars() {
        let s = c.to_string();
        let editor = editor.clone();
        cx.update_window(window, move |_, window, cx| {
            let prose = editor.read(cx).editor().clone();
            prose.update(cx, |p, cx| p.replace_text_in_range(None, &s, window, cx));
        })
        .map_err(|e| e.to_string())?;
        pause(cx, 15).await;
    }
    Ok(())
}

/// A keystroke through the window's keymap (`enter`, `cmd-z` …).
async fn press(cx: &mut AsyncApp, keys: &'static str) -> Check<()> {
    let window = window_of(cx)?;
    let keystroke = Keystroke::parse(keys).map_err(|e| format!("{keys}: {e}"))?;
    cx.update_window(window, move |_, window, cx| {
        window.dispatch_keystroke(keystroke, cx);
    })
    .map_err(|e| e.to_string())?;
    pause(cx, 30).await;
    Ok(())
}

async fn press_until(
    cx: &mut AsyncApp,
    keys: &'static str,
    lib: &dr_workspace::Workspace,
    doc: &str,
    want: &[String],
) -> Check<usize> {
    for n in 0..16 {
        if stored(lib, doc)? == want {
            return Ok(n);
        }
        press(cx, keys).await?;
    }
    Err(format!("{keys} never reached {want:?}"))
}

fn open(cx: &mut AsyncApp, target: &Target) -> Check<()> {
    let target = target.clone();
    cx.update(|cx| {
        let handle = workspace(cx).ok_or("no workspace window")?;
        handle
            .update(cx, |ws, _, cx| ws.open(target, Open::KEEP, cx))
            .map_err(|e| e.to_string())
    })
}

fn doc_of(target: &Target) -> String {
    match target {
        Target::Chapter(id) => format!("node:{id}"),
        other => other.key(),
    }
}

async fn write_run(cx: &mut AsyncApp) -> Check<()> {
    let started = Instant::now();
    let (book, first, second) = book(cx).await?;
    let lib = cx.update(|cx| library(cx)).ok_or("no library")?;
    let doc = doc_of(&first);
    let original = stored(&lib, &doc)?;
    let (words_before, hits_before) = counted(&lib, &book)?;
    eprintln!("check: book read; {words_before} words, 「{FIRST}」 {hits_before} hits");

    open(cx, &first)?;
    let editor = focused_editor(cx, &first).await?;
    eprintln!("check: first chapter open in its editor, focused");
    type_text(cx, &editor, FIRST).await?;
    press(cx, "enter").await?;
    type_text(cx, &editor, SECOND).await?;
    let written = stored(&lib, &doc)?;
    if written.first().map(String::as_str) != Some(FIRST)
        || !written.get(1).is_some_and(|p| p.starts_with(SECOND))
    {
        return Err(format!("typed text not stored: {:?}", &written[..2]));
    }
    eprintln!(
        "check: typed and Enter stored ({} paragraphs)",
        written.len()
    );
    let undos = press_until(cx, "cmd-z", &lib, &doc, &original).await?;
    eprintln!("check: ⌘Z ×{undos} took it back");
    let redos = press_until(cx, "cmd-shift-z", &lib, &doc, &written).await?;
    eprintln!("check: ⌘⇧Z ×{redos} brought it again");

    open(cx, &second)?;
    focused_editor(cx, &second).await?;
    press(cx, "cmd-[").await?;
    let back = focused_editor(cx, &first).await?;
    if back != editor {
        return Err("going back opened a new editor".into());
    }
    let text = cx.update(|cx| back.read(cx).plain_text(cx));
    if !text.starts_with(&format!("{FIRST}\n{SECOND}")) {
        return Err("the first chapter lost its text after switching".into());
    }
    eprintln!("check: another chapter and back (⌘[), same editor, text kept");
    let (words, hits) = counted(&lib, &book)?;
    eprintln!("check: {words_before} → {words} words, 「{FIRST}」 {hits_before} → {hits} hits");
    if words != words_before + (FIRST.chars().count() + SECOND.chars().count()) as u64 || hits == 0
    {
        return Err("search or the word count did not follow".into());
    }
    eprintln!(
        "check: done in {:.1} s; quitting",
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

async fn verify_run(cx: &mut AsyncApp) -> Check<()> {
    let (book, first, _) = book(cx).await?;
    let lib = cx.update(|cx| library(cx)).ok_or("no library")?;
    let doc = doc_of(&first);
    let page = cx.update(|cx| read_ws(cx, |ws, _| ws.nav.page()));
    eprintln!("check: reopened on {page:?}");
    let editor = focused_editor(cx, &first).await?;
    let text = cx.update(|cx| editor.read(cx).plain_text(cx));
    let kept = format!("{FIRST}\n{SECOND}");
    if !text.starts_with(&kept) {
        return Err("the text typed before the restart is not there".into());
    }
    let (words_before, _) = counted(&lib, &book)?;
    eprintln!("check: the text came back after the restart");
    // Take it out again: select it and Backspace.
    let window = window_of(cx)?;
    let len = kept.chars().count();
    let ed = editor.clone();
    cx.update_window(window, move |_, window, cx| {
        let prose = ed.read(cx).editor().clone();
        prose.update(cx, |p, cx| p.select(0, 0..len, window, cx));
    })
    .map_err(|e| e.to_string())?;
    press(cx, "backspace").await?;
    let now = stored(&lib, &doc)?;
    if now
        .first()
        .is_some_and(|p| p.starts_with(FIRST) || p.starts_with(SECOND))
    {
        return Err(format!("not deleted: {:?}", now.first()));
    }
    let (words, hits) = counted(&lib, &book)?;
    eprintln!("check: deleted again; {words_before} → {words} words, {hits} hits");
    Ok(())
}
