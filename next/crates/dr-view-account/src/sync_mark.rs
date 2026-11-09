//! Lower-left paper sync status mark, hover card and notification-bell bridge
//! (`docs/hosted-sync/sync-status.md`, M36).
//!
//! Ready to mount into F6's `dr_shell::workspace::corner` once the lower-left
//! paper corner slot is connected.

use std::collections::BTreeMap;
use std::rc::Rc;

use dr_i18n::Locale;
use dr_shell::notifications::{NoticeAction, Notifications, Source};
use dr_shell::settings::{self, registry::Section};
use dr_shell::strings::Strings;
use dr_sync::{
    PaperSyncMarkPresentation, SyncCornerState, SyncHealthSnapshot, SyncProblem, SyncStatusAction,
    SyncStatusVisual, evaluate_paper_sync_mark, sync_problems_of,
};
use dr_ui::{
    Theme,
    fonts::Role,
    style::DrStyled,
    tokens::{radius, space},
};
use gpui::{
    AnyElement, App, Global, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement as _, Styled, Window, div, px,
};

use crate::open_auth_dialog;

/// Inset from the lower-left corner of the paper, matching `corner::CORNER_INSET`.
pub const PAPER_SYNC_CORNER_INSET: f32 = 18.0;

/// Callback invoked when a retry button is clicked.
pub type SyncRetryCallback = Rc<dyn Fn(&mut Window, &mut App)>;

/// Callback invoked when any [`SyncStatusAction`] button is clicked.
pub type SyncActionCallback = Rc<dyn Fn(SyncStatusAction, &mut Window, &mut App)>;

/// Localized copy for the paper sync hover card and notification bell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncStatusCopy {
    pub title: SharedString,
    pub detail: SharedString,
}

/// Resolve localized title and detail copy for a [`SyncCornerState`].
pub fn sync_status_copy(state: SyncCornerState, locale: Locale) -> SyncStatusCopy {
    let zh = matches!(locale, Locale::ZhCn);
    match state {
        SyncCornerState::Syncing => SyncStatusCopy {
            title: if zh { "正在同步" } else { "Syncing" }.into(),
            detail: if zh {
                "正在与云端同步改动，本地编辑不受影响。"
            } else {
                "Syncing your changes with the cloud. Local edits continue normally."
            }
            .into(),
        },
        SyncCornerState::Retrying => SyncStatusCopy {
            title: if zh {
                "同步正在重试"
            } else {
                "Retrying sync"
            }
            .into(),
            detail: if zh {
                "后台正在自动重试，本地改动已安全保存。"
            } else {
                "Retrying automatically in the background. Local changes are safely saved."
            }
            .into(),
        },
        SyncCornerState::Offline => SyncStatusCopy {
            title: if zh { "当前离线" } else { "Offline" }.into(),
            detail: if zh {
                "网络恢复后将自动继续同步。"
            } else {
                "Sync will resume automatically once your connection returns."
            }
            .into(),
        },
        SyncCornerState::Problem(SyncProblem::NotStarted) => SyncStatusCopy {
            title: if zh {
                "同步没能启动"
            } else {
                "Sync couldn't start"
            }
            .into(),
            detail: if zh {
                "云同步未能启动，请点击重试。"
            } else {
                "Cloud sync could not start. Click Retry to try again."
            }
            .into(),
        },
        SyncCornerState::Problem(SyncProblem::Reauth) => SyncStatusCopy {
            title: if zh {
                "需要重新登录"
            } else {
                "Sign in again to keep syncing"
            }
            .into(),
            detail: if zh {
                "登录凭证已过期，重新登录后继续同步。"
            } else {
                "Your session has expired. Sign in again to resume syncing."
            }
            .into(),
        },
        SyncCornerState::Problem(SyncProblem::Quota) => SyncStatusCopy {
            title: if zh {
                "云空间已满，同步已暂停"
            } else {
                "Cloud storage is full — sync is paused"
            }
            .into(),
            detail: if zh {
                "已达到云端存储上限，清理空间或查看设置后可继续同步。"
            } else {
                "Cloud storage has reached its quota. Free up space or check Settings to continue."
            }
            .into(),
        },
        SyncCornerState::Problem(SyncProblem::Failing) => SyncStatusCopy {
            title: if zh {
                "同步暂时连不上"
            } else {
                "Sync can't reach the cloud right now"
            }
            .into(),
            detail: if zh {
                "已连续多次同步失败，本地改动均已保存，可随时重试。"
            } else {
                "Sync has failed several times in a row. Your local edits are safe; retry anytime."
            }
            .into(),
        },
    }
}

/// Localized label for a [`SyncStatusAction`] button.
pub fn sync_action_label(action: SyncStatusAction, locale: Locale) -> SharedString {
    let zh = matches!(locale, Locale::ZhCn);
    match action {
        SyncStatusAction::Retry => if zh { "重试" } else { "Retry" }.into(),
        SyncStatusAction::SignIn => if zh { "重新登录" } else { "Sign in" }.into(),
        SyncStatusAction::OpenSettings => if zh { "打开设置" } else { "Open Settings" }.into(),
    }
}

/// Global tracking pinned notification-bell notice IDs for active [`SyncProblem`]s.
#[derive(Default)]
pub struct PinnedSyncNotices {
    by_problem: BTreeMap<SyncProblem, u64>,
}

impl Global for PinnedSyncNotices {}

/// Synchronize active severe [`SyncProblem`]s into `dr_shell::notifications::Notifications`
/// (`Source::Sync`).
///
/// - Severe problems (`NotStarted`, `Reauth`, `Quota`, `Failing`) post one notice
///   per problem and stay pinned until resolved.
/// - Ordinary transfers (`Syncing`, `Retrying`, `Offline`) never post to the
///   notification center.
pub fn reconcile_sync_problem_notifications(
    snapshot: &SyncHealthSnapshot,
    now_ms: u64,
    on_retry: Option<SyncRetryCallback>,
    cx: &mut App,
) {
    if !cx.has_global::<PinnedSyncNotices>() {
        cx.set_global(PinnedSyncNotices::default());
    }
    let active = sync_problems_of(snapshot, now_ms);
    let locale = Strings::get(cx).locale();

    let existing: BTreeMap<SyncProblem, u64> = cx.global::<PinnedSyncNotices>().by_problem.clone();

    // Remove notices for problems that have been resolved.
    for (problem, notice_id) in &existing {
        if !active.contains(problem) {
            Notifications::remove(*notice_id, cx);
            cx.global_mut::<PinnedSyncNotices>()
                .by_problem
                .remove(problem);
        }
    }

    // Post notices for newly active severe problems.
    for problem in active {
        if cx
            .global::<PinnedSyncNotices>()
            .by_problem
            .contains_key(&problem)
        {
            continue;
        }
        let copy = sync_status_copy(SyncCornerState::Problem(problem), locale);
        let text: SharedString = format!("{} — {}", copy.title, copy.detail).into();
        let action = match problem {
            SyncProblem::Reauth => Some(NoticeAction {
                label: sync_action_label(SyncStatusAction::SignIn, locale),
                run: Rc::new(|notice_id, window, cx| {
                    Notifications::remove(notice_id, cx);
                    open_auth_dialog(window, cx);
                }),
            }),
            SyncProblem::Quota => Some(NoticeAction {
                label: sync_action_label(SyncStatusAction::OpenSettings, locale),
                run: Rc::new(|_notice_id, window, cx| {
                    settings::open_section(Section::Account, window, cx);
                }),
            }),
            SyncProblem::NotStarted | SyncProblem::Failing => {
                let retry_cb = on_retry.clone();
                Some(NoticeAction {
                    label: sync_action_label(SyncStatusAction::Retry, locale),
                    run: Rc::new(move |_notice_id, window, cx| {
                        if let Some(cb) = &retry_cb {
                            cb(window, cx);
                        }
                    }),
                })
            }
        };

        let id = match action {
            Some(act) => Notifications::post_with(Source::Sync, text, act, cx),
            None => Notifications::post(Source::Sync, text, cx),
        };
        cx.global_mut::<PinnedSyncNotices>()
            .by_problem
            .insert(problem, id);
    }
}

/// Render the lower-left paper corner sync mark (`PaperSyncMarkPresentation`).
///
/// Positioned at `left(px(PAPER_SYNC_CORNER_INSET)).bottom(px(PAPER_SYNC_CORNER_INSET))`
/// on the leading paper pane. Returns an empty invisible element when
/// `presentation.visual == SyncStatusVisual::Hidden`.
pub fn render_paper_sync_mark(
    presentation: &PaperSyncMarkPresentation,
    hovered: bool,
    locale: Locale,
    on_action: Option<SyncActionCallback>,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let Some(corner_state) = presentation.corner else {
        return div().id("paper-sync-mark-hidden").into_any_element();
    };
    if presentation.visual == SyncStatusVisual::Hidden {
        return div().id("paper-sync-mark-hidden").into_any_element();
    }

    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let opacity = if presentation.faded_for_typing {
        0.0
    } else {
        1.0
    };

    let (glyph, glyph_color) = match presentation.visual {
        SyncStatusVisual::Hidden => ("", p.muted().solid()),
        SyncStatusVisual::BreathingCloud => ("☁", p.muted().solid()),
        SyncStatusVisual::BlinkingCloud => ("☁", p.ink(1).solid()),
        SyncStatusVisual::LooseSandCloud => ("◌", p.muted().solid()),
        SyncStatusVisual::DangerExclamation => ("!", p.danger.solid()),
    };

    let copy = sync_status_copy(corner_state, locale);

    let mut root = div()
        .id("paper-sync-mark")
        .absolute()
        .left(px(PAPER_SYNC_CORNER_INSET))
        .bottom(px(PAPER_SYNC_CORNER_INSET))
        .opacity(opacity)
        .flex()
        .flex_col()
        .gap(px(space::S2));

    if hovered && !presentation.faded_for_typing {
        let mut card = div()
            .id("paper-sync-hover-card")
            .w(px(236.0))
            .p(px(space::S3))
            .rounded(px(radius::MD))
            .bg(p.surface.solid())
            .border_1()
            .border_color(p.hairline())
            .flex()
            .flex_col()
            .gap(px(space::S2))
            .child(
                div()
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.ink(1).solid())
                    .child(copy.title),
            )
            .child(
                div()
                    .font_role(Role::Ui)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.muted().solid())
                    .child(copy.detail),
            );

        if !presentation.actions.is_empty() {
            let mut row = div().flex().items_center().gap(px(space::S2));
            for action in &presentation.actions {
                let action_val = *action;
                let label = sync_action_label(action_val, locale);
                let cb = on_action.clone();
                row = row.child(
                    div()
                        .id(SharedString::from(format!("sync-action-{action_val:?}")))
                        .px(px(space::S2))
                        .py(px(space::S1))
                        .rounded(px(radius::SM))
                        .bg(p.paper.solid())
                        .font_role(Role::Ui)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.ink(1).solid())
                        .cursor_pointer()
                        .on_click(move |_, window, cx| {
                            match action_val {
                                SyncStatusAction::SignIn => open_auth_dialog(window, cx),
                                SyncStatusAction::OpenSettings => {
                                    settings::open_section(Section::Account, window, cx)
                                }
                                SyncStatusAction::Retry => {}
                            }
                            if let Some(cb) = &cb {
                                cb(action_val, window, cx);
                            }
                        })
                        .child(label),
                );
            }
            card = card.child(row);
        }
        root = root.child(card);
    }

    let seal = div()
        .id("paper-sync-seal")
        .w(px(22.0))
        .h(px(22.0))
        .rounded(px(11.0))
        .flex()
        .items_center()
        .justify_center()
        .font_role(Role::Ui)
        .type_px(s.secondary, s.line_body)
        .text_color(glyph_color)
        .child(glyph);

    root.child(seal).into_any_element()
}

/// Evaluate and build the paper sync mark for `book_id` at `now_ms`.
#[allow(clippy::too_many_arguments)]
pub fn paper_sync_mark_for(
    snapshot: &SyncHealthSnapshot,
    book_id: Option<&str>,
    is_trailing_pane: bool,
    last_typing_ms: Option<u64>,
    now_ms: u64,
    hovered: bool,
    locale: Locale,
    on_action: Option<SyncActionCallback>,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let presentation =
        evaluate_paper_sync_mark(snapshot, book_id, is_trailing_pane, last_typing_ms, now_ms);
    render_paper_sync_mark(&presentation, hovered, locale, on_action, window, cx)
}
