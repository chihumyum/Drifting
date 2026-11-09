//! M34: author-operated dictation, independent of Agent model/tools.
pub mod audio;
pub mod client;
pub mod context;
mod view;
use client::Client;
use dr_agent_providers::HttpClient;
use dr_platform::secrets::SecretStore;
use futures::{FutureExt as _, future::join_all};
use gpui::{App, Global};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;
pub use view::Dictation;

/// App-owned barriers outlive a closed or cached companion view. A release
/// cancels network/capture but still waits for accepted credential operations.
type PendingJobs = Vec<(CancellationToken, audio::Completion)>;
#[derive(Clone, Default)]
pub(crate) struct Jobs(Arc<Mutex<PendingJobs>>);
impl Jobs {
    fn track(&self, cancel: CancellationToken, done: audio::Completion) {
        let mut jobs = self.0.lock().expect("speech jobs");
        jobs.retain(|(_, done)| done.clone().now_or_never().is_none());
        jobs.push((cancel, done));
    }
    fn drain(&self) -> impl Future<Output = ()> + Send + 'static {
        let jobs = std::mem::take(&mut *self.0.lock().expect("speech jobs"));
        for (cancel, _) in &jobs {
            cancel.cancel();
        }
        async move {
            join_all(jobs.into_iter().map(|(_, done)| done)).await;
        }
    }
}
#[derive(Clone)]
pub struct Services {
    pub client: Client,
    pub(crate) jobs: Jobs,
}
impl Global for Services {}
pub fn init(http: HttpClient, secrets: Arc<SecretStore>, cx: &mut App) {
    install(Client::new(http, secrets), cx);
}
pub fn install(client: Client, cx: &mut App) {
    let jobs = Jobs::default();
    let release = jobs.clone();
    dr_shell::release::before_release(cx, move |_| {
        let drain = release.drain();
        async move {
            drain.await;
            Ok(())
        }
        .boxed_local()
    });
    cx.set_global(Services { client, jobs });
}

#[cfg(test)]
mod tests;
