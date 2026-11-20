//! The 0.1 client's MCP connections of its libraries other than the one at
//! the root of its data folder.
//!
//! 0.1 served MCP from the running library's root (`src-tauri/src/
//! mcp_server.rs`: `Server::start(root.join("mcp"))`, the root from
//! `data_paths::app_local_root`). Its pre-registry library (`legacy`) keeps
//! the data folder itself, so that library's grants are `<0.1 data>/mcp`,
//! which this client under the release identity serves as its own
//! (`GrantPaths::for_app`). Every other library is `<0.1 data>/libraries/<id>`
//! (`local`, `account-<hex>`) with grants, connection files and, on macOS, a
//! socket of its own: `libraries/<id>/mcp/bridge.sock`, or the user's cache
//! folder's `drifting-mcp/<hash>.sock` when that path is too long, as an
//! account library's always is. The authors' Agent configurations name those
//! connection files (`--mcp --connection <root>/mcp/connection-<id>.json`),
//! and each file names that socket or, on Windows, the port of 0.1's last
//! launch.
//!
//! So each such folder is served as it is: a listener at the endpoint 0.1's
//! rules give it (the same socket path; on Windows a new port, which the
//! start-up repair writes into its connection files), its own grant store
//! and server, and its own [`Host`]. A folder's connections see the open
//! book only while the open library is its owner's: the library the import
//! puts that 0.1 library's books into (M10: an account's 0.1 library into
//! that account's library, a local or never-claimed one into the local
//! library). With any other library open they see no book (the base catalog;
//! calls are refused as with no book open), as 0.1 was not listening for
//! them while another library ran; the app's own grants, by contrast, reach
//! whichever library is open (M32). A credential is only known to its own
//! folder's store, so it opens no other folder's endpoint.
//!
//! Nothing is copied or moved. The writes in these folders are the ones the
//! app's own folder gets: the socket, and the connection files following a
//! new port. Outside them the start-up repair brings the client entries
//! this installation owns to the current executable, as for the app's own
//! folder; the folders start one after another, after the app's own, since
//! they repair the same client files.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use dr_import_v1::locate;
use dr_model::id::BookId;
use dr_workspace::{Subscription, Workspace};
use futures::{
    FutureExt as _,
    channel::oneshot,
    future::{BoxFuture, Shared, join_all},
};
use tokio::runtime::Handle;

use crate::{
    GrantPaths, Result,
    host::{Backend, Host},
    inbound::{self, Network},
};

/// Whose books a 0.1 library's connections reach in this client.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Owner {
    /// The local library: a 0.1 library without an account, or the
    /// pre-registry one that was never claimed.
    Local,
    /// That Hosted account's library, by the account's subject.
    Account(String),
}

impl Owner {
    /// Whether `other` is the same owner, account subjects compared trimmed
    /// as the import compares them.
    pub fn is(&self, other: &Owner) -> bool {
        match (self, other) {
            (Owner::Local, Owner::Local) => true,
            (Owner::Account(a), Owner::Account(b)) => a.trim() == b.trim(),
            _ => false,
        }
    }
}

/// Who owns the library at a root (the app adapter asks for the open one);
/// `None` when that cannot be told, which reaches no 0.1 folder.
pub type OwnerOf = Arc<dyn Fn(&Path) -> Option<Owner> + Send + Sync>;

/// One 0.1 library's MCP folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Folder {
    /// The library's id in 0.1's registry (`local`, `account-<hex>`, …).
    pub library: String,
    pub owner: Owner,
    /// `<the library's root>/mcp`.
    pub directory: PathBuf,
}

/// The MCP folders of the 0.1 libraries under `v1_data` (0.1's
/// `libraries.json`, read-only, by the import's rules) that hold a grant
/// registry, except `served`: the folder this app already serves as its own
/// (under the release identity the pre-registry library's `<0.1 data>/mcp`;
/// a development run pointed at a synthetic 0.1 folder serves that one's
/// root `mcp/` like the others). A registry that cannot be read gives none.
pub fn folders(v1_data: &Path, served: &Path) -> Vec<Folder> {
    let libraries = match locate::discover(v1_data) {
        Ok(libraries) => libraries,
        Err(error) => {
            log::warn!("the 0.1 libraries' MCP connections could not be listed: {error}");
            return Vec::new();
        }
    };
    libraries
        .into_iter()
        .filter_map(|library| {
            let directory = library.root.join("mcp");
            let registry = std::fs::symlink_metadata(directory.join("grants.json"));
            if directory == served || !registry.is_ok_and(|meta| meta.is_file()) {
                return None;
            }
            let owner = match library.owner {
                None | Some(locate::Owner::Local) => Owner::Local,
                Some(locate::Owner::Account { subject }) => Owner::Account(subject),
            };
            Some(Folder {
                library: library.id,
                owner,
                directory,
            })
        })
        .collect()
}

type Opening = Shared<BoxFuture<'static, Result<Network>>>;

struct Served {
    folder: Folder,
    host: Host,
    opening: Opening,
}

/// The 0.1 folders being served, each with its own [`Host`].
#[derive(Default)]
pub struct Connections {
    served: Vec<Served>,
}

impl Connections {
    /// Starts serving every folder on `reactor` (as the app's own folder:
    /// [`inbound::serve`] with `paths`' executable, clients and transport) and
    /// returns at once. The folders start one after another once `after`
    /// (the app's own folder starting) is done: each start repairs the
    /// client configurations it owns entries in, the same files for every
    /// folder, and those files have no lock (two at once would refuse one
    /// another's change). A folder that cannot be served is logged and left.
    pub fn serve(
        folders: Vec<Folder>,
        paths: &GrantPaths,
        reactor: &Handle,
        after: BoxFuture<'static, ()>,
    ) -> Self {
        let mut served = Vec::new();
        let mut starts = Vec::new();
        for folder in folders {
            let host = Host::new(reactor.clone());
            let (send, receive) = oneshot::channel();
            starts.push((
                paths.for_directory(folder.directory.clone()),
                host.clone(),
                folder.library.clone(),
                send,
            ));
            let opening = async move {
                receive
                    .await
                    .map_err(|_| "MCP initialization worker ended".to_owned())?
            }
            .boxed()
            .shared();
            served.push(Served {
                folder,
                host,
                opening,
            });
        }
        if !starts.is_empty() {
            reactor.spawn(async move {
                after.await;
                for (paths, host, library, send) in starts {
                    let result = inbound::serve(paths, host).await;
                    match &result {
                        Ok(network) => {
                            for warning in &network.warnings {
                                log::warn!("0.1 library {library}'s MCP connections: {warning}");
                            }
                        }
                        Err(error) => {
                            log::warn!("0.1 library {library}'s MCP connections: {error}")
                        }
                    }
                    let _ = send.send(result);
                }
            });
        }
        Self { served }
    }

    /// Each folder, with the Host its connections see the open book through.
    pub fn hosts(&self) -> impl Iterator<Item = (&Folder, &Host)> {
        self.served
            .iter()
            .map(|served| (&served.folder, &served.host))
    }

    /// Lend `backend` and `book` to the folders `open` owns, the library
    /// being attached; every other folder sees no book. `None` (an owner
    /// that cannot be told, or a release) reaches none.
    pub fn attach(&self, open: Option<&Owner>, book: Option<BookId>, backend: Option<Backend>) {
        for served in &self.served {
            if open.is_some_and(|owner| owner.is(&served.folder.owner)) {
                served.host.replace(book.clone(), backend.clone());
            } else {
                served.host.replace(None, None);
            }
        }
    }

    /// The open book changed. A folder without the library's backend stays
    /// without a book.
    pub fn select(&self, book: Option<BookId>) {
        for served in &self.served {
            served.host.select(book.clone());
        }
    }

    /// Before the library is released: every folder loses the backend.
    pub fn suspend(&self) {
        for served in &self.served {
            served.host.suspend();
        }
    }

    /// The library's book edits, for each folder's catalog notifications (a
    /// folder without the book ignores them). Drop before the release.
    pub fn follow(&self, workspace: &Workspace) -> Vec<Subscription> {
        self.served
            .iter()
            .map(|served| served.host.follow(workspace))
            .collect()
    }

    /// Every folder's network once it is served, or why it is not.
    pub fn opened(&self) -> BoxFuture<'static, Vec<Result<Network>>> {
        join_all(self.served.iter().map(|served| served.opening.clone())).boxed()
    }

    /// Waits for every served folder's queued grant operations.
    pub fn drain(&self) -> BoxFuture<'static, Result<()>> {
        let opened = self.opened();
        async move {
            let drained = join_all(
                opened
                    .await
                    .into_iter()
                    .flatten()
                    .map(|network| network.grants.drain()),
            )
            .await;
            drained.into_iter().collect::<Result<Vec<()>>>().map(drop)
        }
        .boxed()
    }

    /// Stops every folder's server and waits for its connections.
    pub fn close(&self) -> BoxFuture<'static, ()> {
        let opened = self.opened();
        async move {
            let closing = opened
                .await
                .into_iter()
                .flatten()
                .map(|network| network.server.close());
            let _ = join_all(closing).await;
        }
        .boxed()
    }
}
