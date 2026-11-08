//! Author input stays frozen for the entire shared release, including after
//! one service has drained while another is still waiting. Existing views
//! stay alive so each service can flush its drafts after the blur.

use dr_i18n::keys;
use dr_ui::components::overlay::{self, Layer, Place};
use gpui::{
    AnyElement, AnyWindowHandle, App, Global, InteractiveElement as _, IntoElement as _,
    StatefulInteractiveElement as _, Styled as _, WeakFocusHandle, Window, div,
};

#[derive(Default)]
struct Paused(Vec<(AnyWindowHandle, Option<WeakFocusHandle>)>);
impl Global for Paused {}

fn capture(window: &mut Window, cx: &mut App) {
    let handle = window.window_handle();
    if !cx
        .default_global::<Paused>()
        .0
        .iter()
        .any(|(old, _)| old.window_id() == handle.window_id())
    {
        let previous = window.focused(cx).map(|focus| focus.downgrade());
        cx.default_global::<Paused>().0.push((handle, previous));
    }
    // A late focus request from work accepted before release cannot restore
    // an input handler underneath the curtain in a subsequent frame.
    window.blur(cx);
}

pub(super) fn pause(cx: &mut App) -> Result<(), String> {
    let mut failed = None;
    for handle in cx.windows() {
        if handle.downcast::<crate::Workspace>().is_none() {
            continue;
        }
        // The erased handle does not check out the root entity while it
        // renders. Drawing now removes the old native text input handler
        // and delivers blur before service futures start flushing drafts.
        if let Err(error) = handle.update(cx, |_, window, cx| {
            capture(window, cx);
            window.refresh();
            window.draw(cx).clear(cx);
        }) {
            log::warn!("a workspace could not freeze input: {error:#}");
            failed = Some("a workspace could not pause editing before saving".into());
        }
    }
    failed.map_or(Ok(()), Err)
}

pub(crate) fn curtain(window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    if !super::is_releasing(cx) {
        return None;
    }
    capture(window, cx);
    let viewport = window.viewport_size();
    Some(
        overlay::float(
            Place::Center,
            Layer::Blocking,
            div()
                .id("release-input-barrier")
                .debug_selector(|| "release-input-barrier".into())
                .w(viewport.width)
                .h(viewport.height)
                .occlude()
                .role(gpui::Role::ProgressIndicator)
                .aria_label(crate::t(cx, keys::common::PROCESSING))
                .capture_key_down(|_, window, cx| {
                    window.prevent_default();
                    cx.stop_propagation();
                })
                .capture_key_up(|_, _, cx| cx.stop_propagation()),
        )
        .into_any_element(),
    )
}

pub(super) fn resume(cx: &mut App) {
    let paused = std::mem::take(&mut cx.default_global::<Paused>().0);
    for (handle, previous) in paused {
        // Rebuild the dispatch tree without the curtain. A successful swap
        // may have replaced every old page; a weak focus handle alone is
        // not proof that the old field is still on the visible page.
        if handle
            .update(cx, |_, window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
            })
            .is_err()
        {
            continue;
        }
        if let Some(handle) = handle.downcast::<crate::Workspace>() {
            let _ = handle.update(cx, |ws, window, cx| {
                if let Some(previous) = previous.and_then(|focus| focus.upgrade())
                    && ws.focus_handle().contains(&previous, window)
                {
                    previous.focus(window, cx);
                } else {
                    ws.refocus(window, cx);
                }
            });
        }
    }
}
