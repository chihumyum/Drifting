//! G1 view-owned saves participate in the shell's existing release gate.
//! Registrations are weak and carry no library handles. The asynchronous
//! phase runs after the shell has blurred inputs, and waits for durable jobs
//! and their foreground acknowledgements without blocking the UI executor.
use futures::FutureExt as _;
use gpui::{prelude::*, *};
use std::{
    future::Future,
    rc::Rc,
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Clone, Copy, PartialEq, Eq)]
struct Scope(usize);
impl Scope {
    fn of(lib: &dr_workspace::Workspace) -> Self {
        // Workspace clones share this immutable Library slot. Unlike paths,
        // this also distinguishes reopening/restoring the same directory.
        Self(std::ptr::from_ref(lib.library()) as usize)
    }
}

pub enum Drain {
    Ready,
    Pending,
    Failed(String),
}
pub trait Drafts: Sized + 'static {
    /// Flush accepted drafts, without retrying a refused write or replacing
    /// its original observation. Called only after the shared input blur.
    fn drain(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Drain;
}
type Poll = Rc<dyn Fn(&mut App) -> Drain>;
#[derive(Clone)]
struct Registration {
    scope: Scope,
    poll: Poll,
}
struct JobState {
    result: Option<Result<(), String>>,
    acknowledged: bool,
}
#[derive(Clone)]
struct Job {
    scope: Scope,
    state: Arc<Mutex<JobState>>,
}
#[derive(Default)]
struct Saves {
    installed: bool,
    paused: bool,
    draining: bool,
    views: Vec<Registration>,
    jobs: Vec<Job>,
    #[cfg(feature = "test-support")]
    delays: Vec<(
        Scope,
        futures::channel::oneshot::Receiver<()>,
        Arc<std::sync::atomic::AtomicBool>,
    )>,
}
impl Global for Saves {}

/// Public mutation entry points use this too: the curtain alone is not an
/// admission gate for callbacks already queued in the previous frame.
pub fn accepts(cx: &App) -> bool {
    cx.try_global::<Saves>()
        .is_none_or(|s| s.draining || !s.paused)
        && (!dr_shell::release::is_releasing(cx)
            || cx.try_global::<Saves>().is_some_and(|s| s.draining))
}

pub fn register<T: Drafts>(
    lib: &dr_workspace::Workspace,
    window: AnyWindowHandle,
    cx: &mut Context<T>,
) {
    init(cx);
    let scope = Scope::of(lib);
    let weak = cx.weak_entity();
    cx.global_mut::<Saves>().views.push(Registration {
        scope,
        poll: Rc::new(move |cx| {
            if weak.upgrade().is_none() {
                return Drain::Ready;
            }
            window
                .update(cx, |_, window, cx| {
                    weak.update(cx, |view, cx| view.drain(window, cx))
                        .unwrap_or(Drain::Ready)
                })
                .unwrap_or_else(|e| Drain::Failed(e.to_string()))
        }),
    });
}

pub fn init(cx: &mut App) {
    if cx.default_global::<Saves>().installed {
        return;
    }
    cx.global_mut::<Saves>().installed = true;
    dr_shell::release::before_release(cx, |cx| {
        let scope = cx
            .try_global::<dr_shell::Services>()
            .and_then(|s| s.library.as_ref())
            .map(Scope::of);
        cx.global_mut::<Saves>().paused = true;
        cx.global_mut::<Saves>().draining = false;
        let views = cx.global::<Saves>().views.clone();
        let app = cx.to_async();
        Box::pin(async move {
            loop {
                let result = app.update(|cx| {
                    let mut pending = false;
                    let mut error = None;
                    cx.global_mut::<Saves>().draining = true;
                    for view in views.iter().filter(|v| Some(v.scope) == scope) {
                        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            (view.poll)(cx)
                        }))
                        .unwrap_or_else(|_| Drain::Failed("G1 save preparation panicked".into()))
                        {
                            Drain::Ready => {}
                            Drain::Pending => pending = true,
                            Drain::Failed(e) => {
                                error.get_or_insert(e);
                            }
                        }
                    }
                    cx.global_mut::<Saves>().draining = false;
                    let saves = cx.global_mut::<Saves>();
                    saves.jobs.retain(|j| {
                        let state = j.state.lock().unwrap_or_else(|e| e.into_inner());
                        !state.acknowledged && state.result != Some(Ok(()))
                    });
                    for job in saves.jobs.iter().filter(|j| Some(j.scope) == scope) {
                        let state = job.state.lock().unwrap_or_else(|e| e.into_inner());
                        match &state.result {
                            None => pending = true,
                            Some(Err(e)) => {
                                error.get_or_insert_with(|| e.clone());
                            }
                            Some(Ok(())) => {}
                        }
                    }
                    if pending {
                        None
                    } else {
                        Some(error.map_or(Ok(()), Err))
                    }
                });
                if let Some(result) = result {
                    return result;
                }
                app.background_executor()
                    .timer(Duration::from_millis(5))
                    .await;
            }
        })
    });
    dr_shell::release::after_release(cx, |cx| {
        cx.global_mut::<Saves>().paused = false;
        cx.global_mut::<Saves>().draining = false;
    });
}

struct Completion(Arc<Mutex<JobState>>);
impl Drop for Completion {
    fn drop(&mut self) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.result.is_none() {
            state.result = Some(Err("accepted G1 save did not complete".into()));
        }
    }
}

pub struct Ticket(Arc<Mutex<JobState>>);
impl Ticket {
    /// A failed view keeps its draft/error; only an actual foreground result
    /// delivery may clear the independent accepted-job record.
    pub fn acknowledge(self) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .acknowledged = true;
    }
}

pub fn write<T: 'static, R: Send + 'static, E: ToString + Send + 'static>(
    lib: &dr_workspace::Workspace,
    cx: &mut Context<T>,
    future: impl Future<Output = Result<R, E>> + Send + 'static,
) -> (Task<Result<R, String>>, Ticket) {
    init(cx);
    let state = Arc::new(Mutex::new(JobState {
        result: None,
        acknowledged: false,
    }));
    cx.global_mut::<Saves>().jobs.retain(|j| {
        !j.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .acknowledged
    });
    cx.global_mut::<Saves>().jobs.push(Job {
        scope: Scope::of(lib),
        state: state.clone(),
    });
    let completion = Completion(state.clone());
    #[cfg(feature = "test-support")]
    let delay = {
        let saves = cx.global_mut::<Saves>();
        saves
            .delays
            .iter()
            .position(|d| d.0 == Scope::of(lib))
            .map(|i| saves.delays.remove(i))
    };
    let task = cx.background_spawn(async move {
        #[cfg(feature = "test-support")]
        if let Some((_, wait, entered)) = delay {
            entered.store(true, std::sync::atomic::Ordering::SeqCst);
            let _ = wait.await;
        }
        let completion = completion;
        let result = std::panic::AssertUnwindSafe(future)
            .catch_unwind()
            .await
            .map_err(|_| "accepted G1 save panicked".to_owned())
            .and_then(|result| result.map_err(|e| e.to_string()));
        completion
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .result = Some(result.as_ref().map(|_| ()).map_err(ToString::to_string));
        result
    });
    (task, Ticket(state))
}

/// A single field is still a read/modify/write when a draft can outlive its
/// displayed value. Compare that original value before taking the new CAS.
pub fn field(
    lib: &dr_workspace::Workspace,
    target: dr_workspace::commands::v3::module::In,
    field: String,
    base: dr_workspace::commands::v3::types::FieldValue,
    value: dr_workspace::commands::v3::types::FieldValue,
    retry: bool,
) -> Result<(), dr_workspace::WsError> {
    use dr_workspace::{Actor, WritePreconditions, WsError};
    use serde_json::{Value, json};
    let observation = lib.observe(&format!("book:{}", target.book))?;
    let entry =
        dr_model::id::EntryId::parse(&target.entry).map_err(|e| WsError::Invalid(e.to_string()))?;
    let raw = dr_editor::v3::read(lib, &target.book, move |view| {
        view.entry_owned_raw_state(&entry)
    })?
    .ok_or_else(|| WsError::Conflict("field owner was removed".into()))?;
    fn map(value: Option<&Value>) -> Result<Option<&serde_json::Map<String, Value>>, WsError> {
        value
            .map(|v| {
                v.get("map").and_then(Value::as_object).ok_or_else(|| {
                    WsError::Conflict("field representation is not editable by this view".into())
                })
            })
            .transpose()
    }
    let fields = map(raw["metadata"]["map"].get("fields"))?;
    let module = map(fields.and_then(|f| f.get(&target.module)))?;
    let current = match module.and_then(|m| m.get(&field)) {
        None => Value::Null,
        Some(v) => v
            .as_object()
            .filter(|v| v.len() == 1)
            .and_then(|v| v.get("value"))
            .cloned()
            .ok_or_else(|| WsError::Conflict("field representation changed".into()))?,
    };
    let edited = serde_json::to_value(value).map_err(|e| WsError::Internal(e.to_string()))?;
    if !retry
        && current != serde_json::to_value(base).map_err(|e| WsError::Internal(e.to_string()))?
        && current != edited
    {
        return Err(WsError::Conflict("field changed while editing".into()));
    }
    lib.call_guarded(
        &Actor::User,
        "module.set_field",
        json!({"book":target.book,"entry":target.entry,"module":target.module,"field":field,"value":edited}),
        WritePreconditions::from_observations([observation]),
    )?;
    Ok(())
}

/// Delay a real accepted write before storage starts. A deterministic GPUI
/// test dispatcher polls background futures on its own thread, so a blocking
/// storage barrier there would also block the test's foreground executor.
#[cfg(feature = "test-support")]
#[doc(hidden)]
pub fn delay_next(
    lib: &dr_workspace::Workspace,
    cx: &mut App,
) -> (
    futures::channel::oneshot::Sender<()>,
    Arc<std::sync::atomic::AtomicBool>,
) {
    init(cx);
    let (send, wait) = futures::channel::oneshot::channel();
    let entered = Arc::new(std::sync::atomic::AtomicBool::new(false));
    cx.global_mut::<Saves>()
        .delays
        .push((Scope::of(lib), wait, entered.clone()));
    (send, entered)
}
