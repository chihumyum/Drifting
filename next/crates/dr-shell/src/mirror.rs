//! The Markdown folder (M40, `dr-mirror`) under the running app: started
//! over the open library when the author has chosen a folder and not turned
//! it off, stopped (a last pass, pending writes made) before the library
//! closes for a swap or a quit, its problems in the notification center.
//!
//! - Where and whether are device values ([`crate::Settings::device_memory`]
//!   `markdown.folder`, `markdown.disabled`), never synced. No folder, no
//!   files (the 0.1 rule since 11-06).
//! - Each file that cannot be merged is one notice (Source::MarkdownFolder):
//!   its title, then the reason; clicking it opens the chapter. The same file
//!   for the same reason is told once; fixed, or for another reason, the
//!   notice goes (0.1's rule). Files kept under `.drifting/preserved` are
//!   told as a count.
//! - Settings → 本地数据 → Markdown 文件夹 chooses the folder, opens it in
//!   the Finder and turns it off (after a question).

use std::collections::HashMap;
use std::path::PathBuf;

use dr_i18n::keys;
use dr_mirror::{Issue, Mirror, Options, Problem};
use dr_ui::components::{Button, Dialog};
use futures::StreamExt as _;
use gpui::{
    App, AppContext as _, Context, FocusHandle, Focusable, Global, IntoElement, ParentElement as _,
    Render, Task, Window, div,
};

use crate::notifications::{Notifications, Source};
use crate::strings::{t, tp};
use crate::{Services, Settings, ShellInfo};

/// The device value: the folder every book's folder goes under.
pub const FOLDER_KEY: &str = "markdown.folder";
/// The device value: turned off (`true`).
pub const OFF_KEY: &str = "markdown.disabled";

#[derive(Default)]
struct State {
    running: Option<Mirror>,
    pump: Option<Task<()>>,
    /// The notice told for each file, and why.
    told: HashMap<PathBuf, (Problem, u64)>,
}

impl Global for State {}

enum Heard {
    Issues(Vec<Issue>),
    Kept(usize),
}

/// The folder chosen on this device, if any.
pub fn folder(cx: &App) -> Option<PathBuf> {
    Settings::device_memory(cx, FOLDER_KEY)?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Whether the folder is on (it is unless the author turned it off).
pub fn is_on(cx: &App) -> bool {
    !Settings::device_memory(cx, OFF_KEY)
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Whether the folder is being followed now.
pub fn is_running(cx: &App) -> bool {
    cx.try_global::<State>()
        .is_some_and(|s| s.running.is_some())
}

/// The author chose `folder`: written there from now on.
pub fn set_folder(folder: PathBuf, cx: &mut App) {
    Settings::set_device_memory(
        cx,
        FOLDER_KEY,
        Some(folder.to_string_lossy().into_owned().into()),
    );
    restart(cx);
}

/// Turns the folder on or off.
pub fn set_on(on: bool, cx: &mut App) {
    Settings::set_device_memory(cx, OFF_KEY, (!on).then(|| true.into()));
    restart(cx);
}

/// Stops following the folder: a last pass, what is pending written. Call
/// before the library closes (a swap, a quit).
pub fn stop(cx: &mut App) {
    if !cx.has_global::<State>() {
        return;
    }
    let state = cx.global_mut::<State>();
    let running = state.running.take();
    state.pump = None;
    if let Some(mirror) = running {
        if let Err(error) = mirror.sync_now() {
            log::warn!("Markdown folder: the last pass failed: {error}");
        }
        mirror.stop();
    }
}

/// Follows the folder over the open library when there is one and it is on
/// (the one running stops first).
pub fn restart(cx: &mut App) {
    stop(cx);
    let Some(lib) = cx.try_global::<Services>().and_then(|s| s.library.clone()) else {
        return;
    };
    let (Some(root), true) = (folder(cx), is_on(cx)) else {
        return;
    };
    // A folder belongs to one installation (`.drifting/owner.json`).
    let Some(installation) = lib
        .library()
        .options()
        .device
        .as_ref()
        .map(|d| d.installation_id())
    else {
        log::warn!("Markdown folder: this device has no identity; not started");
        return;
    };
    let app = cx
        .try_global::<ShellInfo>()
        .map_or("cc.drifting.next.dev", |i| i.bundle_id);
    let mirror = match Mirror::start(lib, Options::new(root, installation, app)) {
        Ok(mirror) => mirror,
        Err(error) => {
            log::warn!("Markdown folder: could not start: {error}");
            return;
        }
    };
    // The mirror tells on its own thread; the notices are posted here.
    let (tx, mut rx) = futures::channel::mpsc::unbounded::<Heard>();
    let kept = tx.clone();
    mirror.on_issues(move |issues| {
        let _ = tx.unbounded_send(Heard::Issues(issues.to_vec()));
    });
    mirror.on_preserved(move |files| {
        let _ = kept.unbounded_send(Heard::Kept(files.len()));
    });
    let pump = cx.spawn(async move |cx| {
        while let Some(heard) = rx.next().await {
            cx.update(|cx| tell(heard, cx));
        }
    });
    let state = cx.default_global::<State>();
    state.running = Some(mirror);
    state.pump = Some(pump);
}

fn tell(heard: Heard, cx: &mut App) {
    match heard {
        Heard::Kept(0) => {}
        Heard::Kept(n) => {
            let text = tp(
                cx,
                keys::notifications::markdown_folder::PRESERVED,
                n as u64,
                &[],
            );
            Notifications::post(Source::MarkdownFolder, text, cx);
        }
        Heard::Issues(issues) => {
            let mut before = std::mem::take(&mut cx.default_global::<State>().told);
            let mut now = HashMap::new();
            for issue in issues {
                let id = match before.remove(&issue.path) {
                    Some((problem, id)) if problem == issue.problem => id,
                    old => {
                        if let Some((_, id)) = old {
                            Notifications::remove(id, cx);
                        }
                        let text = format!("{}\n{}", issue.title, t(cx, issue.problem.message()));
                        let opens = issue.doc.clone().map(|doc| (issue.book.clone(), doc));
                        Notifications::post_opening(Source::MarkdownFolder, text, opens, cx)
                    }
                };
                now.insert(issue.path, (issue.problem, id));
            }
            // Merged since, or gone: the notice goes.
            for (_, (_, id)) in before {
                Notifications::remove(id, cx);
            }
            cx.default_global::<State>().told = now;
        }
    }
}

/// 「关闭 Markdown 文件夹？」 (0.1's `requestConfirmation`): 取消 first, the
/// danger's 关闭 after; turning it off leaves the files where they are.
pub struct TurnOff {
    focus: FocusHandle,
    /// Called once it is off (the first run's step goes on).
    after: Option<crate::pages::InApp>,
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
            .body(div().child(t(cx, k::OFF_WARNING)))
            .action(
                Button::new("markdown-off-cancel", t(cx, keys::common::CANCEL))
                    .on_click(move |_, _, cx| crate::dialogs::hide(cx, me)),
            )
            .action(
                Button::new("markdown-off-confirm", t(cx, k::TURN_OFF))
                    .danger()
                    .on_click(move |_, _, cx| {
                        set_on(false, cx);
                        crate::dialogs::hide(cx, me);
                        if let Some(after) = &after {
                            after(cx);
                        }
                    }),
            )
            .on_close(move |_, cx| crate::dialogs::hide(cx, me))
    }
}

/// Asks before turning the folder off.
pub fn ask_turn_off(cx: &mut App) {
    let view = cx.new(|cx| TurnOff {
        focus: cx.focus_handle(),
        after: None,
    });
    crate::dialogs::show(cx, view.into());
}

/// Asks before turning the folder off; `after` runs once it is off (the
/// first run's Markdown folder step).
pub fn ask_turn_off_then(cx: &mut App, after: impl Fn(&mut App) + 'static) {
    let view = cx.new(|cx| TurnOff {
        focus: cx.focus_handle(),
        after: Some(std::rc::Rc::new(after)),
    });
    crate::dialogs::show(cx, view.into());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SettingsFile, ShellInfo};

    fn issue(path: &str, problem: Problem) -> Issue {
        Issue {
            book: "b1".into(),
            doc: Some("node:c1".into()),
            title: "第一章".into(),
            path: PathBuf::from(path),
            problem,
        }
    }

    fn notices(cx: &mut gpui::TestAppContext) -> Vec<(u64, Option<(String, String)>)> {
        cx.update(|cx| {
            Notifications::items(cx)
                .iter()
                .filter(|n| n.source == Source::MarkdownFolder)
                .map(|n| (n.id, n.opens.clone()))
                .collect()
        })
    }

    /// One notice per file and reason, told once, gone once merged; the
    /// kept files as a count.
    #[gpui::test]
    fn a_files_problem_is_told_once_and_withdrawn(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            crate::init(
                ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "0.2.0-dev",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: None,
                },
                Services::default(),
                SettingsFile::in_memory(),
                cx,
            )
        });
        let a = issue("/f/正文/001.md", Problem::Frontmatter);
        cx.update(|cx| tell(Heard::Issues(vec![a.clone()]), cx));
        let first = notices(cx);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].1, Some(("b1".into(), "node:c1".into())));
        cx.update(|cx| tell(Heard::Issues(vec![a.clone()]), cx));
        assert_eq!(notices(cx), first, "told once");
        let other = issue("/f/正文/001.md", Problem::Emptied);
        cx.update(|cx| tell(Heard::Issues(vec![other]), cx));
        let now = notices(cx);
        assert_eq!(now.len(), 1);
        assert_ne!(now[0].0, first[0].0, "another reason: told again");
        cx.update(|cx| tell(Heard::Issues(Vec::new()), cx));
        assert!(notices(cx).is_empty(), "merged: withdrawn");
        cx.update(|cx| tell(Heard::Kept(3), cx));
        assert_eq!(notices(cx).len(), 1);
    }
}
