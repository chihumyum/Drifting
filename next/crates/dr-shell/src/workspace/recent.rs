//! Device-local v3 visits retain the book and the complete page target.
use super::*;
use dr_workspace::{
    Actor,
    commands::v3::recent::{RecentTouch, RecentTouchIn, Target as RecentTarget},
};
use futures::{StreamExt as _, channel::mpsc};
use serde_json::Value;
use std::sync::{Arc, Mutex};

#[derive(Default, Serialize)]
struct State {
    pending: usize,
    /// The last successfully persisted request, not an optimistic UI value.
    last: Option<RecentTouchIn>,
}

pub(super) struct Recorder {
    send: mpsc::UnboundedSender<(Library, RecentTouchIn)>,
    state: Arc<Mutex<State>>,
}

impl Recorder {
    fn new(cx: &App) -> Self {
        let (send, mut receive) = mpsc::unbounded::<(Library, RecentTouchIn)>();
        let state = Arc::new(Mutex::new(State::default()));
        let progress = state.clone();
        // One FIFO worker: rapid visits must not finish in reverse order.
        // Each request owns its original library/book, even after a switch.
        // Dropping the sender drains queued visits and releases the library.
        cx.background_executor()
            .spawn(async move {
                while let Some((library, input)) = receive.next().await {
                    let result = library.run::<RecentTouch>(&Actor::User, input.clone());
                    let mut state = progress.lock().unwrap_or_else(|e| e.into_inner());
                    state.pending -= 1;
                    match result {
                        Ok(_) => state.last = Some(input),
                        Err(error) => {
                            state.last = None;
                            log::warn!("v3 recent.touch: {error}");
                        }
                    }
                }
            })
            .detach();
        Self { send, state }
    }

    fn push(&self, library: Library, input: RecentTouchIn) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).pending += 1;
        if self.send.unbounded_send((library, input)).is_err() {
            self.state.lock().unwrap_or_else(|e| e.into_inner()).pending -= 1;
            log::warn!("v3 recent.touch: recorder stopped");
        }
    }

    fn state(&self) -> Value {
        serde_json::to_value(&*self.state.lock().unwrap_or_else(|e| e.into_inner()))
            .expect("recent progress contains only strings and integers")
    }
}

impl Workspace {
    pub(super) fn record_recent(&mut self, target: Option<&Target>, cx: &mut Context<Self>) {
        let target = match target {
            Some(Target::Entry { id, module }) => RecentTarget {
                kind: "entry".into(),
                id: id.to_string(),
                module: module.as_ref().map(ToString::to_string),
            },
            Some(Target::Material(id)) => RecentTarget {
                kind: "material".into(),
                id: id.to_string(),
                module: None,
            },
            // Home, whole-book, templates and old entity kinds are not pages
            // in the v3 recent list. Never translate them to a Book sentinel.
            _ => return,
        };
        let Some(library) = self.library.clone() else {
            return;
        };
        self.recent_recorder
            .get_or_insert_with(|| Recorder::new(cx))
            .push(
                library,
                RecentTouchIn {
                    book: self.book_id.clone(),
                    target,
                },
            );
    }

    /// Read-only recorder progress for native acceptance. The receipt is set
    /// only after F3 committed the visit; it does not read or write a query.
    pub fn recent_state(&self) -> Option<Value> {
        self.recent_recorder.as_ref().map(Recorder::state)
    }
}
