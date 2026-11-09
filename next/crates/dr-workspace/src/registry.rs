//! The registry: every command and query, registered once.
//!
//! Each entry names itself, its input and output types (JSON Schemas from
//! `schemars`), whether it reads or writes, its concurrency class and what it
//! does. The interface calls entries by type ([`crate::Workspace::run`]);
//! Agent tools, MCP and the dev CLI call the same entries by name with JSON
//! ([`crate::Workspace::call`]). The capability list is exported from here
//! ([`Registry::manifest`]) and kept as an insta snapshot in the repository,
//! so a change to any command's surface shows up as a reviewable diff. It
//! replaces the 0.1 client's three lists (Agent capabilities, CLI, sync).
//!
//! There is deliberately no risk, confirmation or revert tier: Agent writes
//! take effect directly and are undone through history (the old tiers were
//! retired on 2026-11-06).

use std::collections::BTreeMap;
use std::sync::OnceLock;

use schemars::generate::{Contract, SchemaSettings};
use schemars::{JsonSchema, Schema};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::cx::Cx;
use crate::error::{Result, WsError};

/// Whether an entry reads or writes. A query never writes; a command may
/// also read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    Read,
    Write,
}

/// How an entry runs alongside others.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Concurrency {
    /// Reads the committed state; runs alongside anything.
    Shared,
    /// Writes one book: one at a time per book (validation and writes see no
    /// other command's half-done work), any number of books at once.
    Book,
    /// Creates or removes whole books: one at a time per library.
    Library,
}

/// A command or query, statically typed.
pub trait Op: 'static {
    /// Dotted lower-case name, e.g. `chapter.create`.
    /// Required book schema version; None denotes the existing common/v2.2 surface.
    const BOOK_VERSION: Option<i64> = None;
    const NAME: &'static str;
    const ACCESS: Access;
    const CONCURRENCY: Concurrency;
    /// One sentence for Agent tools, MCP and the CLI.
    const SUMMARY: &'static str;
    type Input: DeserializeOwned + JsonSchema;
    type Output: Serialize + JsonSchema;
    fn run(cx: &Cx<'_>, input: Self::Input) -> Result<Self::Output>;
}

/// One registered entry.
pub struct Spec {
    pub book_version: Option<i64>,
    pub name: &'static str,
    pub access: Access,
    pub concurrency: Concurrency,
    pub summary: &'static str,
    /// Alternate typed signature selected only for a v3 book.
    pub v3: Option<VersionedSignature>,
    input_schema: fn() -> Schema,
    output_schema: fn() -> Schema,
    pub(crate) call: fn(&Cx<'_>, Value) -> Result<Value>,
}

/// Schemas for the v3 form of an existing command. The default signature
/// remains the v2.2 contract used by existing consumers.
pub struct VersionedSignature {
    input: fn() -> Schema,
    output: fn() -> Schema,
}
impl VersionedSignature {
    pub fn input_schema(&self) -> Schema {
        (self.input)()
    }
    pub fn output_schema(&self) -> Schema {
        (self.output)()
    }
}

impl Spec {
    pub fn input_schema(&self) -> Schema {
        (self.input_schema)()
    }

    pub fn output_schema(&self) -> Schema {
        (self.output_schema)()
    }

    pub fn is_query(&self) -> bool {
        self.access == Access::Read
    }
}

fn input_schema<T: JsonSchema>() -> Schema {
    let mut s = SchemaSettings::draft2020_12();
    s.meta_schema = None;
    s.contract = Contract::Deserialize;
    s.into_generator().into_root_schema_for::<T>()
}

fn output_schema<T: JsonSchema>() -> Schema {
    let mut s = SchemaSettings::draft2020_12();
    s.meta_schema = None;
    s.contract = Contract::Serialize;
    s.into_generator().into_root_schema_for::<T>()
}

fn call_json<O: Op>(cx: &Cx<'_>, input: Value) -> Result<Value> {
    let input: O::Input = serde_json::from_value(input).map_err(|e| WsError::BadInput {
        command: O::NAME,
        detail: e.to_string(),
    })?;
    let out = O::run(cx, input)?;
    serde_json::to_value(out).map_err(|e| WsError::Internal(e.to_string()))
}

fn call_versioned<O: Op, V: Op>(cx: &Cx<'_>, input: Value) -> Result<Value> {
    let book = if let Some(book) = input.get("book").and_then(Value::as_str) {
        Some(book.to_owned())
    } else if let Some(doc) = input.get("doc").and_then(Value::as_str) {
        cx.workspace()
            .library()
            .doc_info(doc)?
            .and_then(|d| d.book_id)
    } else {
        None
    };
    if let Some(book) = book
        && cx.book(&book)?.is_v3()
    {
        call_json::<V>(cx, input)
    } else {
        call_json::<O>(cx, input)
    }
}

/// Every command and query.
#[derive(Default)]
pub struct Registry {
    specs: BTreeMap<&'static str, Spec>,
}

impl Registry {
    /// Register `O`. Panics on a duplicate name or a malformed one: the
    /// registry is built once, at start-up, from code.
    pub fn add<O: Op>(&mut self) -> &mut Self {
        assert!(
            O::NAME
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b == b'.' || b == b'_')
                && O::NAME.contains('.'),
            "bad command name {}",
            O::NAME
        );
        assert!(
            !(O::ACCESS == Access::Read && O::CONCURRENCY != Concurrency::Shared),
            "{} reads but is not shared",
            O::NAME
        );
        let prev = self.specs.insert(
            O::NAME,
            Spec {
                book_version: O::BOOK_VERSION,
                name: O::NAME,
                access: O::ACCESS,
                concurrency: O::CONCURRENCY,
                summary: O::SUMMARY,
                v3: None,
                input_schema: input_schema::<O::Input>,
                output_schema: output_schema::<O::Output>,
                call: call_json::<O>,
            },
        );
        assert!(prev.is_none(), "{} registered twice", O::NAME);
        self
    }

    /// Register one command name with explicit v2.2 and v3 typed signatures.
    /// Dispatch uses the owning book's stored version, never the target's old kind.
    pub fn add_versioned<O: Op, V: Op>(&mut self) -> &mut Self {
        assert_eq!(O::NAME, V::NAME);
        assert_eq!(O::ACCESS, V::ACCESS);
        assert_eq!(O::CONCURRENCY, V::CONCURRENCY);
        assert_eq!(V::BOOK_VERSION, Some(3));
        self.add::<O>();
        let s = self.specs.get_mut(O::NAME).expect("registered");
        s.v3 = Some(VersionedSignature {
            input: input_schema::<V::Input>,
            output: output_schema::<V::Output>,
        });
        s.call = call_versioned::<O, V>;
        self
    }

    pub fn get(&self, name: &str) -> Option<&Spec> {
        self.specs.get(name)
    }

    pub fn iter(&self) -> impl Iterator<Item = &Spec> {
        self.specs.values()
    }

    pub fn len(&self) -> usize {
        self.specs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.specs.is_empty()
    }

    /// The capability list: every entry with its schemas, by name.
    pub fn manifest(&self) -> Value {
        Value::Array(
            self.iter()
                .map(|s| {
                    let mut value = serde_json::json!({
                        "name": s.name,
                        "kind": if s.is_query() { "query" } else { "command" },
                        "access": s.access,
                        "concurrency": s.concurrency,
                        "summary": s.summary,
                        "input": s.input_schema(),
                        "output": s.output_schema(),
                    });
                    if let Some(version) = s.book_version {
                        value["book_version"] = version.into();
                    }
                    if let Some(v3) = &s.v3 {
                        value["v3"] = serde_json::json!({ "book_version": 3, "input": v3.input_schema(), "output": v3.output_schema() });
                    }
                    value
                })
                .collect(),
        )
    }

    /// One line per entry: name, kind, concurrency, summary.
    pub fn table(&self) -> String {
        let mut out = String::new();
        for s in self.iter() {
            let kind = if s.is_query() { "query" } else { "command" };
            let conc = match s.concurrency {
                Concurrency::Shared => "shared",
                Concurrency::Book => "book",
                Concurrency::Library => "library",
            };
            out.push_str(&format!(
                "{:<28} {:<8} {:<8} {}\n",
                s.name, kind, conc, s.summary
            ));
        }
        out
    }
}

/// The registry of this build.
pub fn registry() -> &'static Registry {
    static R: OnceLock<Registry> = OnceLock::new();
    R.get_or_init(|| {
        let mut r = Registry::default();
        crate::commands::register(&mut r);
        r
    })
}
