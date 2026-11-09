//! Host the v3 checkpoint worker without keeping a replaced library alive.
use dr_view_history::automatic::{AutomaticHistory, capture_on_close};
use gpui::{App, Global};

#[derive(Default)]
struct History(Option<AutomaticHistory>);
impl Global for History {}

fn start(cx: &mut App) {
    let ws = cx
        .try_global::<dr_shell::Services>()
        .and_then(|s| s.library.clone());
    cx.default_global::<History>().0 = ws.map(AutomaticHistory::start);
}
pub fn init(cx: &mut App) {
    start(cx);
    dr_shell::release::before_release(cx, |cx| {
        let service = cx.default_global::<History>().0.take();
        let finish = cx
            .background_executor()
            .spawn(async move { service.map(AutomaticHistory::finish).unwrap_or(Ok(())) });
        Box::pin(finish)
    });
    dr_shell::release::after_release(cx, start);
    dr_shell::quit::before_quit(cx, |cx| {
        // Runs after the release futures have drained Agent/field writes.
        if let Some(ws) = cx
            .try_global::<dr_shell::Services>()
            .and_then(|s| s.library.clone())
            && let Err(e) = capture_on_close(&ws)
        {
            log::error!("final entry checkpoint failed: {e}");
        }
    });
}
