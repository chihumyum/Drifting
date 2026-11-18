//! Device settings and lifecycle for the format 5 Markdown folder.

use std::{
    cell::Cell,
    collections::{HashMap, HashSet},
    path::PathBuf,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use dr_i18n::{Key, keys};
use dr_mirror::{Issue, Mirror, Options, Problem};
use dr_ui::{
    Theme,
    components::{Button, Dialog},
};
use futures::{FutureExt, StreamExt, future::Shared};
use gpui::{
    App, AppContext as _, Context, FocusHandle, Focusable, Global, IntoElement, ParentElement as _,
    Render, Styled as _, Task, Window, div, px,
};

use crate::{
    Services, Settings, ShellInfo,
    notifications::{NoticeAction, Notifications, Source},
    release, settings,
    strings::{Strings, t, tp},
};

pub const FOLDER_KEY: &str = "markdown.folder";
pub const OFF_KEY: &str = "markdown.disabled";

type Drain = Shared<Task<Result<(), String>>>;
type IssueKey = (PathBuf, Problem, Option<PathBuf>);

fn issue_key(issue: &Issue) -> IssueKey {
    (issue.path.clone(), issue.problem, issue.kept.clone())
}

#[derive(Default)]
struct State {
    running: Option<Mirror>,
    pending: Option<Drain>,
    _pump: Option<Task<()>>,
    told: HashMap<IssueKey, u64>,
    composing: Arc<AtomicUsize>,
}

impl Global for State {}

enum Heard {
    Issues(Vec<Issue>),
    Kept(usize),
}

pub fn init(cx: &mut App) {
    let composing = cx.default_global::<State>().composing.clone();
    cx.observe_new::<gpui_prose::ProseEditor>(move |editor, _, cx| {
        let active = editor.composition().is_some();
        if active {
            composing.fetch_add(1, Ordering::Relaxed);
        }
        let counted = Rc::new(Cell::new(active));
        let observed = counted.clone();
        let counter = composing.clone();
        cx.observe_self(move |editor, _| {
            let active = editor.composition().is_some();
            if observed.replace(active) != active {
                if active {
                    counter.fetch_add(1, Ordering::Release);
                } else {
                    counter.fetch_sub(1, Ordering::Release);
                }
            }
        })
        .detach();
        let counter = composing.clone();
        cx.on_release(move |_, _| {
            if counted.get() {
                counter.fetch_sub(1, Ordering::Release);
            }
        })
        .detach();
    })
    .detach();
    // M40 may write after the editor and field drains, so it runs before
    // checkpoints and the Hosted outbound drain take their frontiers.
    release::after_drain(cx, |cx| {
        let pending = drain(cx);
        let app = cx.to_async();
        async move {
            if let Err(error) = pending.await {
                app.update(|cx| report_drain_failure(error, cx));
            }
            // The library already owns the durable prose. An unavailable
            // Markdown copy must not prevent checkpoints or Hosted's drain.
            Ok(())
        }
        .boxed_local()
    });
    release::after_release(cx, start);
    settings::set_module_row(cx, "local.markdown_folder", setting);
    cx.observe_global::<Strings>(|cx| reconfigure(cx, |_| {}))
        .detach();
    start(cx);
}

pub fn folder(cx: &App) -> Option<PathBuf> {
    Settings::device_memory(cx, FOLDER_KEY)?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

pub fn is_on(cx: &App) -> bool {
    Settings::device_memory(cx, OFF_KEY).and_then(|v| v.as_bool()) != Some(true)
}

pub fn choose(cx: &mut App) {
    let prompt = t(cx, keys::settings::sync::projection::CHOOSE);
    let pending = cx.prompt_for_paths(gpui::PathPromptOptions {
        files: false,
        directories: true,
        multiple: false,
        prompt: Some(prompt),
    });
    cx.spawn(async move |cx| {
        let Ok(Ok(Some(paths))) = pending.await else {
            return;
        };
        if let Some(folder) = paths.into_iter().next() {
            cx.update(|cx| set_folder(folder, cx));
        }
    })
    .detach();
}

pub fn set_folder(folder: PathBuf, cx: &mut App) {
    reconfigure(cx, move |cx| {
        Settings::set_device_memory(
            cx,
            FOLDER_KEY,
            Some(folder.to_string_lossy().into_owned().into()),
        );
    });
}

fn drain(cx: &mut App) -> Drain {
    if let Some(pending) = cx.default_global::<State>().pending.clone() {
        return pending;
    }
    let state = cx.default_global::<State>();
    let old = state.running.take();
    let failed = t(cx, keys::k4_pages::SAVE_FAILED).to_string();
    cx.background_executor()
        .spawn(async move {
            let Some(mirror) = old else { return Ok(()) };
            let result = wait_for_settled(|| mirror.sync_now(), &failed);
            mirror.stop();
            result
        })
        .shared()
}

fn wait_for_settled(
    mut pass: impl FnMut() -> Result<dr_mirror::Report, String>,
    failed: &str,
) -> Result<(), String> {
    let since = Instant::now();
    loop {
        let result = pass()?;
        if result.issues.iter().any(|i| i.problem == Problem::Disk) {
            return Err(failed.into());
        }
        if !result.waiting {
            return Ok(());
        }
        if since.elapsed() >= Duration::from_secs(5) {
            return Err(failed.into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn reconfigure(cx: &mut App, apply: impl FnOnce(&mut App) + 'static) {
    if release::is_releasing(cx) || cx.default_global::<State>().pending.is_some() {
        return;
    }
    if cx.default_global::<State>().running.is_none() {
        apply(cx);
        start(cx);
        cx.refresh_windows();
        return;
    }
    let pending = drain(cx);
    cx.default_global::<State>().pending = Some(pending.clone());
    cx.spawn(async move |cx| {
        let result = pending.await;
        cx.update(|cx| {
            cx.default_global::<State>().pending = None;
            if let Err(error) = result {
                report_drain_failure(error, cx);
            }
            apply(cx);
            start(cx);
            cx.refresh_windows();
        });
    })
    .detach();
}

fn report_drain_failure(error: String, cx: &mut App) {
    log::warn!("Markdown folder could not finish its final pass: {error}");
    Notifications::post(Source::MarkdownFolder, error, cx);
}

fn projection_names(cx: &App) -> dr_mirror::layout::Names {
    dr_mirror::layout::Names {
        contents: t(cx, keys::mirror_v5::CONTENTS).to_string(),
        assets: t(cx, keys::v5_files::LIBRARY_ROOT).to_string(),
        untitled: t(cx, keys::common::UNTITLED).to_string(),
    }
}

fn start(cx: &mut App) {
    if release::is_releasing(cx)
        || cx.default_global::<State>().pending.is_some()
        || cx.default_global::<State>().running.is_some()
    {
        return;
    }
    let (Some(root), true) = (folder(cx), is_on(cx)) else {
        return;
    };
    let Some(ws) = cx
        .try_global::<Services>()
        .and_then(|services| services.library.clone())
    else {
        return;
    };
    let Some(installation) = ws
        .library()
        .options()
        .device
        .as_ref()
        .map(|device| device.installation_id())
    else {
        return;
    };
    let app = cx
        .try_global::<ShellInfo>()
        .map_or("cc.drifting.next.dev", |info| info.bundle_id);
    let mut options = Options::new(root, installation, app);
    options.names = projection_names(cx);
    options.author = t(cx, keys::notifications::markdown_folder::SOURCE).to_string();
    options.conflict = t(cx, keys::notifications::markdown_folder::OVERLAP).to_string();
    use keys::editor_top_bar::status;
    options.labels.options = [
        ("draft", status::DRAFT),
        ("finished", status::FINISHED),
        ("discarded", status::DISCARDED),
        ("drifting", status::DRIFTING),
        ("resting", status::RESTING),
    ]
    .into_iter()
    .map(|(raw, key)| (raw.to_owned(), t(cx, key).to_string()))
    .collect();
    options.marker = |text| dr_editor::todo::parse(text).map(|(_, task)| task);
    let composing = cx.default_global::<State>().composing.clone();
    options.composing = Arc::new(move || composing.load(Ordering::Acquire) > 0);
    let mirror = match Mirror::start(ws, options) {
        Ok(mirror) => mirror,
        Err(error) => {
            log::warn!("Markdown folder could not start: {error}");
            Notifications::post(
                Source::MarkdownFolder,
                t(cx, problem_key(Problem::Disk)),
                cx,
            );
            return;
        }
    };
    let (tx, mut rx) = futures::channel::mpsc::unbounded::<Heard>();
    let keep = tx.clone();
    mirror.on_issues(move |issues| {
        let _ = tx.unbounded_send(Heard::Issues(issues.to_vec()));
    });
    mirror.on_preserved(move |files| {
        let _ = keep.unbounded_send(Heard::Kept(files.len()));
    });
    let pump = cx.spawn(async move |cx| {
        while let Some(next) = rx.next().await {
            cx.update(|cx| tell(next, cx));
        }
    });
    let state = cx.default_global::<State>();
    state.running = Some(mirror);
    state._pump = Some(pump);
}

fn tell(heard: Heard, cx: &mut App) {
    match heard {
        Heard::Kept(0) => {}
        Heard::Kept(count) => {
            let text = tp(
                cx,
                keys::notifications::markdown_folder::PRESERVED,
                count as u64,
                &[],
            );
            Notifications::post(Source::MarkdownFolder, text, cx);
        }
        Heard::Issues(issues) => {
            let mut before = std::mem::take(&mut cx.default_global::<State>().told);
            let active: HashSet<_> = issues.iter().map(issue_key).collect();
            // Free resolved notices before adding new ones: the notification
            // center is bounded, including pinned notices.
            before.retain(|key, id| {
                if active.contains(key) {
                    true
                } else {
                    Notifications::remove(*id, cx);
                    false
                }
            });
            let mut next = HashMap::new();
            for issue in issues {
                let key = issue_key(&issue);
                if next.contains_key(&key) {
                    continue;
                }
                let id = before
                    .remove(&key)
                    .filter(|id| {
                        Notifications::items(cx)
                            .iter()
                            .any(|notice| notice.id == *id)
                    })
                    .unwrap_or_else(|| {
                        let text =
                            format!("{}\n{}", issue.title, t(cx, problem_key(issue.problem)));
                        let opens = issue.doc.clone().map(|doc| (issue.book.clone(), doc));
                        let action = cx
                            .default_global::<State>()
                            .running
                            .as_ref()
                            .is_some_and(|mirror| mirror.can_acknowledge(&issue))
                            .then(|| NoticeAction {
                                label: t(cx, keys::mirror_v5::ACKNOWLEDGE_PRESERVED),
                                run: Rc::new(move |_, _, cx| {
                                    if let Some(mirror) = &cx.default_global::<State>().running {
                                        mirror.acknowledge(issue.clone());
                                    }
                                }),
                            });
                        Notifications::post_opening(Source::MarkdownFolder, text, opens, action, cx)
                    });
                Notifications::set_pinned(id, true, cx);
                next.insert(key, id);
            }
            for (_, id) in before {
                Notifications::remove(id, cx);
            }
            cx.default_global::<State>().told = next;
        }
    }
}

fn problem_key(problem: Problem) -> Key {
    use keys::{mirror_v5, notifications::markdown_folder::issue};
    match problem {
        Problem::Frontmatter => issue::FRONTMATTER,
        Problem::WrongId => mirror_v5::IDENTITY,
        Problem::Emptied => issue::EMPTY,
        Problem::StaleBase => mirror_v5::LINEAGE,
        Problem::NotUtf8 => issue::ENCODING,
        Problem::TooLarge => issue::TOO_LARGE,
        Problem::OwnedElsewhere => mirror_v5::OWNED,
        Problem::UnsafePath => mirror_v5::UNSAFE_PATH,
        Problem::Occupied => mirror_v5::OCCUPIED,
        Problem::Duplicate => mirror_v5::DUPLICATE,
        Problem::Moved => mirror_v5::MOVED,
        Problem::ReadOnly => mirror_v5::READ_ONLY,
        Problem::MalformedTable => mirror_v5::MALFORMED_TABLE,
        Problem::UnknownImage => mirror_v5::UNKNOWN_IMAGE,
        Problem::FieldConflict => mirror_v5::FIELD_CONFLICT,
        Problem::Disk => issue::UNREADABLE,
        Problem::KeyCollision => mirror_v5::KEY_COLLISION,
    }
}

fn setting(window: &mut Window, cx: &mut App) -> gpui::AnyElement {
    use keys::settings::sync::projection as k;
    let theme = Theme::of(window, cx);
    let folder = folder(cx);
    let on = is_on(cx);
    let busy = cx.default_global::<State>().pending.is_some();
    let reveal = folder.clone();
    let top = settings::row(
        "local.markdown_folder",
        t(cx, k::TITLE),
        Some(if on {
            t(cx, keys::mirror_v5::INTRO)
        } else {
            t(cx, k::OFF_HINT)
        }),
        if on {
            Button::new("markdown-reveal", t(cx, k::REVEAL))
                .small()
                .disabled(folder.is_none())
                .on_click(move |_, _, cx| {
                    if let Some(path) = &reveal {
                        cx.open_with_system(path);
                    }
                })
                .into_any_element()
        } else {
            Button::new("markdown-on", t(cx, k::TURN_ON))
                .primary()
                .small()
                .disabled(busy)
                .on_click(|_, _, cx| {
                    reconfigure(cx, |cx| Settings::set_device_memory(cx, OFF_KEY, None))
                })
                .into_any_element()
        },
        &theme,
    );
    let Some(location) = on.then(|| {
        let choose_button = Button::new("markdown-choose", t(cx, k::CHOOSE))
            .small()
            .disabled(busy);
        let choose_button = if folder.is_none() {
            choose_button.primary()
        } else {
            choose_button
        };
        let controls = div()
            .flex()
            .items_center()
            .gap(px(6.0))
            .child(choose_button.on_click(|_, _, cx| choose(cx)))
            .child(
                Button::new("markdown-off", t(cx, k::TURN_OFF))
                    .danger()
                    .small()
                    .disabled(busy)
                    .on_click(|_, _, cx| ask_turn_off_then(cx, |_| {})),
            );
        settings::row(
            "local.markdown_location",
            t(
                cx,
                if folder.is_some() {
                    k::ALL_PROJECTS
                } else {
                    k::ALL_PROJECTS_UNSET
                },
            ),
            folder.map(|p| p.display().to_string().into()),
            controls.into_any_element(),
            &theme,
        )
    }) else {
        return top;
    };
    div()
        .flex()
        .flex_col()
        .child(top)
        .child(location)
        .into_any_element()
}

struct TurnOff {
    focus: FocusHandle,
    after: Rc<dyn Fn(&mut App)>,
}

impl Focusable for TurnOff {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for TurnOff {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        use keys::settings::sync::projection as k;
        let me = cx.entity_id();
        let after = self.after.clone();
        Dialog::new("markdown-off", t(cx, k::OFF_TITLE))
            .body(div().child(t(cx, keys::mirror_v5::OFF_WARNING)))
            .action(
                Button::new("markdown-off-cancel", t(cx, keys::common::CANCEL))
                    .on_click(move |_, _, cx| crate::dialogs::hide(cx, me)),
            )
            .action(
                Button::new("markdown-off-confirm", t(cx, k::TURN_OFF))
                    .danger()
                    .on_click(move |_, _, cx| {
                        let after = after.clone();
                        crate::dialogs::hide(cx, me);
                        reconfigure(cx, move |cx| {
                            Settings::set_device_memory(cx, OFF_KEY, Some(true.into()));
                            after(cx);
                        });
                    }),
            )
            .on_close(move |_, cx| crate::dialogs::hide(cx, me))
    }
}

pub fn ask_turn_off_then(cx: &mut App, after: impl Fn(&mut App) + 'static) {
    let view = cx.new(|cx| TurnOff {
        focus: cx.focus_handle(),
        after: Rc::new(after),
    });
    crate::dialogs::show(cx, view.into());
}

#[cfg(test)]
mod tests;
