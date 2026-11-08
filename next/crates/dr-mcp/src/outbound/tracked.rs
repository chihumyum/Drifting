use futures::{
    FutureExt,
    channel::oneshot,
    future::{BoxFuture, Shared},
};
use rmcp::{
    RoleClient,
    service::{RxJsonRpcMessage, TxJsonRpcMessage},
    transport::Transport,
};
use std::{io, sync::Arc};
use tokio::runtime::Handle;

pub(super) struct Closed(Shared<BoxFuture<'static, crate::Result<()>>>);
impl Closed {
    pub(super) async fn wait(&self) -> crate::Result<()> {
        self.0.clone().await
    }

    #[cfg(test)]
    pub(super) fn injected(completion: BoxFuture<'static, crate::Result<()>>) -> Self {
        Self(completion.shared())
    }
}

/// The SDK worker transport's Drop cancels but does not await its JoinHandle.
/// Move close into an owned worker so failed/cancelled initialization also
/// waits for HTTP/session/process cleanup before releasing its library lease.
pub(super) struct Tracked<T: Transport<RoleClient> + 'static> {
    inner: Option<T>,
    reply: Option<oneshot::Sender<crate::Result<()>>>,
    closed: Arc<Closed>,
    runtime: Handle,
}

impl<T: Transport<RoleClient> + 'static> Tracked<T> {
    pub(super) fn new(inner: T, runtime: Handle) -> (Self, Arc<Closed>) {
        let (reply, receive) = oneshot::channel();
        let closed = Arc::new(Closed(
            async {
                receive
                    .await
                    .unwrap_or_else(|_| Err("MCP transport cleanup ended early".into()))
            }
            .boxed()
            .shared(),
        ));
        (
            Self {
                inner: Some(inner),
                reply: Some(reply),
                closed: closed.clone(),
                runtime,
            },
            closed,
        )
    }
    fn start(&mut self) {
        if let Some(mut inner) = self.inner.take() {
            let reply = self.reply.take();
            self.runtime.spawn(async move {
                let result = inner
                    .close()
                    .await
                    .map_err(|_| "MCP transport cleanup failed".to_owned());
                drop(inner);
                if let Some(reply) = reply {
                    let _ = reply.send(result);
                }
            });
        }
    }
}
impl<T: Transport<RoleClient> + 'static> Drop for Tracked<T> {
    fn drop(&mut self) {
        self.start();
    }
}
impl<T: Transport<RoleClient> + 'static> Transport<RoleClient> for Tracked<T> {
    type Error = io::Error;
    fn send(
        &mut self,
        message: TxJsonRpcMessage<RoleClient>,
    ) -> impl std::future::Future<Output = io::Result<()>> + Send + 'static {
        let future = self
            .inner
            .as_mut()
            .expect("open MCP transport")
            .send(message);
        async move {
            future
                .await
                .map_err(|_| io::Error::other("MCP transport send failed"))
        }
    }
    async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleClient>> {
        self.inner.as_mut()?.receive().await
    }
    async fn close(&mut self) -> io::Result<()> {
        self.start();
        self.closed.wait().await.map_err(io::Error::other)
    }
}
