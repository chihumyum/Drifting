//! The shell owns one hub. Panels only borrow its controller; closing a panel
//! does not abandon runs, and releasing a library waits for initialization too.

use std::sync::Arc;

use dr_agent::{Driver, ToolExecutor};
use dr_shell::Services;
use futures::{
    FutureExt as _,
    channel::oneshot,
    future::{BoxFuture, Shared},
};
use gpui::{App, Context, Entity, Task};

use crate::controller::AgentController;

type Opening = Shared<BoxFuture<'static, Result<AgentController, String>>>;

pub struct AgentHub {
    pub controller: Option<AgentController>,
    pub error: Option<String>,
    driver: Arc<dyn Driver>,
    tools: Arc<dyn ToolExecutor>,
    opening: Option<Opening>,
    task: Option<Task<()>>,
    generation: u64,
}

impl AgentHub {
    pub fn new(driver: Arc<dyn Driver>, tools: Arc<dyn ToolExecutor>) -> Self {
        Self {
            controller: None,
            error: None,
            driver,
            tools,
            opening: None,
            task: None,
            generation: 0,
        }
    }

    pub fn attach(&mut self, cx: &mut Context<Self>) {
        if dr_shell::release::is_releasing(cx)
            || self.controller.is_some()
            || self.opening.is_some()
        {
            return;
        }
        let Some(workspace) = cx.try_global::<Services>().and_then(|s| s.library.clone()) else {
            return;
        };
        self.generation += 1;
        let generation = self.generation;
        let driver = self.driver.clone();
        let tools = self.tools.clone();
        let (send, receive) = oneshot::channel();
        if let Err(error) = std::thread::Builder::new()
            .name("agent-open".into())
            .spawn(move || {
                let result = AgentController::new(workspace, driver, tools);
                let _ = send.send(result);
            })
        {
            self.error = Some(error.to_string());
            cx.notify();
            return;
        }
        let opening = async move {
            receive
                .await
                .map_err(|_| "Agent initialization ended".to_owned())?
        }
        .boxed()
        .shared();
        self.opening = Some(opening.clone());
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = opening.await;
            let _ = this.update(cx, |hub, cx| {
                if hub.generation != generation {
                    return;
                }
                hub.opening = None;
                hub.task = None;
                match result {
                    Ok(controller) => {
                        hub.controller = Some(controller);
                        hub.error = None;
                    }
                    Err(error) => hub.error = Some(error),
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    /// The call itself freezes starts. The returned future settles all runs
    /// and drops every runtime/library reference before F3 is asked to close.
    pub fn prepare_close(
        &mut self,
        cx: &mut Context<Self>,
    ) -> BoxFuture<'static, Result<(), String>> {
        self.generation += 1;
        self.task = None;
        let closing = self.controller.take().map(|controller| controller.close());
        let opening = self.opening.take();
        self.error = None;
        cx.notify();
        async move {
            let mut failure = None;
            if let Some(closing) = closing
                && let Err(error) = closing.await
            {
                failure = Some(error);
            }
            if let Some(opening) = opening {
                // A failed initialization has no runs to settle. A completed
                // initialization must close even if its view never saw it.
                if let Ok(controller) = opening.await
                    && let Err(error) = controller.close().await
                {
                    failure = Some(error);
                }
            }
            failure.map_or(Ok(()), Err)
        }
        .boxed()
    }
}

pub fn install(hub: &Entity<AgentHub>, cx: &mut App) {
    let weak = hub.downgrade();
    dr_shell::release::before_release(cx, move |cx| {
        weak.upgrade()
            .map(|hub| {
                hub.update(cx, |hub, cx| hub.prepare_close(cx))
                    .boxed_local()
            })
            .unwrap_or_else(|| async { Ok(()) }.boxed_local())
    });
    let weak = hub.downgrade();
    dr_shell::release::after_release(cx, move |cx| {
        if let Some(hub) = weak.upgrade() {
            hub.update(cx, |hub, cx| hub.attach(cx));
        }
    });
    hub.update(cx, |hub, cx| hub.attach(cx));
}
