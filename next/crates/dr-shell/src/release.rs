//! Before the shell gives up its library, services stop accepting work and
//! asynchronously settle everything already entered. The same gate protects
//! library replacement and the app's ordinary quit flow.

use std::panic::{AssertUnwindSafe, catch_unwind};

use futures::{FutureExt, future::LocalBoxFuture};
use gpui::{App, Global};

mod input;
pub(crate) use input::curtain;

type Prepare = Box<dyn FnMut(&mut App) -> LocalBoxFuture<'static, Result<(), String>>>;
type Resume = Box<dyn FnMut(&mut App)>;

#[derive(Default)]
struct Hooks {
    preparing: bool,
    before: Vec<Prepare>,
    checkpoints: Vec<Prepare>,
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

/// Registers a fallible final checkpoint after all `before_release` futures
/// and the shell's final Markdown pass have succeeded. Unlike a prepare
/// callback, its synchronous prefix is also
/// delayed until those services finish. Author input and service admission
/// remain paused, and `Services.library` still holds the original library.
///
/// Checkpoints run in registration order; an error or panic stops release
/// before hiding the app, dropping its pages, or running the replacement job.
/// The normal `after_release` recovery path resumes services and input. These
/// hooks must not start new producers: every producer must already have drained
/// through `before_release`. Use the background executor for blocking storage.
pub fn after_drain(
    cx: &mut App,
    hook: impl FnMut(&mut App) -> LocalBoxFuture<'static, Result<(), String>> + 'static,
) {
    cx.default_global::<Hooks>()
        .checkpoints
        .push(Box::new(hook));
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
    let app = cx.to_async();
    Some(
        async move {
            // The calling action has released its window now. Blur and draw
            // every workspace before polling any service's flush/drain.
            let frozen = app.update(input::pause);
            // A failing service must not drop another service's unfinished
            // shutdown: it may still be waiting for a durable tool write.
            let results = futures::future::join_all(futures).await;
            frozen?;
            results
                .into_iter()
                .collect::<Result<Vec<_>, _>>()
                .map(|_| ())?;
            // Markdown may merge another final write. Its worker must stop
            // after the other writers, and before capturing their final state.
            let mirror = app.update(crate::mirror::drain_for_release);
            let failed =
                app.update(|cx| crate::t(cx, dr_i18n::keys::k4_pages::SAVE_FAILED).to_string());
            AssertUnwindSafe(mirror)
                .catch_unwind()
                .await
                .unwrap_or_else(|_| {
                    log::error!("Markdown folder release panicked");
                    Err(failed.clone())
                })?;
            // Construct checkpoint futures only now. Capturing a frontier in
            // their prefix before the writers settled would still be stale.
            let mut checkpoints =
                app.update(|cx| std::mem::take(&mut cx.default_global::<Hooks>().checkpoints));
            let mut result = Ok(());
            for checkpoint in &mut checkpoints {
                let future = app.update(|cx| catch_unwind(AssertUnwindSafe(|| checkpoint(cx))));
                result = match future {
                    Ok(future) => AssertUnwindSafe(future)
                        .catch_unwind()
                        .await
                        .unwrap_or_else(|_| {
                            log::error!("final library checkpoint future panicked");
                            Err(failed.clone())
                        }),
                    Err(_) => {
                        log::error!("final library checkpoint prefix panicked");
                        Err(failed.clone())
                    }
                };
                if result.is_err() {
                    break;
                }
            }
            app.update(|cx| {
                checkpoints.append(&mut cx.default_global::<Hooks>().checkpoints);
                cx.default_global::<Hooks>().checkpoints = checkpoints;
            });
            result
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
    input::resume(cx);
}
