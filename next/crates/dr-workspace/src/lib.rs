//! Drifting's commands and queries (foundation F3).
//!
//! One set of commands and queries that the interface, the Agent's tools,
//! MCP and the dev CLI all call; every feature module reads and writes books
//! through it. Plan: `docs/rust-rewrite/foundation.md` "F3 dr-workspace";
//! description, command list and coordination notes:
//! `docs/rust-rewrite/foundations/f3-workspace.md`.
//!
//! - [`registry`]: each command and query registered once, with JSON
//!   Schemas of its input and output, read or write, a concurrency class and
//!   a summary. The capability list is exported from it and kept as an insta
//!   snapshot (`tests/snapshots/`).
//! - [`Workspace::run`] (typed) and [`Workspace::call`] (by name, JSON) run
//!   them. Every write carries its [`Actor`]'s origin; Agent writes leave a
//!   settlement record in the same SQLite transaction.
//! - Write order across documents ([`cx`]): validate, prose documents, the
//!   book document (one commit), local tables (one transaction).
//! - Events ([`events`]): fine-grained changes from dr-store's bus, after
//!   they are durable. Queries are cached per book and kept current by them.
//! - Undo in three layers: the editor's (F4, through dr-doc's `ProseUndo`),
//!   object level ([`Workspace::undo`]: each command declares its inverse),
//!   and an Agent's changes (`history.undo_agent`: by origin, entity by
//!   entity, from history).
//!
//! - The shell's needs ([`nav`]): location-link lookup, the targets a
//!   removal names, the quit hook.
//!
//! Every write is a dr-doc transaction inside a dr-store holder's write job,
//! on the holder's own document; every read shares that document (see
//! `holder.rs`).

pub mod actor;
pub mod autolink;
mod cache;
pub mod commands;
pub mod cx;
pub mod dto;
pub mod editor;
pub mod error;
pub mod events;
mod guard;
mod holder;
pub mod journal;
pub mod naming;
pub mod nav;
pub mod registry;
mod workspace;

pub use actor::Actor;
pub use cx::{Cx, Effect, EffectAction, Faults, Invocation, Outcome};
pub use editor::ProseSession;
pub use error::{Result, WsError};
pub use events::{
    BookChanged, EntityChange, ProseChanged, Removed, RemovedEntity, Subscription, WsEvent,
};
pub use guard::{Observation, WritePreconditions};
pub use holder::COMMAND_ORIGIN;
pub use nav::{BookCatalog, LinkGroup, NavTarget};
pub use registry::{Access, Concurrency, Op, Registry, Spec, registry};
pub use workspace::{QuitReport, ShutdownRefused, Workspace, WorkspaceOptions, library_options};
