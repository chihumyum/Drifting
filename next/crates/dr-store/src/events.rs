//! One event bus for the whole library: persisted Loro changes of every open
//! document, and changes to local-only tables (assets, Agent settlements,
//! sync state, derived indexes, and whatever tables dr-workspace adds, which
//! announce themselves through [`crate::Library::notify_local`]).
//!
//! Every event is delivered after the change it describes is committed to
//! SQLite, on the thread that committed it.

use std::sync::{Arc, Mutex, Weak};

use crate::holder::DocEvent;

/// How a local row changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalChangeKind {
    Insert,
    Update,
    Delete,
}

/// A committed change to a local-only table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalChange {
    /// The table (or logical store) that changed, for example `asset`.
    pub table: String,
    /// The changed row's key, for example an asset id or a doc id.
    pub key: String,
    pub kind: LocalChangeKind,
}

impl LocalChange {
    pub fn new(table: impl Into<String>, key: impl Into<String>, kind: LocalChangeKind) -> Self {
        Self {
            table: table.into(),
            key: key.into(),
            kind,
        }
    }
}

#[derive(Clone, Debug)]
pub enum StoreEvent {
    /// A document change, persisted.
    Doc(Arc<DocEvent>),
    /// A local-only table change, committed.
    Local(LocalChange),
}

type Listener = Arc<dyn Fn(&StoreEvent) + Send + Sync>;

#[derive(Default)]
pub(crate) struct Bus {
    next: u64,
    listeners: Vec<(u64, Listener)>,
}

pub(crate) type SharedBus = Arc<Mutex<Bus>>;

pub(crate) fn subscribe(bus: &SharedBus, f: Listener) -> LibrarySubscription {
    let mut b = bus.lock().unwrap_or_else(|e| e.into_inner());
    b.next += 1;
    let id = b.next;
    b.listeners.push((id, f));
    LibrarySubscription {
        bus: Arc::downgrade(bus),
        id,
    }
}

pub(crate) fn publish(bus: &SharedBus, event: &StoreEvent) {
    let listeners: Vec<Listener> = bus
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .listeners
        .iter()
        .map(|(_, l)| l.clone())
        .collect();
    for listener in listeners {
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(event))).is_err() {
            log::error!("a library event listener panicked");
        }
    }
}

/// Unsubscribes when dropped.
pub struct LibrarySubscription {
    bus: Weak<Mutex<Bus>>,
    id: u64,
}

impl Drop for LibrarySubscription {
    fn drop(&mut self) {
        if let Some(bus) = self.bus.upgrade() {
            bus.lock()
                .unwrap_or_else(|e| e.into_inner())
                .listeners
                .retain(|(id, _)| *id != self.id);
        }
    }
}
