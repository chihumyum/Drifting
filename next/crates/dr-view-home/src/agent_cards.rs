//! HC: the Agent's suggestion cards on Project Home (`kernel-v5.md` §15
//! #46, #47; `handoff/v5-tracks.md` HC).
//!
//! Home owns where they sit (below 继续写, above the create row) and when
//! they are looked for (Home coming to the front, the window coming back
//! with Home in front). The cards themselves come from whoever registers
//! them: the app wires `dr-view-agent`'s, so neither crate depends on the
//! other (the 「另存为项目模板」 slot's pattern). Nothing is registered: Home
//! draws nothing there. A template's working copy draws none and asks for
//! none.

use std::rc::Rc;

use dr_shell::Workspace;
use gpui::{
    AnyElement, AnyView, App, Context, Entity, Global, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, Styled as _, Subscription, WeakEntity, Window, div,
};

use crate::v3::Home;

/// What the registered maker is given: the workspace whose Home it is.
#[derive(Clone)]
pub struct AgentCardsHost {
    pub workspace: WeakEntity<Workspace>,
}

type Drawn = Rc<dyn Fn(&App) -> bool>;
type Shown = Rc<dyn Fn(&mut Window, &mut App)>;

/// One Home's cards: their view and the two things Home asks of it.
pub struct AgentCards {
    view: AnyView,
    drawn: Drawn,
    shown: Shown,
}

impl AgentCards {
    /// `drawn`: whether the view has anything to draw now (without, Home
    /// leaves no gap). `shown`: Home came to the front, or the window came
    /// back while it was in front; the view decides whether to look.
    pub fn new<V: Render>(
        view: Entity<V>,
        drawn: impl Fn(&V, &App) -> bool + 'static,
        shown: impl Fn(&mut V, &mut Window, &mut Context<V>) + 'static,
    ) -> Self {
        let read = view.downgrade();
        let update = view.downgrade();
        Self {
            view: view.into(),
            drawn: Rc::new(move |cx| read.upgrade().is_some_and(|v| drawn(v.read(cx), cx))),
            shown: Rc::new(move |window, cx| {
                if let Some(v) = update.upgrade() {
                    v.update(cx, |v, cx| shown(v, window, cx));
                }
            }),
        }
    }
}

type MakeAgentCards = Rc<dyn Fn(AgentCardsHost, &mut Window, &mut App) -> AgentCards>;

#[derive(Clone, Default)]
struct AgentCardsSlot(Option<MakeAgentCards>);

impl Global for AgentCardsSlot {}

/// Registers the maker of Project Home's suggestion cards (the app, with
/// `dr-view-agent`'s). Each Home makes its own the first time it draws.
pub fn set_agent_cards(
    cx: &mut App,
    make: impl Fn(AgentCardsHost, &mut Window, &mut App) -> AgentCards + 'static,
) {
    cx.default_global::<AgentCardsSlot>().0 = Some(Rc::new(make));
}

/// Clears the registered maker (tests).
pub fn clear_agent_cards(cx: &mut App) {
    if cx.has_global::<AgentCardsSlot>() {
        cx.global_mut::<AgentCardsSlot>().0 = None;
    }
}

/// Whether a maker of the suggestion cards is registered.
pub fn has_agent_cards(cx: &App) -> bool {
    cx.try_global::<AgentCardsSlot>()
        .is_some_and(|s| s.0.is_some())
}

/// A Home's own cards and whether it was in front, for which book.
#[derive(Default)]
pub(crate) struct HomeAgentCards {
    cards: Option<AgentCards>,
    front: Option<String>,
    _live: Vec<Subscription>,
}

impl Home {
    /// The cards between 继续写 and the create row, when there is anything
    /// to draw. Makes this Home's cards the first time.
    pub(crate) fn agent_cards(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if self.agent_cards.cards.is_none() {
            let make = cx.try_global::<AgentCardsSlot>()?.0.clone()?;
            let ws = self.ws.upgrade()?;
            let cards = make(
                AgentCardsHost {
                    workspace: self.ws.clone(),
                },
                window,
                cx,
            );
            self.agent_cards.cards = Some(cards);
            self.agent_cards
                ._live
                .push(cx.observe_in(&ws, window, |home, ws, window, cx| {
                    home.follow_front(&ws, window, cx)
                }));
            self.agent_cards._live.push(cx.observe_window_activation(
                window,
                |home, window, cx| {
                    if window.is_window_active() && home.agent_cards.front.is_some() {
                        home.cards_shown(window, cx);
                    }
                },
            ));
            // Home is drawing, so it is in front: after this frame.
            cx.defer_in(window, move |home, window, cx| {
                home.follow_front(&ws, window, cx)
            });
        }
        if self.inline.template_copy {
            return None;
        }
        let cards = self.agent_cards.cards.as_ref()?;
        (cards.drawn)(cx).then(|| {
            div()
                .id("v3-home-agent-cards")
                .debug_selector(|| "v3-home-agent-cards".into())
                .w_full()
                .child(cards.view.clone())
                .into_any_element()
        })
    }

    /// Home is in front when no tab is open and nothing covers the
    /// workspace or its paper (settings, the shelf, a dialog, a filled
    /// panel). Coming to the front (or to another book while in front, or
    /// back from a filled panel) asks the cards to look.
    fn follow_front(
        &mut self,
        ws: &Entity<Workspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (front, book) = {
            let w = ws.read(cx);
            let front = w.nav.active_tab().is_none()
                && !w.covered()
                && !w.fill_covers_paper()
                && w.book.v3().is_some();
            (front.then(|| w.book.id.clone()), w.book.clone())
        };
        // Whether this book is a template's working copy is read with it.
        if front
            .as_deref()
            .is_some_and(|id| self.inline.synced_book_id != id)
        {
            self.sync_book(&book, cx);
        }
        let came = front.is_some() && front != self.agent_cards.front;
        self.agent_cards.front = front;
        if came {
            self.cards_shown(window, cx);
        }
    }

    fn cards_shown(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.inline.template_copy {
            return;
        }
        if let Some(shown) = self.agent_cards.cards.as_ref().map(|c| c.shown.clone()) {
            shown(window, cx);
        }
    }
}
