//! The small dialog a move runs in: what is happening with a bar, what came
//! of it, a question before replacing the library, or why it could not be
//! done. Shown as the shell's modal dialog (`dr_shell::dialogs`), so the
//! workspace waits while a file is written.

use dr_i18n::{I18n, Key, keys};
use dr_ui::components::{Button, Dialog, Progress};
use dr_ui::style::DrStyled;
use dr_ui::tokens::space;
use dr_ui::{Theme, fonts::Role};
use gpui::{
    App, AppContext as _, Context, Entity, IntoElement, ParentElement, Render, SharedString,
    Styled, Window, div, px,
};

/// The dialog's width.
pub const WIDTH: f32 = 440.0;

#[derive(Clone, Debug, PartialEq)]
pub enum State {
    /// Running: a title, what it is working on, and how far (`None`: not
    /// known yet).
    Working {
        title: Key,
        name: String,
        progress: Option<f32>,
    },
    /// Finished with something to read.
    Done { title: Key, text: String },
    /// A question before something that cannot be taken back; `confirm`
    /// names the button that goes ahead.
    Confirm {
        title: Key,
        text: String,
        confirm: Key,
    },
    /// It could not be done: a title, the reason (a string key) and the
    /// sentence shown.
    Failed {
        title: Key,
        reason: Key,
        text: String,
    },
}

/// What 「替换并恢复」 or a confirmed question goes on to do.
pub type Proceed = Box<dyn FnOnce(Entity<TransferDialog>, &mut App)>;

pub struct TransferDialog {
    pub state: State,
    pub(crate) i18n: I18n,
    proceed: Option<Proceed>,
}

impl TransferDialog {
    pub fn new(state: State, cx: &App) -> TransferDialog {
        let strings = dr_shell::Strings::get(cx);
        TransferDialog {
            state,
            i18n: I18n::new(strings.locale(), strings.platform()),
            proceed: None,
        }
    }

    /// Opens a dialog in `state` over the workspace.
    pub fn show(state: State, cx: &mut App) -> Entity<TransferDialog> {
        let dialog = cx.new(|cx| TransferDialog::new(state, cx));
        dr_shell::dialogs::show(cx, dialog.clone().into());
        dialog
    }

    pub fn progress(&mut self, done: usize, total: usize, cx: &mut Context<Self>) {
        if let State::Working { progress, .. } = &mut self.state {
            *progress = (total > 0).then(|| done as f32 / total as f32);
            cx.notify();
        }
    }

    pub fn set(&mut self, state: State, cx: &mut Context<Self>) {
        self.state = state;
        cx.notify();
    }

    /// Asks before going on: `proceed` runs on the confirm button.
    pub fn ask(&mut self, state: State, proceed: Proceed, cx: &mut Context<Self>) {
        self.state = state;
        self.proceed = Some(proceed);
        cx.notify();
    }

    /// Failed with the sentence of `reason`.
    pub fn fail(&mut self, title: Key, reason: Key, detail: String, cx: &mut Context<Self>) {
        log::warn!("transfer: {detail}");
        let text = self.i18n.fmt(reason, &[("detail", &detail)]);
        self.state = State::Failed {
            title,
            reason,
            text,
        };
        self.proceed = None;
        cx.notify();
    }

    pub fn is_working(&self) -> bool {
        matches!(self.state, State::Working { .. })
    }

    /// The confirm button: what was asked goes ahead.
    pub fn confirm(&mut self, cx: &mut Context<Self>) {
        if let Some(proceed) = self.proceed.take() {
            let me = cx.entity();
            cx.defer(move |cx| proceed(me, cx));
        }
    }

    /// Closes the dialog (not while it works); a question not answered is
    /// let go.
    pub fn close(&mut self, cx: &mut Context<Self>) {
        if !self.is_working() {
            self.proceed = None;
            let id = cx.entity_id();
            // The window is busy with the click or key that closes it (the
            // shell could not reach its workspace): once that is over.
            cx.defer(move |cx| dr_shell::dialogs::hide(cx, id));
        }
    }

    /// Done: the dialog goes.
    pub fn done(&mut self, cx: &mut Context<Self>) {
        let id = cx.entity_id();
        dr_shell::dialogs::hide(cx, id);
    }
}

impl Render for TransferDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let line = |text: SharedString, color: gpui::Hsla| {
            div()
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .text_color(color)
                .child(text)
        };
        let lines = |text: &str| {
            div().flex().flex_col().gap(px(space::S2)).children(
                text.split('\n')
                    .filter(|l| !l.trim().is_empty())
                    .map(|l| line(l.to_owned().into(), p.ink(1).solid())),
            )
        };
        let this = cx.entity();
        let close_button = |label: Key, primary: bool| {
            let close = this.clone();
            let b = Button::new("transfer-close", self.i18n.t(label))
                .on_click(move |_, _, cx| close.update(cx, |d, cx| d.close(cx)));
            if primary { b.primary() } else { b }
        };
        let mut dialog = match &self.state {
            State::Working {
                title,
                name,
                progress,
            } => Dialog::new("transfer-dialog", self.i18n.t(*title))
                .width(WIDTH)
                .body(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(space::S3))
                        .child(line(name.clone().into(), p.ink(2).solid()))
                        .child(Progress::new(*progress)),
                ),
            State::Done { title, text } => Dialog::new("transfer-dialog", self.i18n.t(*title))
                .width(WIDTH)
                .body(lines(text))
                .action(close_button(keys::common::CLOSE, true)),
            State::Failed { title, text, .. } => {
                Dialog::new("transfer-dialog", self.i18n.t(*title))
                    .width(WIDTH)
                    .body(lines(text))
                    .action(close_button(keys::common::CLOSE, true))
            }
            State::Confirm {
                title,
                text,
                confirm,
            } => {
                let go = this.clone();
                Dialog::new("transfer-dialog", self.i18n.t(*title))
                    .width(WIDTH)
                    .body(lines(text))
                    .action(close_button(keys::common::CANCEL, false))
                    .action(
                        Button::new("transfer-confirm", self.i18n.t(*confirm))
                            .danger()
                            .on_click(move |_, _, cx| go.update(cx, |d, cx| d.confirm(cx))),
                    )
            }
        };
        if !self.is_working() {
            dialog = dialog.on_close(move |_, cx| this.update(cx, |d, cx| d.close(cx)));
        }
        div().child(dialog)
    }
}
