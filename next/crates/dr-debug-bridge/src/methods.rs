//! The bridge's methods. Each runs on GPUI's main thread.
//!
//! Input goes through the window the way the platform delivers it
//! (`Window::dispatch_keystroke` and `dispatch_event`), outside any
//! entity's update, so the handlers it reaches (the workspace's actions,
//! the editor's input handler) run as they would for a real key press.
//! Reads of the shell go through its public fields.

use std::time::{Duration, Instant};

use dr_debug_protocol::BridgeError;

use crate::a11y;
use dr_debug_protocol::wire::codes;
use dr_shell::nav::{Open, Page, Target};
use dr_shell::workspace::editors::PageView;
use dr_shell::workspace::{Layer, title_of};
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
        "{keys, times?}: press keys, e.g. \"secondary-z\" or \"enter escape\" (space-separated; secondary is ⌘ on macOS, Ctrl elsewhere), the whole sequence `times` times",
    ),
    (
        "input.click",
        "{x, y, button?, count?}: click at a window position, in logical pixels",
    ),
    (
        "input.move",
        "{x, y}: move the pointer to a window position (hover), in logical pixels",
    ),
    (
        "input.drag",
        "{from: [x, y], to: [x, y], steps?}: press the left button at from, move to to with it held (steps moves, default 8), let go there: selecting text with the mouse",
    ),
    (
        "input.scroll",
        "{x, y, dy, dx?}: scroll at a window position by pixels (positive dy scrolls the content up, towards the end), as a trackpad would",
    ),
    (
        "ui.find",
        "{label?, contains?, role?, within?, count?, absent?, timeout_ms?}: the window's accessibility nodes (role, label, value, bounds, centre) that match: label exactly, contains in the label, value or help, role without its AX prefix (Button, RadioButton, Slider, Group …), within (the same keys) inside the first node that matches it; waits until one does (with count, until exactly that many do; with absent, until none does); macOS",
    ),
    (
        "ui.press",
        "{label?, contains?, role?, within?, nth?, via?, dx?, dy?, hover_ms?, settle_ms?}: press the nth node that matches: by default the pointer moves to its centre (moved by dx, dy), rests there hover_ms (120) and clicks (hover, hit test and click as a mouse would); via \"a11y\" asks AccessKit to press it instead, \"increment\" or \"decrement\" to step a slider or a number; waits for the node first; macOS",
    ),
    (
        "ui.hover",
        "{label?, contains?, role?, within?, nth?, dx?, dy?}: move the pointer onto the nth node that matches (its centre moved by dx, dy); macOS",
    ),
    (
        "ui.focus",
        "{field, row?, select_all?}: give a text field the keyboard, as a click into it would (select_all: with its text selected, as a triple click), where dr-ui's fields are not yet in the accessibility tree: page.title, page.synopsis (the chapter page on the paper), element.name, element.alias, element.summary, element.field.key, element.field.value (row: an index, default the last), category.name, settings.search",
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
        "{until: \"ready\", text?, state?, page?, timeout_ms?}: wait until the window has a library (it has none for a moment while a restore replaces it), the book and the pages on screen are read, and the page shows text, and state.get (page.text) has the values at the JSON pointers in state (page); {until: \"time\", ms}: just wait; {until: \"file\", path, timeout_ms?}: until a file the app writes is there",
    ),
    (
        "panel.state",
        "the system's open and save panels: the answer armed for the next one, the last one the app asked for ({kind: open|save, directory, name, prompt, answer}), and whether a real one is on screen; macOS",
    ),
    (
        "panel.answer",
        "{path}: arm the answer for the next open or save panel the app begins (press the app's button after this): it is not shown, the app's handler gets path at once, as after the author's choice; macOS",
    ),
    (
        "panel.cancel",
        "arm Cancel for the next open or save panel the app begins; macOS",
    ),
    (
        "library.info",
        "the open library's folder and the copies a restore saved first (pre-restore backups, newest first)",
    ),
    (
        "ui.screenshot",
        "{settle_ms?}: the window as a PNG (base64), drawn from inside the app after the transitions settle (default 500 ms; the longest dr-ui motion is 420 ms); a covered window is drawn first",
    ),
    (
        "settings.get",
        "{keys?}: the settings' values as the shell reads them (default: every one the registry knows), and the interface language",
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
        "input.move" => cx.update(|cx| {
            let (x, y) = (coord(&p, "x")?, coord(&p, "y")?);
            in_window(cx, |_, window, cx| hover_at(x, y, window, cx))?;
            Ok(json!({ "moved": [x, y] }))
        }),
        "input.drag" => cx.update(|cx| drag(&p, cx)),
        "input.scroll" => cx.update(|cx| {
            let (x, y) = (coord(&p, "x")?, coord(&p, "y")?);
            let dy = coord(&p, "dy")?;
            let dx = p.get("dx").and_then(Value::as_f64).unwrap_or(0.0) as f32;
            in_window(cx, |_, window, cx| {
                hover_at(x, y, window, cx);
                window.dispatch_event(
                    PlatformInput::Scroll(gpui::ScrollEvent {
                        position: point(px(x), px(y)),
                        delta: gpui::ScrollDelta::Pixels(point(px(-dx), px(-dy))),
                        ..Default::default()
                    }),
                    cx,
                );
            })?;
            Ok(json!({ "scrolled": [dx, dy] }))
        }),
        "ui.find" => find(&p, cx).await,
        "ui.press" => press_node(&p, cx).await,
        "ui.hover" => {
            let node = wait_for_node(&p, cx).await?;
            let (x, y) = offset(node.center(), &p);
            cx.update(|cx| in_window(cx, |_, window, cx| hover_at(x, y, window, cx)))?;
            Ok(json!({ "hovered": node.to_json() }))
        }
        "ui.focus" => cx.update(|cx| focus_field(&p, cx)),
        "settings.get" => cx.update(|cx| {
            let file = dr_shell::Settings::read(cx);
            let keys: Vec<String> = match p.get("keys").and_then(Value::as_array) {
                Some(keys) => keys
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
                None => dr_shell::settings::registry::REGISTRY
                    .iter()
                    .map(|d| d.key.to_owned())
                    .collect(),
            };
            let values: serde_json::Map<String, Value> = keys
                .into_iter()
                .map(|k| {
                    let v = file.get(&k);
                    (k, v)
                })
                .collect();
            Ok(json!({
                "values": values,
                "locale": dr_shell::Settings::locale(cx).code(),
            }))
        }),
        "nav.open" => cx.update(|cx| open(&p, cx)),
        "book.open" => open_book(&p, cx).await,
        "shelf.show" => cx.update(|cx| {
            update_workspace(cx, |ws, window, cx| ws.show_shelf(window, cx))
                .map(|shown| json!({ "shown": shown }))
        }),
        "panel.state" => cx.update(|_| Ok(crate::panel::state())),
        "panel.answer" => cx.update(|_| {
            let path = std::path::PathBuf::from(string(&p, "path")?);
            if !path.is_absolute() {
                return Err(bad("params.path: an absolute path is needed"));
            }
            arm(Some(crate::panel::Answer::Path(path)))
        }),
        "panel.cancel" => cx.update(|_| arm(Some(crate::panel::Answer::Cancel))),
        "library.info" => cx.update(|cx| {
            let lib = cx
                .try_global::<Services>()
                .and_then(|s| s.library.clone())
                .ok_or_else(|| not_found("no library is open"))?;
            let root = lib.library().paths().root.clone();
            let pre: Vec<String> = dr_store::Library::pre_restore_backups(&root)
                .unwrap_or_default()
                .iter()
                .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
                .collect();
            Ok(json!({ "root": root.to_string_lossy(), "preRestore": pre }))
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
    let times = p
        .get("times")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .clamp(1, 500) as usize;
    let strokes: Vec<Keystroke> = std::iter::repeat_n(strokes, times).flatten().collect();
    in_window(cx, move |_, window, cx| {
        let handled: Vec<bool> = strokes
            .into_iter()
            .map(|k| window.dispatch_keystroke(k, cx))
            .collect();
        json!({ "handled": handled })
    })
}

fn coord(p: &Value, k: &str) -> Result<f32, BridgeError> {
    p.get(k)
        .and_then(Value::as_f64)
        .map(|v| v as f32)
        .ok_or_else(|| bad(format!("params.{k}: a number is needed")))
}

fn hover_at(x: f32, y: f32, window: &mut Window, cx: &mut App) {
    window.dispatch_event(
        PlatformInput::MouseMove(MouseMoveEvent {
            position: point(px(x), px(y)),
            pressed_button: None,
            modifiers: Modifiers::none(),
        }),
        cx,
    );
}

fn click(p: &Value, cx: &mut App) -> Out {
    let (x, y) = (coord(p, "x")?, coord(p, "y")?);
    let button = match p.get("button").and_then(Value::as_str).unwrap_or("left") {
        "left" => MouseButton::Left,
        "right" => MouseButton::Right,
        other => return Err(bad(format!("button {other}: left or right"))),
    };
    let count = p.get("count").and_then(Value::as_u64).unwrap_or(1).max(1) as usize;
    in_window(cx, move |_, window, cx| {
        click_at(x, y, button, count, window, cx);
        json!({ "clicked": [x, y], "count": count })
    })
}

fn drag(p: &Value, cx: &mut App) -> Out {
    let pair = |k: &str| -> Result<(f32, f32), BridgeError> {
        let a = p
            .get(k)
            .and_then(Value::as_array)
            .filter(|a| a.len() == 2)
            .ok_or_else(|| bad(format!("params.{k}: [x, y]")))?;
        let n = |v: &Value| {
            v.as_f64()
                .map(|v| v as f32)
                .ok_or_else(|| bad(format!("params.{k}: numbers")))
        };
        Ok((n(&a[0])?, n(&a[1])?))
    };
    let (from, to) = (pair("from")?, pair("to")?);
    let steps = p
        .get("steps")
        .and_then(Value::as_u64)
        .unwrap_or(8)
        .clamp(1, 100) as usize;
    in_window(cx, move |_, window, cx| {
        let modifiers = Modifiers::none();
        hover_at(from.0, from.1, window, cx);
        window.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                button: MouseButton::Left,
                position: point(px(from.0), px(from.1)),
                modifiers,
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
        for i in 1..=steps {
            let t = i as f32 / steps as f32;
            let at = point(
                px(from.0 + (to.0 - from.0) * t),
                px(from.1 + (to.1 - from.1) * t),
            );
            window.dispatch_event(
                PlatformInput::MouseMove(MouseMoveEvent {
                    position: at,
                    pressed_button: Some(MouseButton::Left),
                    modifiers,
                }),
                cx,
            );
        }
        window.dispatch_event(
            PlatformInput::MouseUp(MouseUpEvent {
                button: MouseButton::Left,
                position: point(px(to.0), px(to.1)),
                modifiers,
                click_count: 1,
            }),
            cx,
        );
        json!({ "dragged": [[from.0, from.1], [to.0, to.1]], "steps": steps })
    })
}

/// A pointer moving to (`x`, `y`) and clicking `count` times there.
fn click_at(x: f32, y: f32, button: MouseButton, count: usize, window: &mut Window, cx: &mut App) {
    let position = point(px(x), px(y));
    let modifiers = Modifiers::none();
    hover_at(x, y, window, cx);
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
        Layer::Search => "search",
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
    // Every page is an editor (F6): one document's, or the whole book's.
    let mut pages: Vec<Value> = ws
        .editors
        .iter()
        .map(|(k, e)| {
            let kind = match &e.view {
                Some(PageView::Book(_)) => "book",
                _ if e.doc.is_none() => "book",
                _ => "editor",
            };
            json!({
                "key": k, "kind": kind, "doc": e.doc,
                "ready": e.view.is_some() && e.loading.is_none(),
                "loading": e.loading.is_some(), "failed": e.failed,
            })
        })
        .collect();
    pages.sort_by_key(|v| v["key"].to_string());
    let prose = ws
        .nav
        .current()
        .and_then(|t| ws.page_view(t))
        .map(|v| v.prose(cx));
    let editor_focused = prose.as_ref().is_some_and(|p| {
        let handle = p.focus_handle(cx);
        window.focused(cx).is_some_and(|f| f == handle)
    });
    // dr-editor's selection bar (F4e), shown over the page's selection.
    let selection_bar = ws
        .nav
        .current()
        .and_then(|t| ws.page_view(t))
        .is_some_and(|v| match v {
            PageView::Doc(e) => e.read(cx).assist().read(cx).bar().is_some(),
            PageView::Book(e) => e.read(cx).assist().read(cx).bar().is_some(),
        });
    let selection = prose.as_ref().map(|p| {
        let s = p.read(cx).selection();
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
        // The Bottom Panel under the paper (M14's timeline, M15's planner).
        "bottom": {
            "pane": ws.bottom_pane(cx).map(|p| match p {
                dr_shell::pages::BottomPane::Timeline => "timeline",
                dr_shell::pages::BottomPane::Planner => "planner",
            }),
            "height": ws.bottom_height(),
        },
        "focus": {
            "workspace": ws.focus_handle().contains_focused(window, cx),
            "editor": editor_focused,
            "any": window.focused(cx).is_some(),
        },
        "selection": selection,
        "selectionBar": selection_bar,
        // What covers the page: a dialog (M10's import, M39's feedback, M41's
        // export), the snapshot history (M09), the comment composer (M18),
        // the ⋯ menu.
        "dialog": ws.dialog.is_some(),
        "history": ws.history.is_some(),
        "composer": ws.composer.is_some(),
        "cornerMenu": ws.corner_menu.is_some(),
        // M41's dialog when it is the one up, and the system's open or save
        // panel (a window of AppKit's over the app's).
        "transfer": transfer_of(ws, cx),
        "panel": crate::panel::state(),
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
    in_window(cx, move |view, window, cx| {
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
        // What the page's editor holds (every keystroke is already in it;
        // F3's prose.read reads the same once persisted). The whole book
        // lists each chapter's title as a section before its paragraphs.
        let page = ws
            .editors
            .get(&target.key())
            .ok_or_else(|| not_found(format!("{} is not open on screen", target.key())))?;
        let Some(view) = &page.view else {
            return Ok(json!({
                "target": target.key(), "title": title, "ready": false,
                "loading": page.loading.is_some(), "failed": page.failed,
                "paragraphs": [], "text": "", "source": "editor",
            }));
        };
        let whole_book = matches!(view, PageView::Book(_));
        let prose = view.prose(cx);
        let prose = prose.read(cx);
        let mut paragraphs = Vec::new();
        let mut lines = Vec::new();
        for chapter in &prose.book().chapters {
            if whole_book {
                paragraphs.push(json!({ "section": chapter.title.as_ref() }));
            }
            let doc = &chapter.doc;
            for ix in 0..doc.visible_lines() {
                let line = doc.line(ix);
                paragraphs.push(json!({
                    "heading": line.kind.level().unwrap_or(0),
                    "text": line.text.as_ref(),
                }));
                lines.push(line.text.to_string());
            }
        }
        let sel = prose.selection();
        let head = page
            .doc
            .as_deref()
            .map(|doc| head_of(&target, doc, window, cx))
            .unwrap_or(Value::Null);
        Ok(json!({
            "target": target.key(), "title": title,
            "ready": page.loading.is_none(), "loading": page.loading.is_some(),
            "paragraphs": paragraphs, "text": lines.join("\n"),
            "selection": { "anchor": sel.anchor, "head": sel.head },
            "source": if whole_book { "book" } else { "editor" },
            "head": head,
        }))
    })?
}

/// What a page shows around its text and which of its fields has the
/// keyboard: a chapter page's title, synopsis and ⁂ (M03), an element
/// page's name, aliases input, summary and field rows (M11).
fn head_of(target: &Target, doc: &str, window: &Window, cx: &App) -> Value {
    let focused = |h: gpui::FocusHandle| h.is_focused(window);
    match target {
        Target::Chapter(_) => {
            let Some((head, end)) = dr_view_page::page_views(doc, cx) else {
                return Value::Null;
            };
            let (h, e) = (head.read(cx), end.read(cx));
            let (title, synopsis) = (h.title().read(cx), h.synopsis().read(cx));
            let focus = if focused(h.title().focus_handle(cx)) {
                json!("title")
            } else if focused(h.synopsis().focus_handle(cx)) {
                json!("synopsis")
            } else {
                Value::Null
            };
            json!({
                "title": title.text(), "synopsis": synopsis.text(),
                "status": e.page().status, "finished": e.page().finished(),
                "number": e.page().number, "endOpen": e.is_open(),
                "focus": focus,
            })
        }
        Target::Element(id) => {
            let Some((head, fields)) = dr_view_elements::element_page(id.as_ref(), cx) else {
                return Value::Null;
            };
            let (name, alias, summary) = head.read(cx).fields();
            let rows = fields.read(cx).rows();
            let focus = if focused(name.focus_handle(cx)) {
                json!("name")
            } else if focused(alias.focus_handle(cx)) {
                json!("alias")
            } else if focused(summary.focus_handle(cx)) {
                json!("summary")
            } else {
                rows.iter()
                    .position(|(_, k, v)| {
                        focused(k.focus_handle(cx)) || focused(v.focus_handle(cx))
                    })
                    .map(|i| json!(format!("field.{i}")))
                    .unwrap_or(Value::Null)
            };
            json!({
                "name": name.read(cx).text(),
                "alias": alias.read(cx).text(),
                "summary": summary.read(cx).text(),
                "fields": rows.iter().map(|(id, k, v)| json!({
                    "id": id, "key": k.read(cx).text(), "value": v.read(cx).text(),
                })).collect::<Vec<_>>(),
                // The 0.1 alert is the shell's dialog now (M11's
                // `dr_view_elements::dialogs`), not a field of the head.
                "alert": dr_view_elements::dialogs::dialogs(cx)
                    .and_then(|d| d.read(cx).asking())
                    .and_then(|a| match a {
                        dr_view_elements::dialogs::Asking::Alert(m) => Some(m),
                        _ => None,
                    }),
                "focus": focus,
            })
        }
        Target::Category(id) => {
            let Some((head, _)) = dr_view_elements::category_page(id.as_ref(), cx) else {
                return Value::Null;
            };
            json!({ "name": head.read(cx).name_field().read(cx).text() })
        }
        _ => Value::Null,
    }
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
    page_want: &[(String, Value)],
    cx: &mut App,
) -> Result<Option<String>, BridgeError> {
    pump(cx)?;
    let s = state(cx)?;
    if s["library"] != json!(true) {
        // Between letting the library go and taking the next one up (M41's
        // restore swaps it under the window), or none could be opened.
        return Ok(Some(
            "the window has no library (being replaced, or none opened)".into(),
        ));
    }
    // The bookshelf covers the window: nothing of a book to wait for (the
    // tabs under it keep their pages, which have no editors while it is up:
    // after a restore swapped the library, say).
    let covered = s["shelf"] == json!(true);
    if !covered && s["book"]["loaded"] != json!(true) {
        return Ok(Some("the book's lists have not arrived".into()));
    }
    let shown: Vec<String> = s["activeTab"]
        .as_u64()
        .filter(|_| !covered)
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
    if !page_want.is_empty() {
        let page = page_text(&json!({}), cx)?;
        for (pointer, value) in page_want {
            let got = page.pointer(pointer).cloned().unwrap_or(Value::Null);
            if &got != value {
                return Ok(Some(format!("page {pointer} is {got}, not {value}")));
            }
        }
    }
    Ok(None)
}

async fn wait(p: &Value, cx: &mut AsyncApp) -> Out {
    let until = p.get("until").and_then(Value::as_str).unwrap_or("ready");
    match until {
        "ready" => {}
        // A pause (a history point waits for its commit, a toast for its
        // timer): nothing on screen says when it is over.
        "time" => {
            let ms = p
                .get("ms")
                .and_then(Value::as_u64)
                .unwrap_or(500)
                .min(60_000);
            cx.background_executor()
                .timer(Duration::from_millis(ms))
                .await;
            return Ok(json!({ "waitedMs": ms }));
        }
        // A file the app writes in the background with nothing on screen
        // when it is done (M41's book export: written whole, then renamed
        // into place).
        "file" => {
            let path = std::path::PathBuf::from(string(p, "path")?);
            let timeout = Duration::from_millis(
                p.get("timeout_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(10_000),
            );
            let started = Instant::now();
            while !path.exists() {
                if started.elapsed() >= timeout {
                    return Err(BridgeError::new(
                        codes::TIMEOUT,
                        format!(
                            "{} is not there after {} ms",
                            path.display(),
                            timeout.as_millis()
                        ),
                    ));
                }
                cx.background_executor()
                    .timer(Duration::from_millis(50))
                    .await;
            }
            let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            return Ok(json!({ "waitedMs": started.elapsed().as_millis() as u64, "bytes": bytes }));
        }
        other => {
            return Err(bad(format!(
                "until {other}: \"ready\", \"time\" or \"file\""
            )));
        }
    }
    let text = p.get("text").and_then(Value::as_str).map(str::to_owned);
    let pairs = |key: &str| -> Vec<(String, Value)> {
        p.get(key)
            .and_then(Value::as_object)
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default()
    };
    let (want, page_want) = (pairs("state"), pairs("page"));
    let timeout = Duration::from_millis(
        p.get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(10_000),
    );
    let started = Instant::now();
    let mut polls = 0u32;
    loop {
        polls += 1;
        let pending = cx.update(|cx| settled(text.as_deref(), &want, &page_want, cx))?;
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

/// What `ui.find`, `ui.press` and `ui.hover` look for.
struct Query {
    label: Option<String>,
    contains: Option<String>,
    role: Option<String>,
    /// Only nodes inside the first node this matches (their centre within
    /// its bounds): one book card's buttons among every card's.
    within: Option<Box<Query>>,
}

impl Query {
    fn of(p: &Value) -> Query {
        let s = |k: &str| p.get(k).and_then(Value::as_str).map(str::to_owned);
        Query {
            label: s("label"),
            contains: s("contains"),
            role: s("role").map(|r| r.trim_start_matches("AX").to_lowercase()),
            within: p
                .get("within")
                .filter(|w| w.is_object())
                .map(|w| Box::new(Query::of(w))),
        }
    }

    /// The nodes of `all` that match, in the tree's order.
    fn select(&self, all: &[a11y::Node]) -> Vec<a11y::Node> {
        let inside = match &self.within {
            None => None,
            Some(w) => match w.select(all).into_iter().next() {
                Some(container) => Some(container),
                None => return Vec::new(),
            },
        };
        all.iter()
            .filter(|n| self.matches(n))
            .filter(|n| {
                inside.as_ref().is_none_or(|c| {
                    let (x, y) = n.center();
                    let [cx, cy, w, h] = c.bounds;
                    *n != c && x >= cx && x <= cx + w && y >= cy && y <= cy + h
                })
            })
            .cloned()
            .collect()
    }

    fn is_empty(&self) -> bool {
        self.label.is_none() && self.contains.is_none() && self.role.is_none()
    }

    fn matches(&self, n: &a11y::Node) -> bool {
        if let Some(label) = &self.label
            && n.label.as_deref() != Some(label.as_str())
        {
            return false;
        }
        if let Some(part) = &self.contains {
            let has = |s: &Option<String>| s.as_deref().is_some_and(|s| s.contains(part.as_str()));
            if !(has(&n.label) || has(&n.value) || has(&n.help)) {
                return false;
            }
        }
        if let Some(role) = &self.role
            && n.role.to_lowercase() != *role
        {
            return false;
        }
        true
    }

    fn describe(&self) -> String {
        let mut parts = Vec::new();
        if let Some(l) = &self.label {
            parts.push(format!("label {l:?}"));
        }
        if let Some(c) = &self.contains {
            parts.push(format!("containing {c:?}"));
        }
        if let Some(r) = &self.role {
            parts.push(format!("role {r}"));
        }
        if let Some(w) = &self.within {
            parts.push(format!("inside ({})", w.describe()));
        }
        parts.join(", ")
    }
}

fn unsupported_a11y() -> Out {
    Err(BridgeError::new(
        codes::UNSUPPORTED,
        "finding elements by their accessible name is macOS only so far",
    ))
}

/// The nodes that match now (drawing a covered window first, so a tree
/// that only now connected gets its first frame), and how many nodes the
/// tree has; `None` while the tree is still connecting.
fn matching(q: &Query, cx: &mut App) -> Result<Option<(Vec<a11y::Node>, usize)>, BridgeError> {
    pump(cx)?;
    in_window(cx, |_, window, _| {
        let (all, current) = a11y::nodes(window);
        current.then(|| {
            let total = all.len();
            (q.select(&all), total)
        })
    })
}

async fn find(p: &Value, cx: &mut AsyncApp) -> Out {
    if !a11y::SUPPORTED {
        return unsupported_a11y();
    }
    let q = Query::of(p);
    let absent = p.get("absent") == Some(&json!(true));
    let count = p.get("count").and_then(Value::as_u64).map(|c| c as usize);
    let timeout =
        Duration::from_millis(p.get("timeout_ms").and_then(Value::as_u64).unwrap_or(3_000));
    let started = Instant::now();
    loop {
        let (found, current) = match cx.update(|cx| matching(&q, cx))? {
            Some((found, _)) => (found, true),
            None => (Vec::new(), false),
        };
        let done = current
            && match count {
                Some(n) => found.len() == n,
                None => q.is_empty() || absent == found.is_empty(),
            };
        if done {
            return Ok(json!({
                "count": found.len(),
                "nodes": found.iter().map(a11y::Node::to_json).collect::<Vec<_>>(),
            }));
        }
        if started.elapsed() >= timeout {
            return Err(BridgeError::new(
                if absent || count.is_some() {
                    codes::TIMEOUT
                } else {
                    codes::NOT_FOUND
                },
                if let Some(n) = count {
                    format!(
                        "{} node(s) match {} after {} ms, not {n}",
                        found.len(),
                        q.describe(),
                        timeout.as_millis()
                    )
                } else if absent {
                    format!(
                        "still shown after {} ms: {}",
                        timeout.as_millis(),
                        q.describe()
                    )
                } else {
                    format!(
                        "nothing on screen matches {} after {} ms",
                        q.describe(),
                        timeout.as_millis()
                    )
                },
            ));
        }
        cx.background_executor()
            .timer(Duration::from_millis(50))
            .await;
    }
}

/// The `nth` node that matches, once it shows (up to `timeout_ms`, 3 s).
async fn wait_for_node(p: &Value, cx: &mut AsyncApp) -> Result<a11y::Node, BridgeError> {
    if !a11y::SUPPORTED {
        return unsupported_a11y().map(|_| unreachable!());
    }
    let q = Query::of(p);
    if q.is_empty() {
        return Err(bad("give params.label, params.contains or params.role"));
    }
    let nth = p.get("nth").and_then(Value::as_u64).unwrap_or(0) as usize;
    let timeout =
        Duration::from_millis(p.get("timeout_ms").and_then(Value::as_u64).unwrap_or(3_000));
    let started = Instant::now();
    loop {
        let found = cx
            .update(|cx| matching(&q, cx))?
            .map(|(found, _)| found)
            .unwrap_or_default();
        if let Some(node) = found.get(nth) {
            return Ok(node.clone());
        }
        if started.elapsed() >= timeout {
            return Err(not_found(format!(
                "{} node(s) match {} after {} ms; wanted number {}",
                found.len(),
                q.describe(),
                timeout.as_millis(),
                nth + 1
            )));
        }
        cx.background_executor()
            .timer(Duration::from_millis(50))
            .await;
    }
}

/// A node's centre moved by `dx`, `dy` (a row's empty part beside its
/// button, say).
fn offset((x, y): (f32, f32), p: &Value) -> (f32, f32) {
    let d = |k: &str| p.get(k).and_then(Value::as_f64).unwrap_or(0.0) as f32;
    (x + d("dx"), y + d("dy"))
}

async fn press_node(p: &Value, cx: &mut AsyncApp) -> Out {
    // Let a menu or a dialog finish moving in, so the node is where it
    // stays (dr-ui's motions are 420 ms at most).
    let settle = p.get("settle_ms").and_then(Value::as_u64).unwrap_or(300);
    if settle > 0 {
        cx.background_executor()
            .timer(Duration::from_millis(settle))
            .await;
    }
    let node = wait_for_node(p, cx).await?;
    let via = p.get("via").and_then(Value::as_str).unwrap_or("pointer");
    match via {
        "pointer" => {
            let (x, y) = offset(node.center(), p);
            // The pointer rests there a moment first, as a hand does: a
            // control that only shows while its row is hovered (an alias's
            // ×) is drawn, and so can be hit, from the next frame on.
            let rest = p.get("hover_ms").and_then(Value::as_u64).unwrap_or(120);
            if rest > 0 {
                cx.update(|cx| {
                    in_window(cx, |_, window, cx| hover_at(x, y, window, cx))?;
                    pump(cx).map(|_| ())
                })?;
                cx.background_executor()
                    .timer(Duration::from_millis(rest))
                    .await;
                cx.update(pump)?;
            }
            cx.update(|cx| {
                in_window(cx, |_, window, cx| {
                    let size = window.viewport_size();
                    if x < 0.0 || y < 0.0 || x >= f32::from(size.width) || y >= f32::from(size.height) {
                        return Err(BridgeError::new(
                            codes::NOT_FOUND,
                            format!(
                                "{} is at ({x:.0}, {y:.0}), outside the window ({:.0} × {:.0}): scroll it into view first",
                                node.label.as_deref().unwrap_or(&node.role),
                                f32::from(size.width),
                                f32::from(size.height)
                            ),
                        ));
                    }
                    click_at(x, y, MouseButton::Left, 1, window, cx);
                    Ok(())
                })?
            })?;
        }
        "a11y" | "increment" | "decrement" => {
            let action = match via {
                "increment" => a11y::Action::Increment,
                "decrement" => a11y::Action::Decrement,
                _ => a11y::Action::Press,
            };
            let q = Query::of(p);
            let pressed = cx.update(|cx| {
                in_window(cx, |_, window, _| {
                    // The node found above (`nth` and `within` chose it).
                    a11y::perform(window, 0, action, |n| {
                        q.matches(n) && n.bounds == node.bounds
                    })
                })
            })?;
            if pressed.is_none() {
                return Err(not_found(format!(
                    "{} went away before the press",
                    q.describe()
                )));
            }
        }
        other => {
            return Err(bad(format!(
                "via {other}: pointer, a11y, increment or decrement"
            )));
        }
    }
    Ok(json!({ "pressed": node.to_json(), "via": via }))
}

/// Gives a text field the keyboard, as clicking into it would.
fn focus_field(p: &Value, cx: &mut App) -> Out {
    let field = string(p, "field")?.to_owned();
    let row = p.get("row").and_then(Value::as_u64).map(|r| r as usize);
    let select_all = p.get("select_all") == Some(&json!(true));
    in_window(cx, move |view, window, cx| {
        let ws = view.read(cx);
        // Settings' search field: the panel's own focus call.
        if field == "settings.search" {
            let panel = ws
                .settings
                .clone()
                .ok_or_else(|| not_found("Settings is not open"))?;
            panel.update(cx, |panel, cx| panel.focus(window, cx));
            return Ok(json!({ "focused": field }));
        }
        let target = ws
            .nav
            .current()
            .cloned()
            .ok_or_else(|| not_found("the paper shows the Project Home, not a page"))?;
        let handle = match field.as_str() {
            "page.title" | "page.synopsis" => {
                let doc = ws
                    .editors
                    .get(&target.key())
                    .and_then(|e| e.doc.clone())
                    .ok_or_else(|| not_found(format!("{} has no editor open", target.key())))?;
                let (head, _) = dr_view_page::page_views(&doc, cx).ok_or_else(|| {
                    not_found(format!(
                        "{doc}: no page head drawn (a chapter page has one)"
                    ))
                })?;
                let head = head.read(cx);
                if field == "page.title" {
                    head.title().focus_handle(cx)
                } else {
                    head.synopsis().focus_handle(cx)
                }
            }
            f if f.starts_with("element.") => {
                let Target::Element(id) = &target else {
                    return Err(not_found(format!(
                        "{} is not an element's page",
                        target.key()
                    )));
                };
                let (head, fields) = dr_view_elements::element_page(id.as_ref(), cx)
                    .ok_or_else(|| not_found("the element page's fields are not drawn yet"))?;
                let (name, alias, summary) = head.read(cx).fields();
                match f {
                    "element.name" => name.focus_handle(cx),
                    "element.alias" => alias.focus_handle(cx),
                    "element.summary" => summary.focus_handle(cx),
                    "element.field.key" | "element.field.value" => {
                        let rows = fields.read(cx).rows();
                        let ix = row.unwrap_or(rows.len().saturating_sub(1));
                        let (_, key, value) = rows.get(ix).ok_or_else(|| {
                            not_found(format!("no field row {ix} ({} rows)", rows.len()))
                        })?;
                        if f == "element.field.key" {
                            key.focus_handle(cx)
                        } else {
                            value.focus_handle(cx)
                        }
                    }
                    other => return Err(bad(format!("no field {other}"))),
                }
            }
            "category.name" => {
                let Target::Category(id) = &target else {
                    return Err(not_found(format!(
                        "{} is not a category's page",
                        target.key()
                    )));
                };
                let (head, _) = dr_view_elements::category_page(id.as_ref(), cx)
                    .ok_or_else(|| not_found("the category page's head is not drawn yet"))?;
                head.read(cx).name_field().focus_handle(cx)
            }
            other => return Err(bad(format!("no field {other}"))),
        };
        window.focus(&handle, cx);
        if select_all {
            select_all_in(&field, &target, row, window, cx);
        }
        Ok(json!({ "focused": field }))
    })?
}

/// Selects a field's whole text, as a triple click would (⌘A in a field is
/// the menu's Select All while the shell binds it without a context).
fn select_all_in(field: &str, target: &Target, row: Option<usize>, _: &mut Window, cx: &mut App) {
    match field {
        "page.title" | "page.synopsis" => {
            if let Some((head, _)) = dr_view_page::page_views(&doc_key(target), cx) {
                let area = if field == "page.title" {
                    head.read(cx).title().clone()
                } else {
                    head.read(cx).synopsis().clone()
                };
                area.update(cx, |a, cx| a.select_all_text(cx));
            }
        }
        f if f.starts_with("element.") => {
            let Target::Element(id) = target else { return };
            let Some((head, fields)) = dr_view_elements::element_page(id.as_ref(), cx) else {
                return;
            };
            let (name, alias, summary) = head.read(cx).fields();
            match f {
                "element.name" => name.update(cx, |a, cx| a.select_all_text(cx)),
                "element.alias" => alias.update(cx, |a, cx| a.select_all_text(cx)),
                "element.summary" => summary.update(cx, |a, cx| a.select_all_text(cx)),
                "element.field.key" | "element.field.value" => {
                    let rows = fields.read(cx).rows();
                    let ix = row.unwrap_or(rows.len().saturating_sub(1));
                    if let Some((_, key, value)) = rows.get(ix) {
                        if f == "element.field.key" {
                            key.update(cx, |a, cx| a.select_all_text(cx));
                        } else {
                            value.update(cx, |a, cx| a.select_all_text(cx));
                        }
                    }
                }
                _ => {}
            }
        }
        "category.name" => {
            if let Target::Category(id) = target
                && let Some((head, _)) = dr_view_elements::category_page(id.as_ref(), cx)
            {
                let name = head.read(cx).name_field();
                name.update(cx, |a, cx| a.select_all_text(cx));
            }
        }
        _ => {}
    }
}

/// The prose document of a chapter page (`node:<id>`).
fn doc_key(target: &Target) -> String {
    match target {
        Target::Chapter(id) | Target::Idea(id) => format!("node:{id}"),
        other => other.key(),
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

/// Arms the answer for the next system panel.
fn arm(answer: Option<crate::panel::Answer>) -> Out {
    if !crate::panel::arm(answer) {
        return Err(BridgeError::new(
            codes::UNSUPPORTED,
            "the system's open and save panels are answered on macOS only",
        ));
    }
    Ok(crate::panel::state())
}

/// M41's dialog (book import, backup, restore) when it is the one over the
/// window: its state, title and sentences.
fn transfer_of(ws: &Workspace, cx: &App) -> Value {
    use dr_view_transfer::{State, TransferDialog};
    let Some(dialog) = ws
        .dialog
        .clone()
        .and_then(|v| v.downcast::<TransferDialog>().ok())
    else {
        return Value::Null;
    };
    let t = |k: dr_i18n::Key| dr_shell::t(cx, k).to_string();
    match &dialog.read(cx).state {
        State::Working {
            title,
            name,
            progress,
        } => json!({ "state": "working", "title": t(*title), "text": name, "progress": progress }),
        State::Done { title, text } => json!({ "state": "done", "title": t(*title), "text": text }),
        State::Confirm {
            title,
            text,
            confirm,
        } => {
            json!({ "state": "confirm", "title": t(*title), "text": text, "confirm": t(*confirm) })
        }
        State::Failed {
            title,
            reason,
            text,
        } => {
            json!({ "state": "failed", "title": t(*title), "reason": reason.name(), "text": text })
        }
    }
}

#[cfg(test)]
mod query_tests {
    use super::*;

    fn node(role: &str, label: &str, bounds: [f32; 4]) -> a11y::Node {
        a11y::Node {
            role: role.into(),
            label: Some(label.into()),
            value: None,
            help: None,
            bounds,
            focused: false,
            enabled: true,
            depth: 0,
        }
    }

    #[test]
    fn within_picks_the_buttons_inside_one_card() {
        let all = vec![
            node("Button", "Open 夜车", [0.0, 0.0, 200.0, 300.0]),
            node("Button", "Export", [150.0, 10.0, 20.0, 20.0]),
            node("Button", "Open 慢钟", [220.0, 0.0, 200.0, 300.0]),
            node("Button", "Export", [370.0, 10.0, 20.0, 20.0]),
        ];
        let q = Query::of(&json!({ "label": "Export", "within": { "label": "Open 慢钟" } }));
        let found = q.select(&all);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].bounds[0], 370.0);
        assert_eq!(
            q.describe(),
            "label \"Export\", inside (label \"Open 慢钟\")"
        );
        // Without the card nothing is inside it; without `within`, both.
        let none = Query::of(&json!({ "label": "Export", "within": { "label": "Open 无书" } }));
        assert!(none.select(&all).is_empty());
        assert_eq!(
            Query::of(&json!({ "label": "Export" })).select(&all).len(),
            2
        );
        // The card itself is not inside itself.
        let cards = Query::of(&json!({ "role": "Button", "within": { "label": "Open 慢钟" } }));
        assert_eq!(cards.select(&all).len(), 1);
    }
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
