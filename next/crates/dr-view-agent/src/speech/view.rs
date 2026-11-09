use super::{
    Services,
    audio::{Capture, Completion, Event},
    client::{Client, Failure, KEY},
    context,
};
use crate::controller::AgentController;
use dr_i18n::{Key, keys};
use dr_model::id::BookId;
use dr_shell::strings::t;
use dr_ui::{
    components::Button,
    input::{TextArea, TextField},
    text,
};
use futures::{FutureExt as _, StreamExt as _, channel::oneshot, future::join_all};
use gpui::{
    AppContext as _, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _,
    px,
};
use std::{collections::VecDeque, sync::Arc};
use tokio_util::sync::CancellationToken;

pub struct Dictation {
    client: Client,
    jobs: super::Jobs,
    composer: Entity<TextArea>,
    key: Entity<TextField>,
    controller: Option<AgentController>,
    book: Option<BookId>,
    context: String,
    generation: u64,
    cancel: CancellationToken,
    capture: Option<Capture>,
    completions: Vec<Completion>,
    queue: VecDeque<Arc<Vec<u8>>>,
    transcript: Option<String>,
    preparing: bool,
    recording: bool,
    sending: bool,
    credentials_busy: bool,
    setup: bool,
    error: Option<Failure>,
    _window_closed: gpui::Subscription,
    _composer_changed: gpui::Subscription,
}
impl Dictation {
    pub fn new(composer: Entity<TextArea>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let services = cx.global::<Services>().clone();
        let client = services.client;
        let key = cx.new(|cx| {
            TextField::new("speech-key", window, cx)
                .secure(true)
                .mono()
                .placeholder(t(cx, keys::settings::byok_provider::KEY_PLACEHOLDER))
        });
        let weak = cx.weak_entity();
        dr_shell::release::before_release(cx, move |cx| {
            weak.upgrade()
                .map(|view| view.update(cx, |view, cx| view.prepare_release(cx)))
                .unwrap_or_else(|| async { Ok(()) }.boxed_local())
        });
        let owner = window.window_handle().window_id();
        let weak = cx.weak_entity();
        let window_closed = cx.on_window_closed(move |cx, window| {
            if owner == window {
                let _ = weak.update(cx, |view, cx| view.cancel(cx));
            }
        });
        // TextArea::set_text clears marked text. Keep an acknowledged ASR
        // result until the author's input method commits or drops its preedit.
        let composer_changed = cx.observe(&composer, |view, _, cx| view.flush_transcript(cx));
        Self {
            client,
            jobs: services.jobs,
            composer,
            key,
            controller: None,
            book: None,
            context: String::new(),
            generation: 0,
            cancel: CancellationToken::new(),
            capture: None,
            completions: Vec::new(),
            queue: VecDeque::new(),
            transcript: None,
            preparing: false,
            recording: false,
            sending: false,
            credentials_busy: false,
            setup: false,
            error: None,
            _window_closed: window_closed,
            _composer_changed: composer_changed,
        }
    }
    fn track(&mut self, done: Completion) {
        self.jobs.track(self.cancel.clone(), done.clone());
        self.completions.push(done);
    }
    pub fn bind(
        &mut self,
        controller: Option<AgentController>,
        book: Option<BookId>,
        cx: &mut Context<Self>,
    ) {
        self.cancel(cx);
        self.controller = controller;
        self.book = book;
    }
    pub fn pending(&self) -> bool {
        self.preparing || self.recording || self.sending || !self.queue.is_empty()
    }
    pub fn cancel(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        self.cancel.cancel();
        self.capture.take(); // Drop cancels native capture; its completion stays owned below.
        self.queue.clear();
        self.transcript = None;
        self.context.clear();
        self.preparing = false;
        self.recording = false;
        self.sending = false;
        self.error = None;
        self.key.update(cx, |key, cx| key.set_text("", cx));
        self.completions
            .retain(|done| done.clone().now_or_never().is_none());
        cx.notify();
    }
    pub fn prepare_release(
        &mut self,
        cx: &mut Context<Self>,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<(), String>>>> {
        self.cancel(cx);
        let all = std::mem::take(&mut self.completions);
        async move {
            join_all(all).await;
            Ok(())
        }
        .boxed_local()
    }
    fn start(&mut self, cx: &mut Context<Self>) {
        if self.pending() || self.credentials_busy || dr_shell::release::is_releasing(cx) {
            return;
        }
        let (Some(controller), Some(book)) = (self.controller.clone(), self.book.clone()) else {
            return;
        };
        self.cancel(cx);
        self.cancel = CancellationToken::new();
        self.preparing = true;
        let generation = self.generation;
        let client = self.client.clone();
        let context = controller.workspace_job(move |ws| context::glossary(ws.library(), &book));
        let (done, finished) = oneshot::channel();
        self.track(
            async move {
                let _ = finished.await;
            }
            .boxed()
            .shared(),
        );
        cx.spawn(async move |this, cx| {
            let store = client.secrets;
            let has_key = cx
                .background_executor()
                .spawn(async move {
                    store
                        .get(KEY)
                        .map(|value| value.is_some_and(|key| !key.trim().is_empty()))
                        .map_err(|_| Failure::Storage)
                })
                .await;
            let context = context.await.map_err(|_| Failure::Rejected);
            let _ = done.send(());
            let _ = this.update(cx, |view, cx| {
                if view.generation != generation {
                    return;
                }
                view.preparing = false;
                match has_key.and_then(|has| if has { context } else { Err(Failure::NoKey) }) {
                    Ok(context) => {
                        view.context = context;
                        view.capture(cx);
                    }
                    Err(error) => {
                        view.error = Some(error);
                        view.setup = error == Failure::NoKey;
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }
    fn capture(&mut self, cx: &mut Context<Self>) {
        if self.cancel.is_cancelled() || dr_shell::release::is_releasing(cx) {
            return;
        }
        let (capture, mut events) = match Capture::start(self.cancel.clone()) {
            Ok(value) => value,
            Err(error) => {
                self.error = Some(error);
                cx.notify();
                return;
            }
        };
        self.track(capture.done.clone());
        self.capture = Some(capture);
        self.recording = true;
        let generation = self.generation;
        cx.spawn(async move |this, cx| {
            while let Some(event) = events.next().await {
                if this
                    .update(cx, |view, cx| {
                        if view.generation != generation {
                            return;
                        }
                        match event {
                            Event::Segment(audio) => {
                                view.queue.push_back(audio);
                                view.pump(cx);
                            }
                            Event::Stopped(error) => {
                                view.recording = false;
                                if let Some(error) = error {
                                    view.error = Some(error);
                                }
                            }
                        }
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        cx.notify();
    }
    fn stop(&mut self, cx: &mut Context<Self>) {
        if let Some(capture) = &self.capture {
            capture.stop();
        }
        // Stay recording until the worker emits its final segment and ACK.
        cx.notify();
    }
    fn pump(&mut self, cx: &mut Context<Self>) {
        self.completions
            .retain(|done| done.clone().now_or_never().is_none());
        if self.sending || self.transcript.is_some() || self.error.is_some() {
            return;
        }
        let Some(audio) = self.queue.front().cloned() else {
            return;
        };
        self.sending = true;
        let generation = self.generation;
        let (client, context, cancel) = (
            self.client.clone(),
            self.context.clone(),
            self.cancel.clone(),
        );
        let (done, finished) = oneshot::channel();
        self.track(
            async move {
                let _ = finished.await;
            }
            .boxed()
            .shared(),
        );
        cx.spawn(async move |this, cx| {
            let result = client.transcribe(audio, context, cancel).await;
            let _ = done.send(());
            let _ = this.update(cx, |view, cx| {
                if view.generation != generation {
                    return;
                }
                view.sending = false;
                match result {
                    Ok(text) => {
                        view.transcript = Some(text);
                        view.flush_transcript(cx);
                    }
                    Err(error) => {
                        view.error = Some(error);
                        view.stop(cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn flush_transcript(&mut self, cx: &mut Context<Self>) {
        if self.transcript.is_none() || self.composer.read(cx).is_composing() {
            return;
        }
        let text = self.transcript.take().expect("ready transcript");
        self.queue.pop_front();
        if let Some(capture) = &self.capture {
            capture.acknowledge();
        }
        if !text.is_empty() {
            self.composer.update(cx, |composer, cx| {
                let current = composer.text();
                composer.set_text(append_transcript(&current, &text), cx);
            });
        }
        self.pump(cx);
        cx.notify();
    }
    fn retry(&mut self, cx: &mut Context<Self>) {
        if self.sending || self.recording {
            return;
        }
        self.error = None;
        self.pump(cx);
        cx.notify();
    }
    fn credential(&mut self, remove: bool, cx: &mut Context<Self>) {
        if self.credentials_busy
            || self.preparing
            || self.recording
            || self.sending
            || dr_shell::release::is_releasing(cx)
        {
            return;
        }
        let value = self.key.read(cx).text();
        if !remove && value.trim().is_empty() {
            return;
        }
        self.key.update(cx, |key, cx| key.set_text("", cx));
        self.credentials_busy = true;
        let store = self.client.secrets.clone();
        let (done, finished) = oneshot::channel();
        self.track(
            async move {
                let _ = finished.await;
            }
            .boxed()
            .shared(),
        );
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    if remove {
                        store.delete(KEY)
                    } else {
                        store.set(KEY, value.trim())
                    }
                })
                .await;
            let _ = done.send(());
            let _ = this.update(cx, |view, cx| {
                view.credentials_busy = false;
                match result {
                    Ok(()) => {
                        view.setup = remove;
                        if view.queue.is_empty() {
                            view.error = None;
                        }
                    }
                    Err(_) => view.error = Some(Failure::Storage),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}
impl Drop for Dictation {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.capture.take();
    }
}

pub fn append_transcript(current: &str, text: &str) -> String {
    if current.is_empty() || current.ends_with(char::is_whitespace) {
        format!("{current}{text}")
    } else {
        format!("{current}\n{text}")
    }
}
fn error_key(error: Failure) -> Key {
    use keys::voice_agent::error as k;
    match error {
        Failure::NoKey => k::NO_KEY,
        Failure::Storage => keys::agent_panel::onboarding::SAVE_FAILED,
        Failure::Authentication => k::AUTH,
        Failure::Rejected => k::SEGMENT_REJECTED,
        Failure::Transport => k::TRANSCRIBE_FAILED,
        Failure::Microphone => k::MIC_DENIED,
        Failure::Backlog => keys::speech::BACKLOG,
        Failure::Cancelled => keys::common::CANCEL,
    }
}
impl Render for Dictation {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        use keys::voice_agent as k;
        let pending = self.pending();
        let active = self.preparing || self.recording || self.sending;
        let blocked = dr_shell::release::is_releasing(cx) || self.credentials_busy;
        let mut body = div().id("agent-dictation").flex().flex_col().gap(px(6.));
        body = body.child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(6.))
                .child(
                    Button::new(
                        "speech-record",
                        t(
                            cx,
                            if self.recording {
                                k::STOP_RECORD
                            } else {
                                k::RECORD
                            },
                        ),
                    )
                    .text()
                    .small()
                    .disabled(
                        blocked
                            || self.preparing
                            || (!self.recording && pending)
                            || self.book.is_none(),
                    )
                    .on_click(cx.listener(|view, _, _, cx| {
                        if view.recording {
                            view.stop(cx);
                        } else {
                            view.start(cx);
                        }
                    })),
                )
                .when(pending, |row| {
                    row.child(
                        Button::new("speech-cancel", t(cx, keys::common::CANCEL))
                            .text()
                            .small()
                            .on_click(cx.listener(|view, _, _, cx| view.cancel(cx))),
                    )
                })
                .when(self.recording || self.preparing || self.sending, |row| {
                    let status = t(
                        cx,
                        if self.recording {
                            k::RECORDING
                        } else {
                            k::TRANSCRIBING
                        },
                    );
                    row.child(
                        div()
                            .id("speech-status")
                            .role(gpui::Role::Status)
                            .aria_label(status.clone())
                            .child(status),
                    )
                })
                .child(
                    Button::new("speech-setup", t(cx, keys::settings::models::SPEECH_TITLE))
                        .text()
                        .small()
                        .disabled(blocked || active)
                        .on_click(cx.listener(|view, _, _, cx| {
                            view.setup = !view.setup;
                            cx.notify();
                        })),
                ),
        );
        if let Some(error) = self.error {
            let message = t(cx, error_key(error));
            body = body.child(
                div()
                    .id("speech-error")
                    .role(gpui::Role::Alert)
                    .aria_label(message.clone())
                    .child(text::wrapped(message))
                    .when(!self.queue.is_empty(), |row| {
                        row.child(
                            Button::new("speech-retry", t(cx, k::RETRY))
                                .small()
                                .disabled(blocked || self.recording || self.sending)
                                .on_click(cx.listener(|view, _, _, cx| view.retry(cx))),
                        )
                    }),
            );
        }
        if self.setup {
            body = body.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(text::wrapped(t(cx, keys::settings::models::SPEECH_DESC)))
                    .child(self.key.clone())
                    .child(
                        div()
                            .flex()
                            .gap(px(6.))
                            .child(
                                Button::new("speech-save-key", t(cx, keys::common::SAVE))
                                    .small()
                                    .disabled(blocked || active)
                                    .on_click(
                                        cx.listener(|view, _, _, cx| view.credential(false, cx)),
                                    ),
                            )
                            .child(
                                Button::new("speech-remove-key", t(cx, keys::common::DELETE))
                                    .text()
                                    .small()
                                    .disabled(blocked || active)
                                    .on_click(
                                        cx.listener(|view, _, _, cx| view.credential(true, cx)),
                                    ),
                            ),
                    ),
            );
        }
        body
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{Server, audio, transcript};
    use super::*;
    use gpui::{EntityInputHandler as _, Focusable as _, TestAppContext, VisualTestContext};
    use serde_json::json;
    use std::time::{Duration, Instant};

    fn open(
        cx: &mut TestAppContext,
        client: Client,
    ) -> (Entity<Dictation>, &mut VisualTestContext) {
        cx.executor().allow_parking();
        cx.update(|cx| {
            dr_shell::init(
                dr_shell::ShellInfo {
                    app_name: "Synthetic",
                    bundle_id: "cc.drifting.next.dev",
                    version: "test",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: None,
                },
                dr_shell::Services::default(),
                dr_shell::SettingsFile::in_memory(),
                cx,
            );
            super::super::install(client, cx);
        });
        cx.add_window_view(|window, cx| {
            let composer = cx.new(|cx| TextArea::new("synthetic-dictation-composer", window, cx));
            Dictation::new(composer, window, cx)
        })
    }
    #[track_caller]
    fn wait(cx: &mut VisualTestContext, mut condition: impl FnMut(&VisualTestContext) -> bool) {
        // Match the existing Agent panel harness: native frame work competes
        // with workspace validation on CI; protocol errors still fail immediately.
        let end = Instant::now() + Duration::from_secs(20);
        loop {
            cx.run_until_parked();
            cx.update(|window, cx| {
                window.simulate_next_frame(cx);
                window.draw(cx).clear(cx);
            });
            if condition(cx) {
                return;
            }
            assert!(Instant::now() < end, "dictation condition timed out");
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    #[gpui::test]
    fn ordered_retry_keeps_audio_and_appends_to_current_composer_once(cx: &mut TestAppContext) {
        let server = Server::new(
            vec![
                (401, json!({})),
                (200, transcript("first")),
                (200, transcript("second")),
            ],
            Duration::from_millis(20),
        );
        let (view, cx) = open(cx, server.client());
        let composer = view.read_with(cx, |view, _| view.composer.clone());
        view.update(cx, |view, cx| {
            view.context = context::pack(vec!["synthetic spelling".into()]);
            view.queue.extend([audio(), audio()]);
            view.pump(cx);
        });
        wait(cx, |cx| {
            view.read_with(cx, |v, _| {
                if let Some(error) = v.error {
                    assert_eq!(error, Failure::Authentication);
                }
                v.error == Some(Failure::Authentication)
            })
        });
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        assert_eq!(view.read_with(cx, |v, _| v.queue.len()), 2);
        composer.update(cx, |field, cx| field.set_text("author still typing", cx));
        view.update(cx, |view, cx| view.retry(cx));
        wait(cx, |cx| {
            view.read_with(cx, |v, _| {
                assert!(v.error.is_none(), "retry failed: {:?}", v.error);
                !v.pending()
            })
        });
        assert_eq!(
            composer.read_with(cx, |field, _| field.text()),
            "author still typing\nfirst\nsecond"
        );
        view.update(cx, |view, cx| view.retry(cx));
        cx.run_until_parked();
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0], requests[1]);
    }
    #[gpui::test]
    fn transcript_waits_for_ime_without_erasing_preedit_or_resending_audio(
        cx: &mut TestAppContext,
    ) {
        let server = Server::new(vec![(200, transcript("dictated"))], Duration::ZERO);
        let (view, cx) = open(cx, server.client());
        let composer = view.read_with(cx, |view, _| view.composer.clone());
        cx.update(|window, cx| {
            composer.focus_handle(cx).focus(window, cx);
            composer.update(cx, |field, cx| {
                field.set_text("author typing ", cx);
                field.replace_and_mark_text_in_range(None, "合成", None, window, cx);
            });
        });
        view.update(cx, |view, cx| {
            view.queue.push_back(audio());
            view.pump(cx);
        });
        wait(cx, |cx| view.read_with(cx, |v, _| v.transcript.is_some()));
        assert!(composer.read_with(cx, |field, _| field.is_composing()));
        assert_eq!(
            composer.read_with(cx, |field, _| field.composer().text().to_owned()),
            "author typing 合成"
        );
        assert!(view.read_with(cx, |v, _| v.pending()));
        // Retry while waiting on the input method must not send paid audio twice.
        view.update(cx, |view, cx| view.retry(cx));
        cx.update(|window, cx| {
            composer.update(cx, |field, cx| field.unmark_text(window, cx));
        });
        wait(cx, |cx| view.read_with(cx, |v, _| !v.pending()));
        assert_eq!(
            composer.read_with(cx, |field, _| field.text()),
            "author typing 合成\ndictated"
        );
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
    #[gpui::test]
    fn backlog_retains_order_and_manual_retry_does_not_repeat_success(cx: &mut TestAppContext) {
        let server = Server::new(
            ["first", "second", "third", "fourth"]
                .map(|text| (200, transcript(text)))
                .to_vec(),
            Duration::from_millis(20),
        );
        let (view, cx) = open(cx, server.client());
        let composer = view.read_with(cx, |v, _| v.composer.clone());
        view.update(cx, |view, cx| {
            view.queue
                .extend((0..super::super::audio::MAX_PENDING).map(|_| audio()));
            view.pump(cx);
            view.error = Some(Failure::Backlog);
        });
        wait(cx, |cx| view.read_with(cx, |v, _| !v.sending));
        assert_eq!(view.read_with(cx, |v, _| v.queue.len()), 3);
        assert_eq!(composer.read_with(cx, |v, _| v.text()), "first");
        view.update(cx, |view, cx| view.retry(cx));
        wait(cx, |cx| view.read_with(cx, |v, _| !v.pending()));
        assert_eq!(
            composer.read_with(cx, |v, _| v.text()),
            "first\nsecond\nthird\nfourth"
        );
        assert_eq!(server.requests.lock().unwrap().len(), 4);
    }
    #[gpui::test]
    fn cancelled_transcript_waiting_for_ime_cannot_reach_the_next_composer(
        cx: &mut TestAppContext,
    ) {
        let server = Server::new(vec![(200, transcript("old context"))], Duration::ZERO);
        let (view, cx) = open(cx, server.client());
        let composer = view.read_with(cx, |v, _| v.composer.clone());
        cx.update(|window, cx| {
            composer.focus_handle(cx).focus(window, cx);
            composer.update(cx, |field, cx| {
                field.replace_and_mark_text_in_range(None, "合成", None, window, cx);
            });
        });
        view.update(cx, |view, cx| {
            view.queue.push_back(audio());
            view.pump(cx);
        });
        wait(cx, |cx| view.read_with(cx, |v, _| v.transcript.is_some()));
        view.update(cx, |view, cx| view.bind(None, None, cx));
        composer.update(cx, |field, cx| field.set_text("new context", cx));
        cx.run_until_parked();
        assert!(!view.read_with(cx, |v, _| v.pending()));
        assert_eq!(composer.read_with(cx, |v, _| v.text()), "new context");
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
    #[gpui::test]
    fn release_cancels_request_drains_worker_and_never_writes_into_new_composer(
        cx: &mut TestAppContext,
    ) {
        let server = Server::new(vec![(200, transcript("late"))], Duration::from_millis(150));
        let (view, cx) = open(cx, server.client());
        let composer = view.read_with(cx, |view, _| view.composer.clone());
        view.update(cx, |view, cx| {
            view.queue.push_back(audio());
            view.pump(cx);
        });
        wait(cx, |_| !server.requests.lock().unwrap().is_empty());
        let barrier = view.update(cx, |view, cx| view.prepare_release(cx));
        composer.update(cx, |field, cx| field.set_text("new context", cx));
        let settled = std::rc::Rc::new(std::cell::Cell::new(false));
        let finished = settled.clone();
        cx.spawn(async move |_| {
            barrier.await.unwrap();
            finished.set(true);
        })
        .detach();
        wait(cx, |_| settled.get());
        assert_eq!(
            composer.read_with(cx, |field, _| field.text()),
            "new context"
        );
        assert!(!view.read_with(cx, |view, _| view.pending()));
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
    #[gpui::test]
    fn credential_edits_use_only_secret_store_and_allow_failed_audio_retry(
        cx: &mut TestAppContext,
    ) {
        let server = Server::new(vec![], Duration::ZERO);
        let client = server.client();
        let secrets = client.secrets.clone();
        let (view, cx) = open(cx, client);
        view.update(cx, |view, cx| {
            view.queue.push_back(audio());
            view.error = Some(Failure::Authentication);
            view.key
                .update(cx, |field, cx| field.set_text("synthetic-replacement", cx));
            view.credential(false, cx);
        });
        wait(cx, |cx| view.read_with(cx, |v, _| !v.credentials_busy));
        assert_eq!(
            secrets.get(KEY).unwrap().as_deref(),
            Some("synthetic-replacement")
        );
        assert_eq!(view.read_with(cx, |v, cx| v.key.read(cx).text()), "");
        assert_eq!(view.read_with(cx, |v, _| v.queue.len()), 1);
        assert!(server.requests.lock().unwrap().is_empty());
        view.update(cx, |view, cx| {
            view.cancel(cx);
            view.credential(true, cx);
        });
        wait(cx, |cx| view.read_with(cx, |v, _| !v.credentials_busy));
        assert!(!secrets.contains(KEY).unwrap());
    }
    #[gpui::test]
    fn closing_window_cancels_even_a_retained_view(cx: &mut TestAppContext) {
        let server = Server::new(vec![(200, transcript("late"))], Duration::from_millis(150));
        let (view, cx) = open(cx, server.client());
        let composer = view.read_with(cx, |v, _| v.composer.clone());
        view.update(cx, |v, cx| {
            v.queue.push_back(audio());
            v.pump(cx);
        });
        wait(cx, |_| !server.requests.lock().unwrap().is_empty());
        cx.update(|window, _| window.remove_window());
        let end = Instant::now() + Duration::from_secs(5);
        while view.read_with(cx, |v, _| v.pending()) {
            cx.run_until_parked();
            assert!(Instant::now() < end);
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(view.read_with(cx, |v, _| v.cancel.is_cancelled()));
        assert_eq!(composer.read_with(cx, |v, _| v.text()), "");
    }
}
