//! Home settings send only fields the author changed since opening the form.
use dr_i18n::keys;
use dr_shell::t;
use dr_ui::{
    Theme,
    components::{Button, Dialog},
    input::{FieldEvent, TextArea, TextField},
};
use dr_view_stats::v3::Loaded;
use dr_workspace::{
    Actor, Workspace, WsError,
    commands::book::{BookUpdate, BookUpdateIn},
};
use gpui::{
    AppContext as _, Context, Entity, Focusable, IntoElement, ParentElement, Render, Styled,
    Subscription, Window, div, px,
};

#[derive(Clone, Debug, PartialEq, Eq)]
struct Values {
    name: String,
    summary: String,
    goal: String,
    daily: String,
}

impl Values {
    fn update(&self, book: &str, baseline: &Self) -> Result<BookUpdateIn, WsError> {
        let target = |s: &str| -> Result<i64, WsError> {
            if s.trim().is_empty() {
                return Ok(0);
            }
            s.trim()
                .parse::<i64>()
                .ok()
                .filter(|v| *v >= 0)
                .ok_or_else(|| WsError::Invalid("invalid word target".into()))
        };
        if self.name.trim().is_empty() {
            return Err(WsError::Invalid("empty book name".into()));
        }
        Ok(BookUpdateIn {
            book: book.into(),
            name: (self.name != baseline.name).then(|| self.name.trim().to_owned()),
            summary: (self.summary != baseline.summary).then(|| self.summary.clone()),
            word_target: (self.goal != baseline.goal)
                .then(|| target(&self.goal).map(Some))
                .transpose()?,
            daily_word_target: (self.daily != baseline.daily)
                .then(|| target(&self.daily).map(Some))
                .transpose()?,
        })
    }
}

pub(crate) struct SettingsDialog {
    lib: Workspace,
    book: String,
    baseline: Values,
    name: Entity<TextField>,
    summary: Entity<TextArea>,
    goal: Entity<TextField>,
    daily: Entity<TextField>,
    busy: bool,
    error: bool,
    _events: Vec<Subscription>,
}

impl SettingsDialog {
    pub fn new(
        lib: Workspace,
        book: String,
        data: &Loaded,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let values = Values {
            name: data.title.clone(),
            summary: data.summary.clone(),
            goal: data.word_target.unwrap_or(0).to_string(),
            daily: data.daily_word_target.unwrap_or(0).to_string(),
        };
        let name = cx
            .new(|cx| TextField::new("v3-home-settings-name", window, cx).with_text(&values.name));
        let summary = cx.new(|cx| {
            TextArea::new("v3-home-settings-summary", window, cx).with_text(&values.summary)
        });
        let goal = cx
            .new(|cx| TextField::new("v3-home-settings-goal", window, cx).with_text(&values.goal));
        let daily = cx.new(|cx| {
            TextField::new("v3-home-settings-daily", window, cx).with_text(&values.daily)
        });
        let mut events = Vec::new();
        for field in [&name, &goal, &daily] {
            events.push(
                cx.subscribe_in(field, window, |d, _, event, _, cx| match event {
                    FieldEvent::Submitted(_) => d.save(cx),
                    FieldEvent::Cancelled => d.close(cx),
                    _ => {}
                }),
            );
        }
        events.push(
            cx.subscribe_in(&summary, window, |d, _, event, _, cx| match event {
                FieldEvent::Submitted(_) => d.save(cx),
                FieldEvent::Cancelled => d.close(cx),
                _ => {}
            }),
        );
        name.focus_handle(cx).focus(window, cx);
        Self {
            lib,
            book,
            baseline: values,
            name,
            summary,
            goal,
            daily,
            busy: false,
            error: false,
            _events: events,
        }
    }
    fn close(&self, cx: &mut Context<Self>) {
        if !self.busy {
            let id = cx.entity_id();
            dr_shell::dialogs::hide(cx, id);
        }
    }
    fn disable(&mut self, disabled: bool, cx: &mut Context<Self>) {
        for f in [&self.name, &self.goal, &self.daily] {
            f.update(cx, |f, cx| f.set_disabled(disabled, cx));
        }
        self.summary
            .update(cx, |f, cx| f.set_disabled(disabled, cx));
    }
    fn save(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let values = Values {
            name: self.name.read(cx).text().to_owned(),
            summary: self.summary.read(cx).text(),
            goal: self.goal.read(cx).text().to_owned(),
            daily: self.daily.read(cx).text().to_owned(),
        };
        let input = match values.update(&self.book, &self.baseline) {
            Ok(input) => input,
            Err(_) => {
                self.error = true;
                cx.notify();
                return;
            }
        };
        if input.name.is_none()
            && input.summary.is_none()
            && input.word_target.is_none()
            && input.daily_word_target.is_none()
        {
            self.close(cx);
            return;
        }
        self.busy = true;
        self.error = false;
        self.disable(true, cx);
        let lib = self.lib.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { lib.run::<BookUpdate>(&Actor::User, input) })
                .await;
            this.update(cx, |d, cx| {
                d.busy = false;
                d.disable(false, cx);
                if result.is_ok() {
                    d.close(cx);
                } else {
                    d.error = true;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
}

impl Render for SettingsDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let save = me.clone();
        let close = me.clone();
        Dialog::new(
            "v3-home-settings-dialog",
            t(cx, keys::project_home::views::SETTINGS),
        )
        .body(
            div()
                .flex()
                .flex_col()
                .gap(px(10.0))
                .child(t(cx, keys::dashboard::hero::PROJECT_NAME))
                .child(self.name.clone())
                .child(t(cx, keys::project_home::settings::PROJECT_TARGET))
                .child(self.goal.clone())
                .child(t(cx, keys::project_home::settings::DAILY_GOAL))
                .child(self.daily.clone())
                .child(t(cx, keys::dashboard::sections::PROJECT_PROFILE))
                .child(self.summary.clone())
                .children(self.error.then(|| {
                    div()
                        .text_color(Theme::of(window, cx).palette.danger.solid())
                        .child(t(cx, keys::common::SAVE_FAILED))
                })),
        )
        .action(
            Button::new("v3-home-settings-cancel", t(cx, keys::common::CANCEL))
                .disabled(self.busy)
                .on_click(move |_, _, cx| close.update(cx, |d, cx| d.close(cx))),
        )
        .action(
            Button::new("v3-home-settings-save", t(cx, keys::common::SAVE))
                .primary()
                .busy(self.busy)
                .disabled(self.busy)
                .on_click(move |_, _, cx| save.update(cx, |d, cx| d.save(cx))),
        )
        .on_close(move |_, cx| me.update(cx, |d, cx| d.close(cx)))
        .on_mist(|_, _| {})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_shell::{Services, SettingsFile, ShellInfo};
    use dr_ui::Appearance;
    use dr_view_stats::v3::{self, Scope};
    use dr_workspace::{Faults, WorkspaceOptions};
    use gpui::{TestAppContext, VisualTestContext};
    use serde_json::json;
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };

    struct Frame(Entity<SettingsDialog>);
    impl Render for Frame {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().child(self.0.clone())
        }
    }
    fn wait(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            cx.run_until_parked();
            cx.update(|window, cx| window.draw(cx).clear(cx));
            if done(cx) {
                return;
            }
            assert!(Instant::now() < until, "home settings timed out");
            std::thread::sleep(Duration::from_millis(3));
        }
    }
    #[gpui::test]
    fn settings_keep_unedited_fields_and_a_failed_draft(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let dir = tempfile::tempdir().unwrap();
        let lib =
            dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
        let seed = dr_testkit::seed::generate_v3(
            dr_testkit::seed::Preset::Tiny,
            dr_testkit::seed::DEFAULT_SEED,
        )
        .unwrap();
        let book = seed.books[0].book_id().to_string();
        seed.write_to(&lib).unwrap();
        let faults = Arc::new(Faults::default());
        let ws = Workspace::open(
            lib,
            WorkspaceOptions {
                faults: Some(faults.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        let original = v3::load(&ws, &book, Scope::Book).unwrap();
        let hidden = ws.observe(&format!("book:{book}")).unwrap().value;
        cx.update(|cx| {
            dr_shell::init(
                ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "0.2.0-dev",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: Some(Appearance::Light),
                },
                Services::default(),
                SettingsFile::in_memory(),
                cx,
            )
        });
        let (frame, cx) = cx.add_window_view(|window, cx| {
            Frame(cx.new(|cx| SettingsDialog::new(ws.clone(), book.clone(), &original, window, cx)))
        });
        let dialog = frame.read_with(cx, |f, _| f.0.clone());
        let draft = format!("{} {}", original.title, original.title);
        dialog.update(cx, |d, cx| {
            d.name.update(cx, |f, cx| f.set_text(&draft, cx))
        });
        // A different writer changes summary and target while the form is open.
        ws.call(
            &Actor::User,
            "book.update",
            json!({"book":book,"summary":original.title,"word_target":12345}),
        )
        .unwrap();
        faults.arm("after_prose");
        dialog.update(cx, |d, cx| d.save(cx));
        wait(cx, |cx| dialog.read_with(cx, |d, _| !d.busy));
        assert!(dialog.read_with(cx, |d, _| d.error));
        assert_eq!(dialog.read_with(cx, |d, cx| d.name.read(cx).text()), draft);
        assert_eq!(
            v3::load(&ws, &book, Scope::Book).unwrap().title,
            original.title
        );
        dialog.update(cx, |d, cx| d.save(cx));
        wait(cx, |cx| dialog.read_with(cx, |d, _| !d.busy));
        assert!(!dialog.read_with(cx, |d, _| d.error));
        let current = v3::load(&ws, &book, Scope::Book).unwrap();
        assert_eq!(current.title, draft);
        assert_eq!(current.summary, original.title);
        assert_eq!(current.word_target, Some(12345));
        assert_eq!(current.daily_word_target, original.daily_word_target);
        let after = ws.observe(&format!("book:{book}")).unwrap().value;
        for key in ["entries", "comments", "materials", "templates"] {
            assert!(!hidden[key].is_null(), "seed root {key} is present");
            assert_eq!(after[key], hidden[key]);
        }
        // Invalid numeric input cannot write another field or discard its draft.
        dialog.update(cx, |d, cx| {
            d.goal.update(cx, |f, cx| f.set_text("-1", cx));
            d.summary.update(cx, |f, cx| f.set_text(&draft, cx));
            d.save(cx);
        });
        assert!(dialog.read_with(cx, |d, _| d.error && !d.busy));
        assert_eq!(
            dialog.read_with(cx, |d, cx| d.summary.read(cx).text()),
            draft
        );
        assert_eq!(
            v3::load(&ws, &book, Scope::Book).unwrap().summary,
            original.title
        );
        ws.close();
    }
}
