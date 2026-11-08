//! The app owns its local MCP endpoint. Each library owns one plugin manager,
//! and every external author call borrows the same Agent controller as chat.

use std::sync::Arc;

use dr_mcp::{
    GrantPaths, GrantStore, PluginSlot, Result,
    host::{Host, ScopeOpener},
    inbound::Server,
    outbound::Manager,
    transport::Listener,
};
use dr_model::id::BookId;
use dr_platform::{AppDirs, Identity, secrets::SecretStore};
use dr_shell::{Services, Workspace};
use futures::{
    FutureExt as _,
    channel::oneshot,
    future::{BoxFuture, Shared},
};
use gpui::{App, AppContext as _, Context, Entity, Global, Task, WeakEntity, WindowId};

use crate::AgentViews;

#[derive(Clone)]
struct Network {
    grants: GrantStore,
    server: Arc<Server>,
    warnings: Vec<String>,
}
type Opening = Shared<BoxFuture<'static, Result<Network>>>;

pub struct McpGlobal {
    pub service: Entity<McpService>,
    pub slot: PluginSlot,
}
impl Global for McpGlobal {}

pub struct McpService {
    reactor: Option<tokio::runtime::Runtime>,
    host: Option<Host>,
    opening: Option<Opening>,
    network: Option<Network>,
    manager: Option<Manager>,
    slot: PluginSlot,
    secrets: Arc<SecretStore>,
    selected: Option<BookId>,
    active: Option<(WindowId, WeakEntity<Workspace>)>,
    attached: bool,
    releasing: bool,
    generation: u64,
    error: Option<String>,
    plugin_error: Option<String>,
    activation_serial: u64,
    activation_task: Option<Task<()>>,
    opening_task: Option<Task<()>>,
    watch_task: Option<Task<()>>,
}

impl McpService {
    pub fn grants(&self) -> Option<GrantStore> {
        self.network.as_ref().map(|n| n.grants.clone())
    }
    pub fn manager(&self) -> Option<Manager> {
        self.manager.clone()
    }
    pub fn book(&self) -> Option<String> {
        self.selected.as_ref().map(ToString::to_string)
    }
    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }
    /// Loading the selected book's extensions is independent of the inbound
    /// endpoint and its client-configuration repair warnings.
    pub fn plugin_error(&self) -> Option<&str> {
        self.plugin_error.as_deref()
    }
    pub fn is_busy(&self) -> bool {
        self.releasing || self.opening.is_some()
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn host(&self) -> Option<Host> {
        self.host.clone()
    }

    fn new(
        paths: Result<GrantPaths>,
        secrets: Arc<SecretStore>,
        slot: PluginSlot,
        cx: &mut Context<Self>,
    ) -> Self {
        let reactor = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("dr-mcp")
            .enable_all()
            .build();
        let mut service = Self {
            reactor: None,
            host: None,
            opening: None,
            network: None,
            manager: None,
            slot,
            secrets,
            selected: None,
            active: None,
            attached: false,
            releasing: false,
            generation: 0,
            error: None,
            plugin_error: None,
            activation_serial: 0,
            activation_task: None,
            opening_task: None,
            watch_task: None,
        };
        match reactor {
            Ok(reactor) => {
                let handle = reactor.handle().clone();
                let host = Host::new(handle.clone());
                service.host = Some(host.clone());
                service.reactor = Some(reactor);
                let (send, receive) = oneshot::channel();
                handle.spawn(async move {
                    let result = async {
                        let paths = paths?;
                        let listener = Listener::bind(&paths).await?;
                        let endpoint = listener.endpoint()?;
                        let grants =
                            tokio::task::spawn_blocking(move || GrantStore::open(paths, endpoint))
                                .await
                                .map_err(|_| {
                                    "MCP authorization initialization ended".to_owned()
                                })??;
                        // Refresh only entries still owned by this installation.
                        // Missing client entries stay missing; no home is rewritten
                        // merely because somebody removed their configuration.
                        let report = grants.repair_owned(true).await?;
                        let server = Server::start(
                            listener,
                            grants.clone(),
                            host,
                            &tokio::runtime::Handle::current(),
                        );
                        Ok(Network {
                            grants,
                            server: Arc::new(server),
                            warnings: report
                                .warnings
                                .into_iter()
                                .map(|warning| warning.message)
                                .collect(),
                        })
                    }
                    .await;
                    let _ = send.send(result);
                });
                let opening = async move {
                    receive
                        .await
                        .map_err(|_| "MCP initialization worker ended".to_owned())?
                }
                .boxed()
                .shared();
                service.opening = Some(opening.clone());
                service.opening_task = Some(cx.spawn(async move |this, cx| {
                    let result = opening.await;
                    let _ = this.update(cx, |service, cx| {
                        service.opening = None;
                        service.opening_task = None;
                        match result {
                            Ok(network) => {
                                if !network.warnings.is_empty() {
                                    service.error = Some(network.warnings.join("\n"));
                                }
                                service.network = Some(network);
                            }
                            Err(error) => service.error = Some(error),
                        }
                        cx.notify();
                    });
                }));
            }
            Err(error) => service.error = Some(error.to_string()),
        }
        service
    }

    fn attach(&mut self, cx: &mut Context<Self>) {
        if self.releasing || dr_shell::release::is_releasing(cx) || self.attached {
            return;
        }
        let Some(controller) = cx
            .try_global::<AgentViews>()
            .and_then(|views| views.hub.read(cx).controller.clone())
            .filter(|c| !c.is_closed())
        else {
            return;
        };
        let Some(library) = cx
            .try_global::<Services>()
            .and_then(|services| services.library.as_ref())
            .map(|ws| ws.library().clone())
        else {
            return;
        };
        let (Some(reactor), Some(host)) = (&self.reactor, &self.host) else {
            return;
        };
        let handle = reactor.handle().clone();
        let opener: ScopeOpener = Arc::new(move |start| {
            let controller = controller.clone();
            let worker = handle.spawn_blocking(move || controller.open_external(start));
            async move {
                worker
                    .await
                    .map_err(|_| "MCP controller opening ended".to_owned())?
            }
            .boxed()
        });
        let manager = Manager::new(library, self.secrets.clone(), reactor.handle().clone());
        let mut changes = manager.watch();
        self.watch_task = Some(cx.spawn(async move |this, cx| {
            while changes.changed().await.is_ok() {
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        }));
        self.slot.replace(Some(manager.clone()));
        self.manager = Some(manager);
        self.attached = true;
        self.generation += 1;
        host.replace(self.selected.clone(), Some(opener));
        self.activate_plugins(cx);
        cx.notify();
    }

    fn activate_plugins(&mut self, cx: &mut Context<Self>) {
        let Some(manager) = &self.manager else {
            self.activation_task = None;
            self.plugin_error = None;
            return;
        };
        // activate synchronously registers its independent worker. This task
        // owns only the ACK; dropping it never abandons Manager's I/O/drain.
        let activated = manager.activate(self.book());
        self.await_activation(activated, cx);
    }

    fn await_activation(
        &mut self,
        activated: BoxFuture<'static, Result<()>>,
        cx: &mut Context<Self>,
    ) {
        self.activation_task = None;
        self.activation_serial += 1;
        self.plugin_error = None;
        let serial = self.activation_serial;
        let generation = self.generation;
        let book = self.book();
        self.activation_task = Some(cx.spawn(async move |this, cx| {
            let result = activated.await;
            let _ = this.update(cx, |service, cx| {
                // The serial also fences A -> B -> A within one library.
                if service.releasing
                    || service.generation != generation
                    || service.book() != book
                    || service.activation_serial != serial
                {
                    return;
                }
                service.activation_task = None;
                service.plugin_error = result.err();
                cx.notify();
            });
        }));
    }

    fn select(&mut self, book: Option<BookId>, cx: &mut Context<Self>) {
        if self.selected == book {
            return;
        }
        self.selected = book;
        if let Some(host) = &self.host {
            host.select(self.selected.clone());
        }
        self.activate_plugins(cx);
        cx.notify();
    }

    fn focus(
        &mut self,
        id: WindowId,
        workspace: WeakEntity<Workspace>,
        book: Option<BookId>,
        cx: &mut Context<Self>,
    ) {
        self.active = Some((id, workspace));
        if !self.releasing {
            self.select(book, cx);
        }
    }

    /// Freeze admission before returning, but perform no I/O on GPUI's thread.
    pub fn prepare_close(&mut self, cx: &mut Context<Self>) -> BoxFuture<'static, Result<()>> {
        self.releasing = true;
        self.generation += 1;
        self.attached = false;
        self.selected = None;
        if let Some(host) = &self.host {
            host.suspend();
        }
        self.slot.replace(None);
        let closing = self.manager.take().map(|manager| manager.begin_close());
        self.activation_task = None;
        self.plugin_error = None;
        self.watch_task = None;
        let opening = self.opening.clone();
        let network = self.network.clone();
        cx.notify();
        async move {
            // Every participant is awaited even if another one fails.
            let plugins = async {
                match closing {
                    Some(closing) => closing.await,
                    None => Ok(()),
                }
            };
            let grants = async {
                let network = match (network, opening) {
                    (Some(network), _) => Some(network),
                    (_, Some(opening)) => opening.await.ok(),
                    _ => None,
                };
                if let Some(network) = network {
                    network.grants.drain().await
                } else {
                    Ok(())
                }
            };
            let (plugins, grants) = futures::join!(plugins, grants);
            plugins.and(grants)
        }
        .boxed()
    }

    fn resume(&mut self, cx: &mut Context<Self>) {
        self.releasing = false;
        let selected = self
            .active
            .as_ref()
            .and_then(|(_, workspace)| workspace.upgrade())
            .and_then(|workspace| selected_book(workspace.read(cx)));
        self.select(selected, cx);
        self.attach(cx);
        cx.notify();
    }

    fn close_network(&self) -> BoxFuture<'static, ()> {
        let opening = self.opening.clone();
        let network = self.network.clone();
        async move {
            let network = match (network, opening) {
                (Some(network), _) => Some(network),
                (_, Some(opening)) => opening.await.ok(),
                _ => None,
            };
            if let Some(network) = network {
                let _ = network.server.close().await;
            }
        }
        .boxed()
    }
}

impl Drop for McpService {
    fn drop(&mut self) {
        if let Some(host) = &self.host {
            host.suspend();
        }
        self.slot.replace(None);
        self.activation_task = None;
        if let Some(manager) = self.manager.take() {
            drop(manager.begin_close());
        }
        if let Some(reactor) = self.reactor.take() {
            reactor.shutdown_background();
        }
    }
}

fn selected_book(workspace: &Workspace) -> Option<BookId> {
    (!workspace.shelf_open && workspace.library.is_some() && workspace.book.id == workspace.book_id)
        .then(|| BookId::parse(&workspace.book_id).ok())
        .flatten()
}

pub fn init(identity: &Identity, dirs: Option<&AppDirs>, cx: &mut App) {
    let paths = dirs
        .ok_or_else(|| "MCP requires the application's data directory".to_owned())
        .and_then(|dirs| {
            std::env::current_exe()
                .map_err(|error| error.to_string())
                .and_then(|executable| GrantPaths::for_app(dirs.data.clone(), executable))
        });
    init_with(paths, Arc::new(SecretStore::for_identity(identity)), cx);
}

/// Synthetic acceptance supplies isolated paths and a memory secret backend.
pub fn init_with(paths: Result<GrantPaths>, secrets: Arc<SecretStore>, cx: &mut App) {
    let slot = PluginSlot::default();
    let service = cx.new(|cx| McpService::new(paths, secrets, slot.clone(), cx));
    cx.set_global(McpGlobal {
        service: service.clone(),
        slot,
    });
    crate::mcp_settings::init(service.clone(), cx);
    let weak = service.downgrade();
    dr_shell::release::before_release(cx, move |cx| {
        weak.upgrade()
            .map(|service| {
                service
                    .update(cx, |service, cx| service.prepare_close(cx))
                    .boxed_local()
            })
            .unwrap_or_else(|| async { Ok(()) }.boxed_local())
    });
    let weak = service.downgrade();
    dr_shell::release::after_release(cx, move |cx| {
        if let Some(service) = weak.upgrade() {
            service.update(cx, |service, cx| service.resume(cx));
        }
    });
    let weak = service.downgrade();
    cx.on_app_quit(move |cx| {
        weak.upgrade()
            .map(|service| service.read(cx).close_network())
            .unwrap_or_else(|| async {}.boxed())
    })
    .detach();

    let weak = service.downgrade();
    cx.observe_new::<Workspace>(move |workspace, window, cx| {
        let Some(service) = weak.upgrade() else {
            return;
        };
        let Some(window) = window else {
            return;
        };
        let id = window.window_handle().window_id();
        let entity = cx.entity();
        if window.is_window_active() || service.read(cx).active.is_none() {
            service.update(cx, |service, cx| {
                service.focus(id, entity.downgrade(), selected_book(workspace), cx)
            });
        }
        let observed = entity.clone();
        service.update(cx, |_, cx| {
            cx.observe(&observed, move |service, workspace, cx| {
                if service
                    .active
                    .as_ref()
                    .is_some_and(|(active, _)| *active == id)
                    && !service.releasing
                {
                    service.select(selected_book(workspace.read(cx)), cx);
                }
            })
            .detach();
        });
        let weak = weak.clone();
        cx.observe_window_activation(window, move |workspace, window, cx| {
            // Losing foreground focus to Codex does not lose the selected book.
            if window.is_window_active()
                && let Some(service) = weak.upgrade()
            {
                let entity = cx.weak_entity();
                service.update(cx, |service, cx| {
                    service.focus(id, entity, selected_book(workspace), cx)
                });
            }
        })
        .detach();
    })
    .detach();
    let weak = service.downgrade();
    cx.on_window_closed(move |cx, closed| {
        if let Some(service) = weak.upgrade() {
            service.update(cx, |service, cx| {
                if service.active.as_ref().is_some_and(|(id, _)| *id == closed) {
                    service.active = None;
                    service.select(None, cx);
                }
            });
        }
    })
    .detach();
}

/// Agent initialization explicitly supplies the hub after publishing it.
/// `App::defer` can run before the next module initializer in the native
/// application's startup callback, so it cannot establish this dependency.
pub(crate) fn attach_agent(hub: &Entity<crate::AgentHub>, cx: &mut App) {
    let Some(service) = cx
        .try_global::<McpGlobal>()
        .map(|global| global.service.clone())
    else {
        return;
    };
    service.update(cx, |service, cx| {
        cx.observe(hub, |service, _, cx| service.attach(cx))
            .detach();
        service.attach(cx);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    fn activation_ack_is_fenced_across_books_revisits_and_release(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let service = cx.new(|cx| {
            McpService::new(
                Err("Synthetic inbound warning".into()),
                Arc::new(SecretStore::in_memory()),
                PluginSlot::default(),
                cx,
            )
        });
        let a = BookId::new_v7();
        let b = BookId::new_v7();
        let (old_send, old_receive) = oneshot::channel();
        let old_task = service.update(cx, |service, cx| {
            service.selected = Some(a.clone());
            service.await_activation(async { old_receive.await.unwrap() }.boxed(), cx);
            // Keep a superseded completion alive to exercise the fence even
            // when delivery was already queued before replacement cancelled it.
            service.activation_task.take().unwrap()
        });
        let (current_send, current_receive) = oneshot::channel();
        service.update(cx, |service, cx| {
            service.selected = Some(b);
            service.await_activation(async { current_receive.await.unwrap() }.boxed(), cx);
        });
        old_send.send(Err("old book load failure".into())).unwrap();
        cx.run_until_parked();
        assert!(service.read_with(cx, |service, _| service.plugin_error().is_none()));
        assert!(service.read_with(cx, |service, _| service.activation_task.is_some()));
        current_send
            .send(Err("current book load failure".into()))
            .unwrap();
        cx.run_until_parked();
        assert_eq!(
            service.read_with(cx, |service, _| service.plugin_error().map(str::to_owned)),
            Some("current book load failure".into())
        );
        drop(old_task);

        let (first_send, first_receive) = oneshot::channel();
        let first_task = service.update(cx, |service, cx| {
            service.selected = Some(a.clone());
            service.await_activation(async { first_receive.await.unwrap() }.boxed(), cx);
            service.activation_task.take().unwrap()
        });
        let (last_send, last_receive) = oneshot::channel();
        let last_task = service.update(cx, |service, cx| {
            // Same book and library: a previous visit must not replace the
            // latest activation's result merely because its identity matches.
            service.await_activation(async { last_receive.await.unwrap() }.boxed(), cx);
            service.activation_task.take().unwrap()
        });
        first_send
            .send(Err("earlier visit failure".into()))
            .unwrap();
        cx.run_until_parked();
        assert!(service.read_with(cx, |service, _| service.plugin_error().is_none()));
        let closing = service.update(cx, |service, cx| service.prepare_close(cx));
        last_send
            .send(Err("released library failure".into()))
            .unwrap();
        cx.run_until_parked();
        futures::executor::block_on(closing).unwrap();
        assert!(service.read_with(cx, |service, _| service.plugin_error().is_none()));
        drop((first_task, last_task));
    }
}
