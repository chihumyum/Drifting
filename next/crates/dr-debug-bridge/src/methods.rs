//! The bridge's methods. Each runs on GPUI's main thread.
//!
//! Input goes through the window the way the platform delivers it
//! (`Window::dispatch_keystroke` and `dispatch_event`), outside any
//! entity's update, so the handlers it reaches (the workspace's actions,
//! the editor's input handler) run as they would for a real key press.
//! Reads of the shell go through its public fields.

use std::time::{Duration, Instant};

use dr_debug_protocol::BridgeError;
use dr_debug_protocol::wire::codes;
use dr_shell::nav::{Open, Page, Target};
use dr_shell::workspace::{Item, Layer, title_of};
use dr_shell::{Services, ShellInfo, Workspace};
use dr_workspace::Actor;
use gpui::{
    AnyWindowHandle, App, AsyncApp, Context, Entity, Focusable as _, Keystroke, Modifiers,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PlatformInput, Window, WindowHandle,
    WindowVisibility, point, px,
};
use serde_json::{Value, json};

type Out = Result<Value, BridgeError>;

/// How long a screenshot waits for motion to end: dr-ui's longest
/// transition (the structural one, sidebars) is 420 ms.
const SETTLE_MS: u64 = 500;

/// Every method and what it does (`methods` answers this).
pub const METHODS: &[(&str, &str)] = &[
    (
        "app.info",
        "version, profile, pid, whether there is a library, and each window: active, visible (a covered window draws no frames), bounds",
    ),
    (
        "app.quit",
        "quit through the shell's quit flow (as ⌘Q), after answering",
    ),
    (
        "window.focus",
        "bring the workspace window to the front and activate the app",
    ),
    (
        "window.close",
        "close the workspace window (on macOS the app keeps running)",
    ),
    (
        "window.open",
        "open the workspace window again, or bring it forward",
    ),
    (
        "command.call",
        "{name, input?, actor?}: an F3 command or query on the window's library, as the author unless actor is agent:<session>/<turn>; answers F3's outcome {output, effects, undo, journal}",
    ),
    ("action.list", "every registered GPUI action's name"),
    (
        "action.dispatch",
        "{name, params?}: dispatch an action on the focused element, as its shortcut would",
    ),
    (
        "input.type",
        "{text}: type through GPUI's input path into the focused text field (a newline presses Enter); fails with no_input when nothing takes it",
    ),
    (
        "input.key",
        "{keys}: press keys, e.g. \"secondary-z\" or \"enter escape\" (space-separated; secondary is ⌘ on macOS, Ctrl elsewhere)",
    ),
    (
        "input.click",
        "{x, y, button?, count?}: click at a window position, in logical pixels",
    ),
    (
        "nav.open",
        "{target} (a page key: chapter:<id>, idea:<id>, …, book), {chapter} (an id or a title) or {link} (a location link): open it as a kept tab ({preview: true} for a preview)",
    ),
    (
        "book.open",
        "{book} (an id) or {name} (a name or an id): open a book as the bookshelf does (its saved tabs come back)",
    ),
    ("shelf.show", "show the bookshelf over the window (as ⇧⌘W)"),
    (
        "state.get",
        "the shell's state: book, bookshelf, page, tabs, sidebars, layers, focus (and whether the page's editor has it), the page's selection, the pages and editors open",
    ),
    (
        "page.text",
        "{target?}: the paragraphs a page shows (default: the page on the paper): a prose page's editor, or the whole book's rows",
    ),
    (
        "ui.wait",
        "{until: \"ready\", text?, state?, timeout_ms?}: wait until the book and the pages on screen are read, and the page shows text, and state.get has the values at the JSON pointers in state",
    ),
    (
        "ui.screenshot",
        "{settle_ms?}: the window as a PNG (base64), drawn from inside the app after the transitions settle (default 500 ms; the longest dr-ui motion is 420 ms); a covered window is drawn first",
    ),
    ("methods", "this list"),
];

fn bad(msg: impl Into<String>) -> BridgeError {
    BridgeError::new(codes::BAD_REQUEST, msg)
}

fn not_found(msg: impl Into<String>) -> BridgeError {
    BridgeError::new(codes::NOT_FOUND, msg)
}

fn string<'a>(p: &'a Value, key: &str) -> Result<&'a str, BridgeError> {
    p.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| bad(format!("params.{key}: a string is needed")))
}

fn window_error(e: impl std::fmt::Display) -> BridgeError {
    BridgeError::new(codes::NO_WINDOW, e.to_string())
}

fn workspace_window(cx: &App) -> Result<WindowHandle<Workspace>, BridgeError> {
    cx.windows()
        .into_iter()
        .find_map(|w| w.downcast::<Workspace>())
        .ok_or_else(|| BridgeError::new(codes::NO_WINDOW, "no workspace window is open"))
}

/// Runs `f` with the workspace window, outside any entity's update (input
/// and drawing reach the workspace's own handlers from here).
fn in_window<R>(
    cx: &mut App,
    f: impl FnOnce(Entity<Workspace>, &mut Window, &mut App) -> R,
) -> Result<R, BridgeError> {
    let handle = workspace_window(cx)?;
    let view = handle.entity(cx).map_err(window_error)?;
    let any: AnyWindowHandle = handle.into();
    any.update(cx, |_, window, cx| f(view, window, cx))
        .map_err(window_error)
}

/// Runs `f` inside the workspace's update (navigation).
fn update_workspace<R>(
    cx: &mut App,
    f: impl FnOnce(&mut Workspace, &mut Window, &mut Context<Workspace>) -> R,
) -> Result<R, BridgeError> {
    workspace_window(cx)?.update(cx, f).map_err(window_error)
}

/// Runs one method.
pub async fn call(method: &str, params: Value, cx: &mut AsyncApp) -> Out {
    let p = if params.is_null() { json!({}) } else { params };
    match method {
        "methods" => Ok(json!(
            METHODS
                .iter()
                .map(|(m, about)| json!({ "method": m, "about": about }))
                .collect::<Vec<_>>()
        )),
        "app.info" => cx.update(info),
        "app.quit" => {
            cx.update(quit_soon);
            Ok(json!({ "quitting": true }))
        }
        "window.focus" => cx.update(focus),
        "window.close" => cx.update(|cx| {
            in_window(cx, |_, window, _| window.remove_window())?;
            Ok(json!({ "closed": true }))
        }),
        "window.open" => cx.update(|cx| {
            let handle = dr_shell::open_workspace(cx, |_, _| {}).map_err(window_error)?;
            let any: AnyWindowHandle = handle.into();
            Ok(json!({ "window": any.window_id().as_u64() }))
        }),
        "command.call" => command(&p, cx).await,
        "action.list" => cx.update(|cx| Ok(json!(cx.all_action_names()))),
        "action.dispatch" => cx.update(|cx| dispatch(&p, cx)),
        "input.type" => cx.update(|cx| type_text(&p, cx)),
        "input.key" => cx.update(|cx| press(&p, cx)),
        "input.click" => cx.update(|cx| click(&p, cx)),
        "nav.open" => cx.update(|cx| open(&p, cx)),
        "book.open" => open_book(&p, cx).await,
        "shelf.show" => cx.update(|cx| {
            update_workspace(cx, |ws, window, cx| ws.show_shelf(window, cx))
                .map(|shown| json!({ "shown": shown }))
        }),
        "state.get" => cx.update(state),
        "page.text" => cx.update(|cx| page_text(&p, cx)),
        "ui.wait" => wait(&p, cx).await,
        "ui.screenshot" => {
            // Let page turns, sidebars and pills finish moving first.
            let settle = p
                .get("settle_ms")
                .and_then(Value::as_u64)
                .unwrap_or(SETTLE_MS);
            if settle > 0 {
                cx.background_executor()
                    .timer(Duration::from_millis(settle))
                    .await;
            }
            cx.update(screenshot)
        }
        other => Err(BridgeError::new(
            codes::UNKNOWN_METHOD,
            format!("no method {other}; `methods` lists them"),
        )),
    }
}

fn info(cx: &mut App) -> Out {
    let shell = cx.try_global::<ShellInfo>().copied();
    let identity = dr_platform::Identity::current();
    let library = cx
        .try_global::<Services>()
        .is_some_and(|s| s.library.is_some());
    let mut windows = Vec::new();
    for handle in cx.windows() {
        let id = handle.window_id().as_u64();
        let workspace = handle.downcast::<Workspace>().is_some();
        let w = handle.update(cx, |_, window, _| {
            let b = window.bounds();
            json!({
                "id": id,
                "workspace": workspace,
                "title": window.window_title(),
                "active": window.is_window_active(),
                "visible": window.visibility() == WindowVisibility::Visible,
                "bounds": {
                    "x": f32::from(b.origin.x), "y": f32::from(b.origin.y),
                    "width": f32::from(b.size.width), "height": f32::from(b.size.height),
                },
                "scale": window.scale_factor(),
                "appearance": format!("{:?}", window.appearance()),
            })
        });
        if let Ok(w) = w {
            windows.push(w);
        }
    }
    Ok(json!({
        "app": shell.map(|s| s.app_name),
        "version": shell.map(|s| s.version),
        "bundleId": shell.map(|s| s.bundle_id),
        "instance": identity.instance_name(),
        "profile": identity.profile(),
        "pid": std::process::id(),
        "os": std::env::consts::OS,
        "library": library,
        "screenshots": cfg!(feature = "screenshot"),
        "windows": windows,
    }))
}

fn quit_soon(cx: &mut App) {
    // Answer first; then the shell's quit flow (hooks, layouts, settings).
    cx.spawn(async move |cx| {
        cx.background_executor()
            .timer(Duration::from_millis(50))
            .await;
        cx.update(dr_shell::quit::request);
    })
    .detach();
}

fn focus(cx: &mut App) -> Out {
    cx.activate(true);
    in_window(cx, |_, window, _| {
        window.activate_window();
        json!({ "active": window.is_window_active() })
    })
}

fn actor(s: Option<&str>) -> Result<Actor, BridgeError> {
    match s.unwrap_or("user") {
        "user" => Ok(Actor::User),
        other => {
            let rest = other
                .strip_prefix("agent:")
                .ok_or_else(|| bad(format!("actor {other}: user or agent:<session>/<turn>")))?;
            let (session, turn) = rest
                .split_once('/')
                .ok_or_else(|| bad("an agent actor is agent:<session>/<turn>"))?;
            let turn: u32 = turn.parse().map_err(|_| bad("the turn is a number"))?;
            Ok(Actor::agent(session, turn, "debug-bridge"))
        }
    }
}

async fn command(p: &Value, cx: &mut AsyncApp) -> Out {
    let name = string(p, "name")?.to_owned();
    let input = p.get("input").cloned().unwrap_or_else(|| json!({}));
    let actor = actor(p.get("actor").and_then(Value::as_str))?;
    let lib = cx
        .update(|cx| cx.try_global::<Services>().and_then(|s| s.library.clone()))
        .ok_or_else(|| BridgeError::new(codes::NO_LIBRARY, "the app runs without a library"))?;
    // F3 waits on its document holders; keep the main thread free.
    cx.background_executor()
        .spawn(async move { lib.call(&actor, &name, input) })
        .await
        .map_err(|e| BridgeError::new(e.code(), e.to_string()))
}

fn dispatch(p: &Value, cx: &mut App) -> Out {
    let name = string(p, "name")?;
    let action = cx
        .build_action(name, p.get("params").cloned())
        .map_err(|e| not_found(format!("{name}: {e:?}")))?;
    in_window(cx, |_, window, cx| window.dispatch_action(action, cx))?;
    Ok(json!({ "dispatched": name }))
}

/// The key a character is typed with; its text goes to the input handler.
fn keystroke_for(c: char) -> Keystroke {
    let (key, shift) = match c {
        '\n' => ("enter".to_owned(), false),
        '\t' => ("tab".to_owned(), false),
        ' ' => ("space".to_owned(), false),
        c if c.is_ascii_uppercase() => (c.to_ascii_lowercase().to_string(), true),
        c => (c.to_string(), false),
    };
    Keystroke {
        modifiers: Modifiers {
            shift,
            ..Modifiers::none()
        },
        key,
        key_char: Some(c.to_string()),
    }
}

fn type_text(p: &Value, cx: &mut App) -> Out {
    let text = string(p, "text")?.to_owned();
    in_window(cx, move |_, window, cx| {
        let mut typed = 0usize;
        for c in text.chars() {
            if !window.dispatch_keystroke(keystroke_for(c), cx) {
                return Err(BridgeError::new(
                    codes::NO_INPUT,
                    format!(
                        "nothing took {c:?} after {typed} characters: no text field has the focus"
                    ),
                ));
            }
            typed += 1;
        }
        Ok(json!({ "typed": typed }))
    })?
}

fn press(p: &Value, cx: &mut App) -> Out {
    let keys = string(p, "keys")?.to_owned();
    let os = cx.platform_info().os;
    let strokes = keys
        .split_whitespace()
        .map(|k| Keystroke::parse_with_os(k, os).map_err(|e| bad(format!("{k}: {e:?}"))))
        .collect::<Result<Vec<_>, _>>()?;
    if strokes.is_empty() {
        return Err(bad("params.keys: no key"));
    }
    in_window(cx, move |_, window, cx| {
        let handled: Vec<bool> = strokes
            .into_iter()
            .map(|k| window.dispatch_keystroke(k, cx))
            .collect();
        json!({ "handled": handled })
    })
}

fn click(p: &Value, cx: &mut App) -> Out {
    let coord = |k: &str| {
        p.get(k)
            .and_then(Value::as_f64)
            .map(|v| v as f32)
            .ok_or_else(|| bad(format!("params.{k}: a number is needed")))
    };
    let (x, y) = (coord("x")?, coord("y")?);
    let button = match p.get("button").and_then(Value::as_str).unwrap_or("left") {
        "left" => MouseButton::Left,
        "right" => MouseButton::Right,
        other => return Err(bad(format!("button {other}: left or right"))),
    };
    let count = p.get("count").and_then(Value::as_u64).unwrap_or(1).max(1) as usize;
    in_window(cx, move |_, window, cx| {
        let position = point(px(x), px(y));
        let modifiers = Modifiers::none();
        window.dispatch_event(
            PlatformInput::MouseMove(MouseMoveEvent {
                position,
                pressed_button: None,
                modifiers,
            }),
            cx,
        );
        for click_count in 1..=count {
            window.dispatch_event(
                PlatformInput::MouseDown(MouseDownEvent {
                    button,
                    position,
                    modifiers,
                    click_count,
                    first_mouse: false,
                }),
                cx,
            );
            window.dispatch_event(
                PlatformInput::MouseUp(MouseUpEvent {
                    button,
                    position,
                    modifiers,
                    click_count,
                }),
                cx,
            );
        }
        json!({ "clicked": [x, y], "count": count })
    })
}

fn open(p: &Value, cx: &mut App) -> Out {
    let p = p.clone();
    update_workspace(cx, move |ws, window, cx| {
        if let Some(link) = p.get("link").and_then(Value::as_str) {
            return if ws.open_link(link, window, cx) {
                Ok(json!({ "opened": ws.nav.current().map(Target::key) }))
            } else {
                Err(not_found(format!("{link} names nothing in this book")))
            };
        }
        let target = if let Some(key) = p.get("target").and_then(Value::as_str) {
            Target::from_key(key).ok_or_else(|| {
                bad(format!(
                    "{key} is not a page key (chapter:<id>, idea:<id>, …, book)"
                ))
            })?
        } else if let Some(c) = p.get("chapter").and_then(Value::as_str) {
            let found = ws
                .book
                .chapters
                .iter()
                .find(|x| x.id == c || x.title == c)
                .ok_or_else(|| not_found(format!("no chapter {c} in 《{}》", ws.book.name)))?;
            Target::Chapter(found.id.parse().map_err(|_| bad("not a chapter id"))?)
        } else {
            return Err(bad("give params.target, params.chapter or params.link"));
        };
        if !ws.book.exists(&target) {
            return Err(not_found(format!("{} is not in this book", target.key())));
        }
        let how = if p.get("preview") == Some(&json!(true)) {
            Open::PREVIEW
        } else {
            Open::KEEP
        };
        ws.open(target.clone(), how, cx);
        Ok(json!({ "opened": target.key() }))
    })?
}

/// Opens a book as the bookshelf does, by id or by name.
async fn open_book(p: &Value, cx: &mut AsyncApp) -> Out {
    let id = match (
        p.get("book").and_then(Value::as_str),
        p.get("name").and_then(Value::as_str),
    ) {
        (Some(id), _) => id.to_owned(),
        (None, Some(name)) => {
            let books = command(&json!({ "name": "book.list", "input": {} }), cx).await?;
            books["output"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|b| b["name"] == json!(name) || b["id"] == json!(name))
                .and_then(|b| b["id"].as_str())
                .map(str::to_owned)
                .ok_or_else(|| not_found(format!("no book named {name}")))?
        }
        (None, None) => return Err(bad("give params.book (an id) or params.name")),
    };
    cx.update(|cx| {
        update_workspace(cx, |ws, window, cx| ws.open_book(&id, window, cx))?;
        Ok(json!({ "opened": id }))
    })
}

fn layer_name(l: Layer) -> &'static str {
    match l {
        Layer::Notifications => "notifications",
        Layer::Settings => "settings",
        Layer::SuperView => "super-view",
    }
}

fn state_of(ws: &Workspace, window: &Window, cx: &App) -> Value {
    let book = &ws.book;
    let tabs: Vec<Value> = ws
        .nav
        .tabs()
        .iter()
        .map(|t| {
            json!({
                "key": t.key(),
                "leaves": t.leaves().map(|l| json!({
                    "target": l.target.key(),
                    "title": title_of(book, &l.target, cx).to_string(),
                    "preview": l.preview,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    let (page, title) = match ws.nav.page() {
        Page::Home => (json!("home"), Value::Null),
        Page::Target(t) => (json!(t.key()), json!(title_of(book, &t, cx).to_string())),
    };
    // Prose pages are editors (F6's third milestone); the whole book is
    // still read-only rows.
    let mut pages: Vec<Value> = ws
        .pages
        .iter()
        .map(|(k, s)| {
            json!({
                "key": k, "kind": "rows", "ready": s.ready,
                "loading": s.loading.is_some(), "failed": false, "rows": s.items.len(),
            })
        })
        .chain(ws.editors.iter().map(|(k, e)| {
            json!({
                "key": k, "kind": "editor", "doc": e.doc,
                "ready": e.editor.is_some() && e.loading.is_none(),
                "loading": e.loading.is_some(), "failed": e.failed,
            })
        }))
        .collect();
    pages.sort_by_key(|v| v["key"].to_string());
    let editor = ws.nav.current().and_then(|t| ws.editor_of(t));
    let editor_focused = editor.is_some_and(|e| {
        let handle = e.read(cx).editor().focus_handle(cx);
        window.focused(cx).is_some_and(|f| f == handle)
    });
    let selection = editor.map(|e| {
        let s = e.read(cx).editor().read(cx).selection();
        json!({ "anchor": s.anchor, "head": s.head })
    });
    json!({
        "library": ws.library.is_some(),
        "book": {
            "id": ws.book_id, "name": book.name,
            "chapters": book.chapters.len(), "loaded": !book.is_empty(),
        },
        "shelf": ws.shelf_open,
        "page": page,
        "pageTitle": title,
        "tabs": tabs,
        "activeTab": ws.nav.active_index(),
        "layer": ws.top_layer().map(layer_name),
        "superView": ws.super_view.map(|v| format!("{v:?}")),
        "left": {
            "open": ws.left.open, "width": ws.left.width,
            "panes": serde_json::to_value(&ws.left.panes).unwrap_or(Value::Null),
        },
        "right": {
            "open": ws.right.open, "width": ws.right.width,
            "panes": serde_json::to_value(&ws.right.panes).unwrap_or(Value::Null),
        },
        "dockLocked": ws.dock_locked,
        "focus": {
            "workspace": ws.focus_handle().contains_focused(window, cx),
            "editor": editor_focused,
            "any": window.focused(cx).is_some(),
        },
        "selection": selection,
        "window": {
            "active": window.is_window_active(),
            "visible": window.visibility() == WindowVisibility::Visible,
        },
        "pages": pages,
    })
}

fn state(cx: &mut App) -> Out {
    in_window(cx, |view, window, cx| state_of(view.read(cx), window, cx))
}

fn page_text(p: &Value, cx: &mut App) -> Out {
    let wanted = p.get("target").and_then(Value::as_str).map(str::to_owned);
    in_window(cx, move |view, _, cx| {
        let ws = view.read(cx);
        let target = match wanted {
            Some(k) => Target::from_key(&k).ok_or_else(|| bad(format!("{k} is not a page key")))?,
            None => ws
                .nav
                .current()
                .cloned()
                .ok_or_else(|| not_found("the paper shows the Project Home, not a page"))?,
        };
        let title = title_of(&ws.book, &target, cx).to_string();
        // A prose page: what its editor holds (every keystroke is already
        // in it; F3's prose.read reads the same once persisted).
        if let Some(page) = ws.editors.get(&target.key()) {
            let Some(editor) = &page.editor else {
                return Ok(json!({
                    "target": target.key(), "title": title, "ready": false,
                    "loading": page.loading.is_some(), "failed": page.failed,
                    "paragraphs": [], "text": "", "source": "editor",
                }));
            };
            let prose = editor.read(cx).editor().read(cx);
            let doc = &prose.book().chapters[0].doc;
            let mut paragraphs = Vec::new();
            let mut lines = Vec::new();
            for ix in 0..doc.visible_lines() {
                let line = doc.line(ix);
                paragraphs.push(json!({
                    "heading": line.kind.level().unwrap_or(0),
                    "text": line.text.as_ref(),
                }));
                lines.push(line.text.to_string());
            }
            let sel = prose.selection();
            return Ok(json!({
                "target": target.key(), "title": title, "ready": true, "loading": false,
                "paragraphs": paragraphs, "text": lines.join("\n"),
                "selection": { "anchor": sel.anchor, "head": sel.head },
                "source": "editor",
            }));
        }
        // The whole book: the shell's read-only rows.
        let slot = ws
            .pages
            .get(&target.key())
            .ok_or_else(|| not_found(format!("{} is not open on screen", target.key())))?;
        let mut paragraphs = Vec::new();
        let mut lines = Vec::new();
        for item in slot.items.iter() {
            match item {
                Item::Head => {}
                Item::Section(title) => paragraphs.push(json!({ "section": title })),
                Item::Para(para) => {
                    paragraphs.push(json!({ "heading": para.heading, "text": para.text }));
                    lines.push(para.text.as_str());
                }
            }
        }
        Ok(json!({
            "target": target.key(),
            "title": title,
            "ready": slot.ready,
            "loading": slot.loading.is_some(),
            "paragraphs": paragraphs,
            "text": lines.join("\n"),
            "source": "rows",
        }))
    })?
}

/// A covered or minimized window draws no frames, and the shell starts
/// reading a page when it renders it: draw it here (without presenting),
/// and mark it for a real frame once it shows again.
fn pump(cx: &mut App) -> Result<bool, BridgeError> {
    in_window(cx, |_, window, cx| {
        let hidden = window.visibility() != WindowVisibility::Visible;
        if hidden {
            window.refresh();
            window.draw(cx).clear(cx);
            window.refresh();
        }
        hidden
    })
}

/// Whether the wait is over, and if not, what it is waiting for.
fn settled(
    text: Option<&str>,
    want: &[(String, Value)],
    cx: &mut App,
) -> Result<Option<String>, BridgeError> {
    pump(cx)?;
    let s = state(cx)?;
    if s["library"] != json!(true) {
        return Err(BridgeError::new(
            codes::NO_LIBRARY,
            "the app runs without a library",
        ));
    }
    if s["shelf"] == json!(true) {
        // The bookshelf covers the window: nothing of a book to wait for.
    } else if s["book"]["loaded"] != json!(true) {
        return Ok(Some("the book's lists have not arrived".into()));
    }
    let shown: Vec<String> = s["activeTab"]
        .as_u64()
        .and_then(|i| s["tabs"].get(i as usize))
        .map(|t| {
            t["leaves"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|l| l["target"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    for key in &shown {
        let page = s["pages"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["key"] == json!(key));
        if page.is_some_and(|p| p["failed"] == json!(true)) {
            return Err(BridgeError::new(
                codes::IO,
                format!("{key}: the editor could not open it (see the app's log)"),
            ));
        }
        let ready = page.is_some_and(|p| p["ready"] == json!(true) && p["loading"] == json!(false));
        if !ready {
            return Ok(Some(format!("{key} is being read")));
        }
    }
    if let Some(text) = text {
        let shows = page_text(&json!({}), cx)
            .map(|t| t["text"].as_str().is_some_and(|x| x.contains(text)))?;
        if !shows {
            return Ok(Some(format!("the page does not show {text:?} yet")));
        }
    }
    for (pointer, value) in want {
        let got = s.pointer(pointer).cloned().unwrap_or(Value::Null);
        if &got != value {
            return Ok(Some(format!("{pointer} is {got}, not {value}")));
        }
    }
    Ok(None)
}

async fn wait(p: &Value, cx: &mut AsyncApp) -> Out {
    let until = p.get("until").and_then(Value::as_str).unwrap_or("ready");
    if until != "ready" {
        return Err(bad(format!("until {until}: only \"ready\" so far")));
    }
    let text = p.get("text").and_then(Value::as_str).map(str::to_owned);
    let want: Vec<(String, Value)> = p
        .get("state")
        .and_then(Value::as_object)
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    let timeout = Duration::from_millis(
        p.get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(10_000),
    );
    let started = Instant::now();
    let mut polls = 0u32;
    loop {
        polls += 1;
        let pending = cx.update(|cx| settled(text.as_deref(), &want, cx))?;
        let Some(why) = pending else {
            return Ok(json!({ "waitedMs": started.elapsed().as_millis() as u64, "polls": polls }));
        };
        if started.elapsed() >= timeout {
            return Err(BridgeError::new(
                codes::TIMEOUT,
                format!("still waiting after {} ms: {why}", timeout.as_millis()),
            ));
        }
        cx.background_executor()
            .timer(Duration::from_millis(20))
            .await;
    }
}

#[cfg(feature = "screenshot")]
fn screenshot(cx: &mut App) -> Out {
    use base64::Engine as _;
    let hidden = pump(cx)?;
    let image = in_window(cx, |_, window, _| window.render_to_image())?
        .map_err(|e| BridgeError::new(codes::IO, format!("render_to_image: {e:#}")))?;
    let (width, height) = (image.width(), image.height());
    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| BridgeError::new(codes::IO, e.to_string()))?;
        writer
            .write_image_data(image.as_raw())
            .map_err(|e| BridgeError::new(codes::IO, e.to_string()))?;
    }
    Ok(json!({
        "png": base64::engine::general_purpose::STANDARD.encode(&png_bytes),
        "width": width,
        "height": height,
        "drawnWhileHidden": hidden,
    }))
}

#[cfg(not(feature = "screenshot"))]
fn screenshot(_: &mut App) -> Out {
    let _ = base64::engine::general_purpose::STANDARD;
    Err(BridgeError::new(
        codes::UNSUPPORTED,
        "this build has no screenshots (the app's debug-bridge feature turns on dr-debug-bridge/screenshot)",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn characters_become_key_presses_with_their_text() {
        let k = keystroke_for('灯');
        assert_eq!((k.key.as_str(), k.key_char.as_deref()), ("灯", Some("灯")));
        let k = keystroke_for('A');
        assert!(k.modifiers.shift);
        assert_eq!((k.key.as_str(), k.key_char.as_deref()), ("a", Some("A")));
        assert_eq!(keystroke_for('\n').key, "enter");
        assert!(actor(Some("agent:s1/3")).is_ok());
        assert!(actor(Some("import")).is_err());
        assert_eq!(METHODS.len(), {
            let mut names: Vec<&str> = METHODS.iter().map(|(m, _)| *m).collect();
            names.sort();
            names.dedup();
            names.len()
        });
    }
}
