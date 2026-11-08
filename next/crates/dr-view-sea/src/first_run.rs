//! The first run (the 0.1 client's `PreAlphaFirstRunGate`, rhythm 甲 that the
//! author chose on 2026-11-03).
//!
//! On the sea the app's name rises first and stands [`TITLE_STANDS`]; then
//! it lets go, and its ring leaves the card behind. The rain falls round
//! the card, the hand still stirs the water, and the sea draws the card's
//! resting line and shows through it at 12%. The card's steps are panes in
//! the same place: a new one dissolves in over the last
//! ([`dr_ui::tokens::motion::PAGE_BLEND`]). The interface language waits in
//! the window's corner the whole way. When nothing is left the card fades
//! as the bookshelf comes up under it ([`LEAVE`]), and the glass on the
//! shelf is set down on the sea ([`arriving`]); the sample book this launch
//! wrote lands on a ring of its own and waits there, its rim flowing, until
//! it is opened ([`sample_on_shelf`]).
//!
//! The steps come from the modules that ask something once per device
//! ([`add_step`]): the welcome and sign-in when there is an account to
//! choose (M35), where the Markdown folders go (M40, [`FolderStep`]). A
//! build with neither raises the name and goes straight to the shelf.

use std::{
    collections::VecDeque,
    rc::Rc,
    time::{Duration, Instant},
};

use dr_i18n::{Locale, keys};
use dr_shell::{Settings, settings::registry, t};
use dr_ui::{
    components::{Button, Choice, Select},
    fonts::{Role, weight},
    sand::Icon,
    style::DrStyled as _,
    theme::Theme,
    tokens::{motion, space},
};
use gpui::{
    AnyElement, App, Context, Global, InteractiveElement, IntoElement, MouseButton, ParentElement,
    Render, SharedString, Styled, Task, Window, div, prelude::FluentBuilder as _, px,
};

use crate::{
    glass::{SeaGlass, on_sea},
    sea::{Hold, HoldKind, Sea},
};

/// How long the app's name stands before it lets go (`FIRST_RUN_TITLE_MS`).
pub const TITLE_STANDS: Duration = Duration::from_millis(1300);
/// The card fades as the shelf comes up under it (`FIRST_RUN_LEAVE_MS`,
/// `--motion-glass-bleed`).
pub const LEAVE: Duration = Duration::from_millis(240);
/// The card fades in this long after the name lets go.
const CARD_IN_DELAY: Duration = Duration::from_millis(120);
/// The sample lands this long after its card comes up
/// (`SAMPLE_LANDING_DELAY_MS`).
pub const SAMPLE_LANDING_DELAY: Duration = Duration::from_millis(240);
/// The ring a landing book makes.
const LANDING_RING: f32 = 1.3;

/// What the hand does on the card: go on when it is answered.
pub type Done = Rc<dyn Fn(&mut Window, &mut App)>;

/// What runs once the first run has gone.
type OnDone = Box<dyn FnOnce(&mut Window, &mut App)>;

/// One step of the first-run card.
pub trait Step: 'static {
    /// Which step it is (the card's panes cross by it).
    fn id(&self) -> &'static str;
    /// What a screen reader calls the card while it shows.
    fn label(&self, cx: &App) -> SharedString;
    /// The pane's width (the 0.1 client: 560, the welcome 360, sign-in 400).
    fn width(&self) -> f32 {
        560.0
    }
    /// The pane; `done` goes on to the next step.
    fn render(&self, done: Done, window: &mut Window, cx: &mut App) -> AnyElement;
}

type MakeStep = Rc<dyn Fn(&mut Window, &mut App) -> Option<Rc<dyn Step>>>;

#[derive(Default)]
struct Steps(Vec<MakeStep>);

impl Global for Steps {}

/// Adds a step to the first-run card. The maker answers when the card is
/// made: `Some` when its question is open on this device, `None` when it
/// has been answered. Steps show in the order they were added.
pub fn add_step(
    cx: &mut App,
    make: impl Fn(&mut Window, &mut App) -> Option<Rc<dyn Step>> + 'static,
) {
    cx.default_global::<Steps>().0.push(Rc::new(make));
}

/// Where the first run stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    /// The app's name stands on the sea.
    Title,
    /// The card asks its steps.
    Card,
    /// The card fades as the shelf comes up under it.
    Leaving,
    Done,
}

/// The first run, over the whole window (see the module's doc). The shell
/// shows it on a first launch with the sea under it and the bookshelf
/// beneath it from [`FirstRun::shows_shelf`] on; `on_done` runs when it has
/// gone (the shell then remembers the first run is over on this device).
pub struct FirstRun {
    stage: Stage,
    since: Instant,
    steps: VecDeque<Rc<dyn Step>>,
    front: Option<Rc<dyn Step>>,
    behind: Option<(Rc<dyn Step>, Instant)>,
    sea: Sea,
    title: Option<Hold>,
    rain: Option<Hold>,
    on_done: Option<OnDone>,
    _timer: Option<Task<()>>,
}

impl FirstRun {
    pub fn new(
        window: &mut Window,
        cx: &mut Context<Self>,
        on_done: impl FnOnce(&mut Window, &mut App) + 'static,
    ) -> FirstRun {
        let makers = cx
            .try_global::<Steps>()
            .map(|s| s.0.clone())
            .unwrap_or_default();
        let steps = makers.iter().filter_map(|m| m(window, cx)).collect();
        let sea = Sea::of(window, cx);
        let still = Theme::of(window, cx).reduce_motion;
        let mut run = FirstRun {
            stage: Stage::Title,
            since: dr_ui::anim::now(),
            steps,
            front: None,
            behind: None,
            rain: Some(sea.hold(HoldKind::Rain, window)),
            title: None,
            sea,
            on_done: Some(Box::new(on_done)),
            _timer: None,
        };
        if still {
            run.let_name_go(window, cx);
        } else {
            run.title = Some(run.sea.hold(HoldKind::Title, window));
            run._timer = Some(cx.spawn_in(window, async move |this, cx| {
                cx.background_executor().timer(TITLE_STANDS).await;
                this.update_in(cx, |run, window, cx| run.let_name_go(window, cx))
                    .ok();
            }));
        }
        run
    }

    pub fn stage(&self) -> Stage {
        self.stage
    }

    /// Whether the bookshelf should be drawn under the card: from the
    /// moment the card starts to leave.
    pub fn shows_shelf(&self) -> bool {
        matches!(self.stage, Stage::Leaving | Stage::Done)
    }

    /// Lets the name go at once (screenshots and tests; the timer does it
    /// after [`TITLE_STANDS`]).
    pub fn show_card(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.let_name_go(window, cx);
    }

    /// The name lets go; its ring leaves the card behind.
    fn let_name_go(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.stage != Stage::Title {
            return;
        }
        self.title = None;
        self.stage = Stage::Card;
        self.since = dr_ui::anim::now();
        match self.steps.pop_front() {
            Some(step) => self.front = Some(step),
            None => self.leave(window, cx),
        }
        window.refresh();
        cx.notify();
    }

    /// The step in front is answered: the next dissolves in over it, or the
    /// card leaves.
    fn next(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.stage != Stage::Card {
            return;
        }
        match self.steps.pop_front() {
            Some(step) => {
                if let Some(old) = self.front.replace(step) {
                    self.behind = Some((old, dr_ui::anim::now()));
                }
            }
            None => self.leave(window, cx),
        }
        cx.notify();
    }

    fn leave(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.stage = Stage::Leaving;
        self.since = dr_ui::anim::now();
        self.rain = None;
        cx.set_global(Arriving(true));
        window.refresh();
        self._timer = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(LEAVE).await;
            this.update_in(cx, |run, window, cx| {
                run.stage = Stage::Done;
                cx.set_global(Arriving(false));
                if let Some(done) = run.on_done.take() {
                    done(window, cx);
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// The card's opacity now, and whether it is still changing.
    fn card_opacity(&self, now: Instant, still: bool) -> (f32, bool) {
        let elapsed = now.saturating_duration_since(self.since);
        let fade = |t: Duration| (t.as_secs_f32() / LEAVE.as_secs_f32()).clamp(0.0, 1.0);
        match self.stage {
            Stage::Title | Stage::Done => (0.0, false),
            _ if still => (if self.stage == Stage::Card { 1.0 } else { 0.0 }, false),
            Stage::Card => {
                let k = fade(elapsed.saturating_sub(CARD_IN_DELAY));
                (motion::Easing::EASE_OUT.at(k), k < 1.0)
            }
            Stage::Leaving => {
                let k = fade(elapsed);
                (1.0 - motion::Easing::EASE_OUT.at(k), k < 1.0)
            }
        }
    }
}

impl Render for FirstRun {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let now = dr_ui::anim::now();
        let (opacity, fading) = self.card_opacity(now, theme.reduce_motion);
        // The step behind dissolves under the one in front.
        let blend = motion::PAGE_BLEND.duration.as_secs_f32();
        let behind = self.behind.as_ref().and_then(|(step, at)| {
            let k = now.saturating_duration_since(*at).as_secs_f32() / blend;
            (k < 1.0 && !theme.reduce_motion)
                .then(|| (step.clone(), motion::PAGE_BLEND.easing.at(k)))
        });
        if self.behind.is_some() && behind.is_none() {
            self.behind = None;
        }
        if fading || behind.is_some() {
            window.request_animation_frame();
        }
        let leaving = self.stage == Stage::Leaving;
        let sea = self.sea.clone();
        let root = div()
            .id("first-run")
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .p(px(24.0))
            // The bare desk: a ring where the hand presses it.
            .when(!leaving, |el| {
                el.on_mouse_down(MouseButton::Left, move |e, window, _| {
                    sea.press(e.position, 1.2, window)
                })
            });
        if self.stage == Stage::Title || self.stage == Stage::Done {
            return root;
        }
        let this = cx.entity().downgrade();
        let done: Done = Rc::new(move |window, cx| {
            this.update(cx, |run, cx| run.next(window, cx)).ok();
        });
        let pane = |step: &Rc<dyn Step>, k: f32, window: &mut Window, cx: &mut App| {
            div()
                .w(px(step.width()))
                .max_w(window.viewport_size().width - px(48.0))
                .opacity(k)
                .child(step.render(done.clone(), window, cx))
        };
        let Some(front) = self.front.clone() else {
            return root;
        };
        let mut card = div()
            .id("first-run-card")
            .relative()
            .rounded(px(2.0))
            .overflow_hidden()
            .occlude()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .text_color(theme.palette.ink(1).solid());
        let front_k = behind.as_ref().map_or(1.0, |(_, k)| *k);
        if let Some((old, k)) = &behind {
            card = card.child(div().absolute().top_0().left_0().child(pane(
                old,
                1.0 - k,
                window,
                cx,
            )));
        }
        card = card.child(pane(&front, front_k, window, cx));
        let glass = SeaGlass::resting(2.0)
            .arrive(true)
            .hover(false)
            .rest(if leaving { 0.0 } else { 0.85 });
        let language = language_corner(cx);
        root.child(
            div()
                .opacity(opacity)
                .child(on_sea("first-run-card", glass, card)),
        )
        .child(
            div()
                .absolute()
                .right(px(20.0))
                .bottom(px(16.0))
                .opacity(opacity)
                .child(language),
        )
    }
}

/// The interface language, out of the way in the window's corner: the
/// card, the sea's passage and everything after follow it at once.
fn language_corner(cx: &mut App) -> impl IntoElement {
    let current = dr_shell::strings::Strings::get(cx).locale();
    let index = Locale::ALL.iter().position(|l| *l == current).unwrap_or(0);
    div().w(px(200.0)).child(
        Select::new(
            "first-run-language",
            Locale::ALL
                .iter()
                .map(|l| Choice::new(Icon::Wen, l.native_name()))
                .collect(),
            index,
        )
        .on_change(|i, _, cx| {
            let code = Locale::ALL[i.min(Locale::ALL.len() - 1)].code();
            Settings::update(cx, |f| f.set(registry::UI_LOCALE, code.into(), None).ok());
        }),
    )
}

/// True while the shelf comes up from the first-run card: glass laid on
/// the sea then is set down ([`SeaGlass::arrive`]) instead of standing.
#[derive(Clone, Copy, Debug, Default)]
pub struct Arriving(pub bool);

impl Global for Arriving {}

pub fn arriving(cx: &App) -> bool {
    cx.try_global::<Arriving>().is_some_and(|a| a.0)
}

// The sample on the shelf (the 0.1 client's `first-run-shelf.ts`).

#[derive(Debug, Default)]
struct SampleShelf {
    /// The samples this launch wrote.
    created: Vec<String>,
    /// The landing ring is spent; a shelf drawn later shows it in place.
    landed: bool,
    /// A sample was opened: the samples wait no longer.
    opened: bool,
}

impl Global for SampleShelf {}

/// How the shelf shows a book this launch may have written as a sample.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SampleOnShelf {
    /// It waits for the author: its rim flows until it is opened.
    pub waiting: bool,
    /// Its card has yet to land.
    pub landing: bool,
}

/// Whether `book` is a sample this launch wrote, and where it stands.
pub fn sample_on_shelf(book: &str, cx: &App) -> SampleOnShelf {
    let Some(shelf) = cx.try_global::<SampleShelf>() else {
        return SampleOnShelf::default();
    };
    let waiting = shelf.created.iter().any(|b| b == book) && !shelf.opened;
    SampleOnShelf {
        waiting,
        landing: waiting && !shelf.landed,
    }
}

/// Writes the built-in samples into a new local library, off the main
/// thread (`dr_samples::ensure_built_in`: once per library, both or
/// neither, never into a library that has had books), and remembers the
/// books it wrote so the shelf can land them. Call it once the library is
/// open and before the shelf opens a book; not for an account library,
/// which starts from its cloud copy.
pub fn write_samples(library: dr_workspace::Workspace, cx: &mut App) -> Task<dr_samples::Outcome> {
    cx.spawn(async move |cx| {
        let outcome = cx
            .background_executor()
            .spawn(async move { dr_samples::ensure_built_in(&library) })
            .await;
        match &outcome {
            dr_samples::Outcome::Created { books } => {
                let books = books.clone();
                cx.update(|cx| note_samples_created(books, cx));
            }
            dr_samples::Outcome::Failed { error, attempts } => {
                log::warn!("the built-in samples were not written (attempt {attempts}): {error}")
            }
            dr_samples::Outcome::AlreadyDone | dr_samples::Outcome::Skipped { .. } => {}
        }
        outcome
    })
}

/// The samples this launch wrote.
pub fn note_samples_created(books: Vec<String>, cx: &mut App) {
    cx.default_global::<SampleShelf>().created = books;
}

/// A book was opened from the shelf: once a sample is opened, the samples
/// wait no longer.
pub fn note_book_opened(book: &str, cx: &mut App) {
    if let Some(shelf) = cx.try_global::<SampleShelf>()
        && shelf.created.iter().any(|b| b == book)
    {
        cx.default_global::<SampleShelf>().opened = true;
    }
}

/// The sample's card came up at `centre` (window coordinates): it lands on
/// a ring of its own [`SAMPLE_LANDING_DELAY`] later, once.
pub fn land_sample(centre: gpui::Point<gpui::Pixels>, window: &mut Window, cx: &mut App) {
    if cx.try_global::<SampleShelf>().is_some_and(|s| s.landed) {
        return;
    }
    cx.default_global::<SampleShelf>().landed = true;
    let sea = Sea::of(window, cx);
    window
        .spawn(cx, async move |cx| {
            cx.background_executor().timer(SAMPLE_LANDING_DELAY).await;
            cx.update(|window, _| sea.press(centre, LANDING_RING, window))
                .ok();
        })
        .detach();
}

// The Markdown folder step (M40 fills it in).

/// What the Markdown folder step needs from M40 (the 0.1 client's
/// `platform.markdownProjection`).
pub trait FolderSource: 'static {
    /// The folder chosen on this device, if any (shown as it is).
    fn chosen(&self, cx: &App) -> Option<SharedString>;
    /// Opens the system's folder picker and stores the choice.
    fn choose(&self, window: &mut Window, cx: &mut App);
    /// Turns the Markdown folders off, after asking (the 0.1 client's
    /// danger confirmation); calls `done` once it is off.
    fn turn_off(&self, done: Done, window: &mut Window, cx: &mut App);
}

/// Where every book's Markdown folder goes. There is no default: the author
/// picks a folder before going on (one already chosen on this device
/// counts). Turning the folder off is offered too, in the danger ink and
/// behind a confirmation, since external editors and Agents then lose the
/// book.
pub struct FolderStep {
    source: Rc<dyn FolderSource>,
}

impl FolderStep {
    pub fn new(source: Rc<dyn FolderSource>) -> FolderStep {
        FolderStep { source }
    }
}

impl Step for FolderStep {
    fn id(&self) -> &'static str {
        "folder"
    }

    fn label(&self, cx: &App) -> SharedString {
        t(cx, keys::markdown_folder_guide::TITLE)
    }

    fn render(&self, done: Done, window: &mut Window, cx: &mut App) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let chosen = self.source.chosen(cx);
        let (choose, off) = (self.source.clone(), self.source.clone());
        let off_done = done.clone();
        let mut actions = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_end()
            .gap(px(space::S3))
            .child(
                Button::new(
                    "folder-off",
                    t(cx, keys::settings::sync::projection::TURN_OFF),
                )
                .danger()
                .on_click(move |_, window, cx| off.turn_off(off_done.clone(), window, cx)),
            );
        let mut pick = Button::new("folder-choose", t(cx, keys::markdown_folder_guide::CHOOSE))
            .on_click(move |_, window, cx| choose.choose(window, cx));
        if chosen.is_none() {
            pick = pick.primary();
        }
        actions = actions.child(pick).when(chosen.is_some(), |el| {
            el.child(
                Button::new(
                    "folder-continue",
                    t(cx, keys::markdown_folder_guide::CONTINUE),
                )
                .primary()
                .on_click(move |_, window, cx| done(window, cx)),
            )
        });
        div()
            .p(px(space::S8))
            .flex()
            .flex_col()
            .gap(px(space::S5))
            .child(
                div()
                    .font_role(Role::Ui)
                    .type_px(s.dialog_title, s.dialog_title + 6.0)
                    .weight(weight::SEMIBOLD)
                    .text_color(p.ink(1).solid())
                    .child(t(cx, keys::markdown_folder_guide::TITLE)),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(space::S4))
                    .font_role(Role::Ui)
                    .type_px(s.body, s.line_body)
                    .text_color(p.ink(2).solid())
                    .child(dr_ui::text::wrapped(t(
                        cx,
                        keys::markdown_folder_guide::INTRO,
                    )))
                    .when_some(chosen, |el, folder| {
                        el.child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(2.0))
                                .child(
                                    div()
                                        .type_px(s.caption, s.line_caption)
                                        .text_color(p.ink(3).solid())
                                        .child(t(cx, keys::markdown_folder_guide::CHOSEN)),
                                )
                                .child(
                                    div()
                                        .font_role(Role::Index)
                                        .type_px(s.secondary, s.line_body)
                                        .text_color(p.ink(1).solid())
                                        .child(folder),
                                ),
                        )
                    }),
            )
            .child(actions)
            .into_any_element()
    }
}
