//! The app owns its local MCP endpoint. Each library owns one plugin manager,
//! and every external author call borrows the same Agent controller as chat.
//! The endpoint lists the open book's catalog from the companion's own book
//! tools, read under that controller's lease.
//!
//! Under the release identity it also serves the 0.1 client's other
//! libraries' MCP folders (`dr_mcp::v1`): each one's connections reach the
//! open book only while the open library is that 0.1 library's owner's.

use std::path::PathBuf;
use std::sync::Arc;

use dr_agent_tools::AgentTools;
use dr_mcp::{
    GrantPaths, GrantStore, PluginSlot, Result,
    host::{Backend, CatalogSource, Host, ScopeOpener},
    inbound::{self, Network},
    outbound::Manager,
    v1::{self, Connections, OwnerOf},
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

type Opening = Shared<BoxFuture<'static, Result<Network>>>;

/// Where the 0.1 client keeps its libraries on this device, and who owns
/// the library at a root (this app's registry): what serving the 0.1
/// libraries' own MCP folders needs ([`init`]).
pub struct V1 {
    pub data: PathBuf,
    pub owner_of: OwnerOf,
}

pub struct McpGlobal {
    pub service: Entity<McpService>,
    pub slot: PluginSlot,
    /// The companion's book tools (see `CompanionTools::shared`).
    pub tools: AgentTools,
}
impl Global for McpGlobal {}

pub struct McpService {
    reactor: Option<tokio::runtime::Runtime>,
    host: Option<Host>,
    opening: Option<Opening>,
    network: Option<Network>,
    manager: Option<Manager>,
    slot: PluginSlot,
    tools: AgentTools,
    /// The attached library's book edits, so the Host can announce a change
    /// to the open book's catalog. Dropped before the library is released.
    follow: Option<dr_workspace::Subscription>,
    /// The 0.1 libraries' own MCP folders, who owns the open library, and
    /// the folders' book-edit subscriptions (dropped with `follow`).
    v1: Connections,
    owner_of: Option<OwnerOf>,
    v1_follow: Vec<dr_workspace::Subscription>,
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
    /// The 0.1 libraries' own MCP folders this service serves.
    pub fn v1(&self) -> &Connections {
        &self.v1
    }

    fn new(
        paths: Result<GrantPaths>,
        v1: Option<(Vec<v1::Folder>, OwnerOf)>,
        secrets: Arc<SecretStore>,
        slot: PluginSlot,
        tools: AgentTools,
        cx: &mut Context<Self>,
    ) -> Self {
        let reactor = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("dr-mcp")
            .enable_all()
            .build();
        let (folders, owner_of) = v1.unzip();
        let mut service = Self {
            reactor: None,
            host: None,
            opening: None,
            network: None,
            manager: None,
            slot,
            tools,
            follow: None,
            v1: Connections::default(),
            owner_of,
            v1_follow: Vec::new(),
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
                let v1 = match (&paths, folders) {
                    (Ok(paths), Some(folders)) => Some((folders, paths.clone())),
                    _ => None,
                };
                let (send, receive) = oneshot::channel();
                handle.spawn(async move {
                    let result = match paths {
                        Ok(paths) => inbound::serve(paths, host).await,
                        Err(error) => Err(error),
                    };
                    let _ = send.send(result);
                });
                let opening = async move {
                    receive
                        .await
                        .map_err(|_| "MCP initialization worker ended".to_owned())?
                }
                .boxed()
                .shared();
                // The 0.1 folders start after this app's own folder: each
                // start repairs the same client configurations.
                if let Some((folders, paths)) = v1 {
                    let after = opening.clone().map(drop).boxed();
                    service.v1 = Connections::serve(folders, &paths, &handle, after);
                }
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
        let (Some(reactor), Some(host)) = (&self.reactor, &self.host) else {
            return;
        };
        let Some((library, follow, v1_follow)) = cx
            .try_global::<Services>()
            .and_then(|services| services.library.as_ref())
            .map(|ws| (ws.library().clone(), host.follow(ws), self.v1.follow(ws)))
        else {
            return;
        };
        // The 0.1 folders whose owner owns this library get its backend too.
        let owner = self
            .owner_of
            .as_ref()
            .and_then(|owner_of| owner_of(&library.paths().root));
        let handle = reactor.handle().clone();
        // The companion's book tools under the controller's read lease: the
        // same catalog and cache chat uses, and a release waits for the read.
        let catalog: CatalogSource = {
            let (controller, tools, handle) =
                (controller.clone(), self.tools.clone(), handle.clone());
            Arc::new(move |book| {
                let (controller, tools) = (controller.clone(), tools.clone());
                let worker = handle.spawn_blocking(move || {
                    controller.with_workspace_read(|workspace| {
                        tools
                            .catalog_for_book(workspace, &book)
                            .map_err(|error| error.to_string())
                    })
                });
                async move {
                    worker
                        .await
                        .map_err(|_| "MCP catalog read ended".to_owned())?
                }
                .boxed()
            })
        };
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
        let backend = Backend { opener, catalog };
        host.replace(self.selected.clone(), Some(backend.clone()));
        self.v1
            .attach(owner.as_ref(), self.selected.clone(), Some(backend));
        self.follow = Some(follow);
        self.v1_follow = v1_follow;
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
        self.v1.select(self.selected.clone());
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
        self.v1.suspend();
        self.follow = None;
        self.v1_follow.clear();
        self.slot.replace(None);
        let closing = self.manager.take().map(|manager| manager.begin_close());
        self.activation_task = None;
        self.plugin_error = None;
        self.watch_task = None;
        let opening = self.opening.clone();
        let network = self.network.clone();
        let v1 = self.v1.drain();
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
            let (plugins, grants, v1) = futures::join!(plugins, grants, v1);
            plugins.and(grants).and(v1)
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
        let v1 = self.v1.close();
        async move {
            let network = match (network, opening) {
                (Some(network), _) => Some(network),
                (_, Some(opening)) => opening.await.ok(),
                _ => None,
            };
            let own = async {
                if let Some(network) = network {
                    let _ = network.server.close().await;
                }
            };
            futures::join!(own, v1);
        }
        .boxed()
    }
}

impl Drop for McpService {
    fn drop(&mut self) {
        if let Some(host) = &self.host {
            host.suspend();
        }
        self.v1.suspend();
        self.follow = None;
        self.v1_follow.clear();
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

/// `v1`: the 0.1 client's data folder on this device (the release
/// identity's `dirs.data`, or a synthetic one a development run names), whose
/// other libraries' MCP folders are served too; `None` serves only this app's
/// own folder.
pub fn init(identity: &Identity, dirs: Option<&AppDirs>, v1: Option<V1>, cx: &mut App) {
    let paths = dirs
        .ok_or_else(|| "MCP requires the application's data directory".to_owned())
        .and_then(|dirs| {
            std::env::current_exe()
                .map_err(|error| error.to_string())
                .and_then(|executable| GrantPaths::for_app(dirs.data.clone(), executable))
        });
    init_with(paths, v1, Arc::new(SecretStore::for_identity(identity)), cx);
}

/// Synthetic acceptance supplies isolated paths and a memory secret backend.
/// The 0.1 folders are found here, before anything is served: one small
/// registry read.
pub fn init_with(
    paths: Result<GrantPaths>,
    v1: Option<V1>,
    secrets: Arc<SecretStore>,
    cx: &mut App,
) {
    let v1 = match (&paths, v1) {
        (Ok(paths), Some(V1 { data, owner_of })) => {
            Some((v1::folders(&data, &paths.directory), owner_of))
        }
        _ => None,
    };
    let slot = PluginSlot::default();
    let tools = AgentTools::new();
    let service = cx.new(|cx| McpService::new(paths, v1, secrets, slot.clone(), tools.clone(), cx));
    cx.set_global(McpGlobal {
        service: service.clone(),
        slot,
        tools,
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
                None,
                Arc::new(SecretStore::in_memory()),
                PluginSlot::default(),
                AgentTools::new(),
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
