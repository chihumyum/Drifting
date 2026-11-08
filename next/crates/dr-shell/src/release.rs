//! Before the shell gives up its library, services stop accepting work and
//! asynchronously settle everything already entered. The same gate protects
//! library replacement and the app's ordinary quit flow.

use std::panic::{AssertUnwindSafe, catch_unwind};

use futures::{FutureExt, future::LocalBoxFuture};
use gpui::{App, Global};

type Prepare = Box<dyn FnMut(&mut App) -> LocalBoxFuture<'static, Result<(), String>>>;
type Resume = Box<dyn FnMut(&mut App)>;

#[derive(Default)]
struct Hooks {
    preparing: bool,
    before: Vec<Prepare>,
    after: Vec<Resume>,
}

impl Global for Hooks {}

/// Registers a service that must settle before the library is released.
///
/// The callback runs synchronously when release is requested: freeze new work
/// there, and return a future that aborts and awaits existing work, then drops
/// its library handles. Do not check out windows in this synchronous prefix:
/// the request may come from a window already checked out by its action.
/// Futures run on the foreground executor and must never block it with join.
/// Every registered future is awaited, even when another returns an error.
pub fn before_release(
    cx: &mut App,
    hook: impl FnMut(&mut App) -> LocalBoxFuture<'static, Result<(), String>> + 'static,
) {
    cx.default_global::<Hooks>().before.push(Box::new(hook));
}

/// Restores services after a failed preparation or a finished replacement.
/// `Services.library` already contains the library now in use (or None when
/// reopening failed), and the release gate is open. Rebuild from those current
/// services instead of keeping the old library alive in the callback.
/// Successful quitting does not call these hooks.
pub fn after_release(cx: &mut App, hook: impl FnMut(&mut App) + 'static) {
    cx.default_global::<Hooks>().after.push(Box::new(hook));
}

/// New work and another quit/replacement must wait while this is true.
pub fn is_releasing(cx: &App) -> bool {
    cx.try_global::<Hooks>().is_some_and(|h| h.preparing)
}

/// Claims the common gate before deferring any window work. Construct every
/// future now, so all services freeze their admission gates in this dispatch.
pub(crate) fn begin(cx: &mut App) -> Option<LocalBoxFuture<'static, Result<(), String>>> {
    let hooks = cx.default_global::<Hooks>();
    if hooks.preparing {
        return None;
    }
    hooks.preparing = true;
    let mut before = std::mem::take(&mut hooks.before);
    let futures: Vec<_> = before
        .iter_mut()
        .map(|hook| {
            let future = catch_unwind(AssertUnwindSafe(|| hook(cx)));
            async move {
                match future {
                    Ok(future) => AssertUnwindSafe(future)
                        .catch_unwind()
                        .await
                        .unwrap_or_else(|_| Err("library release hook panicked".into())),
                    Err(_) => Err("library release hook panicked".into()),
                }
            }
            .boxed_local()
        })
        .collect();
    before.append(&mut cx.default_global::<Hooks>().before);
    cx.default_global::<Hooks>().before = before;
    Some(
        async move {
            // A failing service must not drop another service's unfinished
            // shutdown: it may still be waiting for a durable tool write.
            let results = futures::future::join_all(futures).await;
            results
                .into_iter()
                .collect::<Result<Vec<_>, _>>()
                .map(|_| ())
        }
        .boxed_local(),
    )
}

pub(crate) fn finish(cx: &mut App) {
    let hooks = cx.default_global::<Hooks>();
    if !hooks.preparing {
        return;
    }
    hooks.preparing = false;
    let mut after = std::mem::take(&mut hooks.after);
    for hook in &mut after {
        hook(cx);
    }
    after.append(&mut cx.default_global::<Hooks>().after);
    cx.default_global::<Hooks>().after = after;
}
