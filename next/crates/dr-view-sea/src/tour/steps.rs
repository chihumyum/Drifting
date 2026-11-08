//! The workspace tour's six steps as data (the 0.1 client's
//! `features/guide/workspace-tour.ts`) and how a step finds what it points
//! at in one frame's anchors.

use dr_i18n::{Key, keys};
use dr_shell::{Settings, keymap};
use gpui::{App, Bounds, Pixels, SharedString, Size};

use super::{anchor::Shown, geometry};

use keys::guide::workspace as w;

/// The anchor ids the workspace tour points at. A control is marked with
/// [`super::anchor`] under one of these.
/// They are the shell's (`dr_shell::pages::anchors`), so the shell can mark
/// its own controls without this crate.
pub mod ids {
    pub use dr_shell::pages::anchors::*;
}

/// What the device remembers having shown (the 0.1 client's `guidesSeen`
/// entry for this tour).
pub const WORKSPACE_TOUR_ID: &str = "workspace-tour";

/// How a step's targets make one ring.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pick {
    /// The first of them that shows.
    First,
    /// One ring round every one that shows.
    Union,
}

/// Where a step points while its control is put away (a closed sidebar's
/// own toggle), and what it says there. Opening it moves the ring onto the
/// control.
#[derive(Clone, Copy, Debug)]
pub struct Fallback {
    pub targets: &'static [&'static str],
    pub body: Key,
}

/// A shortcut written under a step's sentence, in index type, no keycaps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shortcut {
    /// A shortcut of the registry ([`dr_shell::keymap`]) by its id, as it is
    /// bound now (the author may have rebound it). One the registry does
    /// not have, or that is unbound, shows nothing.
    Bound(&'static str),
    /// Fixed keys in GPUI's syntax: `secondary-enter` reads ⌘↩ on macOS and
    /// Ctrl+Enter elsewhere.
    Keys(&'static str),
}

#[derive(Clone, Copy, Debug)]
pub struct Step {
    pub id: &'static str,
    /// Anchor ids ([`ids`]); a step with none of them on screen (and no
    /// fallback showing) is passed over.
    pub targets: &'static [&'static str],
    pub pick: Pick,
    pub title: Key,
    pub body: Key,
    pub fallback: Option<Fallback>,
    pub shortcuts: &'static [Shortcut],
}

/// What a step points at in one frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Target {
    /// What it points at, before the ring's outset.
    pub rect: Bounds<Pixels>,
    /// Pointing at the fallback (with its sentence).
    pub fallback: bool,
}

impl Step {
    /// Its control when that is on screen, else its fallback, else nothing
    /// (`resolveGuideTarget`).
    pub fn resolve(&self, shown: &Shown, viewport: Size<Pixels>) -> Option<Target> {
        if let Some(rect) = pick(self.targets, self.pick, shown, viewport) {
            return Some(Target {
                rect,
                fallback: false,
            });
        }
        let fallback = self.fallback?;
        pick(fallback.targets, Pick::First, shown, viewport).map(|rect| Target {
            rect,
            fallback: true,
        })
    }

    /// The sentence it says where it points.
    pub fn body(&self, fallback: bool) -> Key {
        match self.fallback {
            Some(f) if fallback => f.body,
            _ => self.body,
        }
    }
}

fn pick(
    targets: &[&str],
    pick: Pick,
    shown: &Shown,
    viewport: Size<Pixels>,
) -> Option<Bounds<Pixels>> {
    let mut on = targets
        .iter()
        .flat_map(|id| shown.bounds(id))
        .filter(|rect| geometry::on_screen(*rect, viewport));
    match pick {
        Pick::First => on.next(),
        Pick::Union => geometry::union(on),
    }
}

/// The first time a book opens on this device: where the book's parts
/// live, the whole-window views, making things, the timeline, the Agent and
/// the way back to the book's home page. Each step points at the control
/// itself.
pub static WORKSPACE_TOUR: [Step; 6] = [
    Step {
        id: "panels",
        targets: &[ids::LEFT_PANEL_TAB],
        pick: Pick::Union,
        title: w::panels::TITLE,
        body: w::panels::BODY,
        fallback: Some(Fallback {
            targets: &[ids::LEFT_SIDEBAR_CLOSED_TOGGLE],
            body: w::panels::CLOSED_BODY,
        }),
        shortcuts: &[],
    },
    Step {
        id: "super-views",
        targets: &[ids::SUPER_VIEW_ENTRY],
        pick: Pick::First,
        title: w::super_views::TITLE,
        body: w::super_views::BODY,
        fallback: None,
        shortcuts: &[],
    },
    Step {
        id: "create",
        targets: &[ids::HOME_CREATE],
        pick: Pick::First,
        title: w::create::TITLE,
        body: w::create::BODY,
        fallback: None,
        shortcuts: &[Shortcut::Bound("newEntity")],
    },
    Step {
        id: "timeline",
        targets: &[ids::TIMELINE_TOGGLE],
        pick: Pick::First,
        title: w::timeline::TITLE,
        body: w::timeline::BODY,
        fallback: None,
        shortcuts: &[Shortcut::Bound("toggleBottomTimeline")],
    },
    Step {
        id: "agent",
        targets: &[ids::AGENT_TAB],
        pick: Pick::First,
        title: w::agent::TITLE,
        body: w::agent::BODY,
        fallback: Some(Fallback {
            targets: &[ids::RIGHT_SIDEBAR_CLOSED_TOGGLE],
            body: w::agent::CLOSED_BODY,
        }),
        // The Agent's composer sends with ⌘↩.
        shortcuts: &[Shortcut::Keys("secondary-enter")],
    },
    Step {
        id: "home",
        targets: &[ids::PROJECT_HOME, ids::NOTIFICATIONS],
        pick: Pick::Union,
        title: w::home::TITLE,
        body: w::home::BODY,
        fallback: None,
        shortcuts: &[],
    },
];

/// How `shortcut` reads on this system now: `⌘N` on macOS, `Ctrl+N`
/// elsewhere (the registry's [`keymap::display`]).
pub fn shortcut_text(shortcut: Shortcut, cx: &App) -> Option<SharedString> {
    let keys = match shortcut {
        Shortcut::Bound(id) => {
            let bound = keymap::find(id)?;
            let overrides = if cx.has_global::<Settings>() {
                Settings::read(cx).key_bindings()
            } else {
                Default::default()
            };
            bound.effective(&overrides).into_iter().next()?
        }
        Shortcut::Keys(keys) => keys.to_owned(),
    };
    Some(keymap::display(&keys, cx.platform_info().os).into())
}
