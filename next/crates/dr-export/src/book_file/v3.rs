//! V3 archive identity rewriting. Work on the complete operation log, including
//! deleted containers. Schema names, authored strings and book-local template,
//! module and field identifiers are not global entity identities.

use super::*;
use loro::ValueOrContainer;

mod checkpoints;

fn damaged(e: impl ToString) -> BookFileError {
    BookFileError::Damaged(e.to_string())
}

/// Fail a changing export before publishing its file. A later edit is fine:
/// the file still describes the complete stable state just observed.
#[derive(PartialEq, Eq)]
pub(super) struct State {
    docs: BTreeMap<String, Option<dr_store::DocHead>>,
    assets: BTreeMap<(String, String), (String, u64)>,
}

impl State {
    pub(super) fn read(lib: &dr_store::Library, book: &str) -> Result<Self> {
        let docs = lib
            .docs(Some(book), None)?
            .into_iter()
            .map(|doc| lib.head(&doc.doc_id).map(|head| (doc.doc_id, head)))
            .collect::<std::result::Result<_, _>>()?;
        let assets = lib
            .assets_of_book(book)?
            .into_iter()
            .map(|a| ((a.asset_id, a.variant.as_str().into()), (a.sha256, a.size)))
            .collect();
        Ok(Self { docs, assets })
    }
}

pub(super) fn title(ws: &Workspace, book: &str) -> Result<String> {
    let doc = ws.library().load_copy(&format!("book:{book}"))?;
    let id = book.parse().map_err(damaged)?;
    Ok(dr_doc::v3::BorrowedBookV3::new(&doc, &id)
        .map_err(damaged)?
        .view()
        .meta()
        .name)
}

/// Resolve normal tree metadata and mergeable containers to schema paths.
/// Every historical TreeCreate is included, even if the node was purged.
#[derive(Default)]
struct Paths {
    normal: HashMap<ContainerID, Vec<String>>,
}

impl Paths {
    fn of(changes: &[JsonChange]) -> Self {
        let mut this = Self::default();
        for change in changes {
            for op in &change.ops {
                if let JsonOpContent::Tree(TreeOp::Create { target, .. }) = &op.content {
                    let mut path = this.path(&op.container);
                    path.push("*".into());
                    this.normal.insert(target.associated_meta_container(), path);
                }
            }
        }
        for change in changes {
            for op in &change.ops {
                if let JsonOpContent::Map(MapOp::Insert {
                    key,
                    value: LoroValue::String(id),
                }) = &op.content
                    && key == "id"
                    && let Some(path) = this.normal.get_mut(&op.container)
                    && matches!(path.as_slice(), [root, _] if root == "entries")
                {
                    path[1] = id.to_string();
                }
            }
        }
        // Older writers may attach normal children rather than mergeable maps.
        // Iterate until their parent chain is known; unknown roots stay opaque.
        loop {
            let before = this.normal.len();
            for change in changes {
                for op in &change.ops {
                    if let JsonOpContent::Map(MapOp::Insert {
                        key,
                        value: LoroValue::Container(child),
                    }) = &op.content
                    {
                        let mut path = this.path(&op.container);
                        if !path.is_empty() && !this.normal.contains_key(child) {
                            path.push(key.clone());
                            this.normal.insert(child.clone(), path);
                        }
                    }
                }
            }
            if before == this.normal.len() {
                break;
            }
        }
        this
    }

    fn path(&self, container: &ContainerID) -> Vec<String> {
        if let Some((parent, key, _)) = container.parse_mergeable() {
            let mut path = self.path(&parent);
            if !path.is_empty() {
                path.push(key);
            }
            return path;
        }
        match container {
            ContainerID::Root { name, .. } => vec![name.to_string()],
            _ => self.normal.get(container).cloned().unwrap_or_default(),
        }
    }
}

fn plain_identity(path: &[String]) -> bool {
    matches!(
        path,
        [root] if matches!(
            root.as_str(),
            "timeline_views"
                | "patches"
                | "relation_types"
                | "relations"
                | "comments"
                | "assets"
                | "asset_folders"
                | "memory"
                | "facts"
        )
    ) || matches!(path, [root, _, field] if root == "timeline_views" && field == "pins")
        || matches!(path, [root, field] if root == "project" && field == "tabs")
}

fn each_key(changes: &[JsonChange], paths: &Paths, mut f: impl FnMut(&[String], &str)) {
    for change in changes {
        for op in &change.ops {
            if let JsonOpContent::Map(MapOp::Insert { key, .. } | MapOp::Delete { key }) =
                &op.content
            {
                f(&paths.path(&op.container), key);
            }
        }
    }
}

fn fresh(rw: &mut Rewrite, id: &str) {
    rw.ids.entry(id.to_owned()).or_insert_with(new_uuid_v7);
}

pub(super) fn rewrite_for(read: &Contents, book: &LoroDoc) -> Result<Rewrite> {
    let book_id = read.manifest.book.parse().map_err(damaged)?;
    dr_doc::v3::BorrowedBookV3::new(book, &book_id).map_err(damaged)?;
    let mut rw = Rewrite {
        ..Default::default()
    };
    fresh(&mut rw, &read.manifest.book);
    let json = book
        .export_json_updates_without_peer_compression(&VersionVector::default(), &book.oplog_vv())
        .map_err(damaged)?;
    let paths = Paths::of(&json.changes);
    each_key(&json.changes, &paths, |path, key| {
        // 「全部」 has the same fixed id in every book (`TAB-ROOT-ALWAYS`).
        if plain_identity(path)
            && !key.starts_with("todo:")
            && !key.starts_with("rt-generic:")
            && key != dr_model::v3::ALL_TAB_ID
        {
            fresh(&mut rw, key);
        }
    });
    for change in &json.changes {
        for op in &change.ops {
            if let JsonOpContent::Map(MapOp::Insert {
                key,
                value: LoroValue::String(id),
            }) = &op.content
                && key == "id"
                && matches!(paths.path(&op.container).as_slice(), [root, _] if root == "entries")
            {
                fresh(&mut rw, id);
            }
        }
    }
    for (entry, _) in &read.docs {
        match DocId::parse(&entry.id).map_err(damaged)? {
            DocId::Body(body) => fresh(&mut rw, body.entry().as_str()),
            DocId::Template(t) if t.entry_module().is_some() => {}
            id => fresh(&mut rw, id.entity_id()),
        }
    }
    for (asset, _) in &read.assets {
        fresh(&mut rw, &asset.asset);
    }
    each_key(&json.changes, &paths, |path, key| {
        if matches!(path, [root] if root == "plot_grids") {
            map_grid_lines(&mut rw, key);
        }
    });
    // The checkpoint manifests' history, in `checkpoints:<book>`: every id a
    // manifest was ever stored under, the thinned ones included.
    let points = read
        .docs
        .iter()
        .find(|(entry, _)| entry.id == DocId::Checkpoints(book_id.clone()).to_string())
        .map(|(_, bytes)| -> Result<_> {
            let doc = LoroDoc::new();
            doc.import(bytes).map_err(damaged)?;
            let json = doc
                .export_json_updates_without_peer_compression(
                    &VersionVector::default(),
                    &doc.oplog_vv(),
                )
                .map_err(damaged)?;
            let paths = Paths::of(&json.changes);
            Ok((json, paths))
        })
        .transpose()?;
    if let Some((json, paths)) = &points {
        each_key(&json.changes, paths, |path, key| {
            if path == ["entry_checkpoints"] {
                fresh(&mut rw, key);
            }
        });
    }
    // Each kind of document keeps its own genesis version: the book its
    // format's, the documents beside it theirs, prose and conversations theirs.
    let mut seen = std::collections::HashSet::new();
    for (entry, bytes) in &read.docs {
        if !seen.insert(&entry.id) {
            return Err(damaged("duplicate document"));
        }
        let doc = LoroDoc::new();
        doc.import(bytes).map_err(damaged)?;
        let kind = DocId::parse(&entry.id).map_err(damaged)?.kind();
        match DocId::parse(&entry.id).map_err(damaged)? {
            DocId::Book(id) if id == book_id => {}
            DocId::Book(_) => return Err(damaged("foreign book document")),
            DocId::Stats(id) | DocId::Checkpoints(id) | DocId::Layout(id) if id != book_id => {
                return Err(damaged("foreign document beside the book"));
            }
            DocId::Template(t) if t.entry_module().is_some_and(|(b, _, _)| b != book_id) => {
                return Err(damaged("foreign template document"));
            }
            _ => {}
        }
        if entry.id != format!("book:{book_id}")
            && str_value(&doc.get_map(schema::prose::META), schema::meta::DOC).as_deref()
                != Some(entry.id.as_str())
        {
            return Err(damaged("document identity does not match the manifest"));
        }
        let newest = match kind {
            DocKind::Book => schema::BOOK_GENESIS_VERSION,
            DocKind::Stats | DocKind::Checkpoints | DocKind::Layout => schema::SIDE_GENESIS_VERSION,
            _ => GENESIS_VERSION,
        };
        let (version, old) = (1..=newest)
            .rev()
            .map(|v| (v, genesis_peer(&entry.id, v)))
            .find(|(_, p)| doc.oplog_vv().get(p).is_some())
            .ok_or_else(|| damaged(format!("{}: missing genesis", entry.id)))?;
        let id = rw
            .doc_id(&entry.id)
            .ok_or_else(|| damaged("missing document identity"))?;
        rw.peers.insert(old, genesis_peer(&id, version));
    }
    // Generated TODO identity follows both its precise document and block.
    each_key(&json.changes, &paths, |path, key| {
        if matches!(path, [root] if root == "comments")
            && let Some(rest) = key.strip_prefix("todo:")
            && let Some((kind, rest)) = rest.split_once(':')
            && let Some((doc, block)) = rest.split_once('#')
            && let Some(doc) = rw.doc_id(doc)
        {
            rw.ids
                .insert(key.into(), format!("todo:{kind}:{doc}#{}", rw.text(block)));
        }
    });
    if let Some((json, paths)) = &points {
        checkpoints::prepare(read, &mut rw, &json.changes, paths)?;
    }
    Ok(rw)
}

fn map_grid_lines(rw: &mut Rewrite, key: &str) {
    use dr_model::{
        id::{EntryId, ModuleId, PlotColId, PlotRowId},
        v3::PlotGridV3,
    };
    let Some((entry, module)) = key.split_once('/') else {
        return;
    };
    let (Ok(old), Ok(module), Some(new)) = (
        entry.parse::<EntryId>(),
        module.parse::<ModuleId>(),
        rw.ids.get(entry).cloned(),
    ) else {
        return;
    };
    let Ok(new) = new.parse::<EntryId>() else {
        return;
    };
    for n in 1..=dr_model::shared::PLOT_DEFAULT_LINES {
        for (old, new) in [
            (
                PlotRowId::default_for_entry(&old, &module, n).to_string(),
                PlotRowId::default_for_entry(&new, &module, n).to_string(),
            ),
            (
                PlotColId::default_for_entry(&old, &module, n).to_string(),
                PlotColId::default_for_entry(&new, &module, n).to_string(),
            ),
            (
                PlotGridV3::default_row_id(&old, &module, n).to_string(),
                PlotGridV3::default_row_id(&new, &module, n).to_string(),
            ),
            (
                PlotGridV3::default_col_id(&old, &module, n).to_string(),
                PlotGridV3::default_col_id(&new, &module, n).to_string(),
            ),
        ] {
            rw.ids.insert(old, new);
        }
    }
}

struct Rewriter<'a> {
    rw: &'a Rewrite,
    paths: Paths,
    /// The book document: its entities' ids and references move.
    book: bool,
    /// A conversation: its payloads are immutable.
    conversation: bool,
    /// `checkpoints:<book>`: the manifests' ids and contents move.
    points: bool,
    /// `layout:<book>`: scope/mode keys and entry keys move.
    layout: bool,
    source: &'a LoroDoc,
}

fn str_value(map: &loro::LoroMap, key: &str) -> Option<String> {
    match map.get(key)? {
        ValueOrContainer::Value(LoroValue::String(s)) => Some(s.to_string()),
        _ => None,
    }
}

fn map_child(map: &loro::LoroMap, key: &str) -> Option<loro::LoroMap> {
    match map.get(key)? {
        ValueOrContainer::Container(loro::Container::Map(sub)) => Some(sub),
        _ => None,
    }
}

fn classify_field_in_doc(
    doc: &LoroDoc,
    entry_cid: &ContainerID,
    module: &str,
    key: &str,
) -> Option<bool> {
    let entry_map = doc.try_get_map(entry_cid.clone())?;
    let template = str_value(&entry_map, "template")?;
    let templates = doc.get_map("templates");
    let tpl_map = map_child(&templates, &template)?;
    let modules = map_child(&tpl_map, "modules")?;
    let mod_map = map_child(&modules, module)?;
    let cfg = map_child(&mod_map, "config")?;
    if str_value(&cfg, "portrait_field").as_deref() == Some(key) {
        return Some(true);
    }
    let ValueOrContainer::Value(LoroValue::List(defs)) = cfg.get("defs")? else {
        return None;
    };
    defs.iter().find_map(|def| match def {
        LoroValue::Map(def)
            if matches!(def.get("id"), Some(LoroValue::String(id)) if id.as_str() == key) =>
        {
            Some(matches!(
                def.get("field_type"),
                Some(LoroValue::String(kind)) if matches!(kind.as_str(), "image" | "entity_ref")
            ))
        }
        _ => None,
    })
}

impl Rewriter<'_> {
    /// Interpret a field at the operation that wrote it, not using today's
    /// template. A later template switch or field-type change must preserve
    /// historical literals while moving the original reference identities.
    fn field_reference(
        &self,
        op_container: &ContainerID,
        path: &[String],
        key: &str,
        value: &LoroValue,
        at: loro::ID,
        change_end: loro::ID,
    ) -> Result<bool> {
        let [root, entry, fields, module] = path else {
            return Ok(false);
        };
        if !self.book
            || root != "entries"
            || fields != "fields"
            || self.field_value_refs(value) == *value
        {
            return Ok(false);
        }
        let cid = op_container
            .parse_mergeable()
            .and_then(|(fields_cid, _, _)| fields_cid.parse_mergeable())
            .map(|(entry_cid, _, _)| entry_cid)
            .or_else(|| {
                self.paths
                    .normal
                    .iter()
                    .find(|(_, p)| matches!(p.as_slice(), [r, e] if r == "entries" && e == entry))
                    .map(|(cid, _)| cid.clone())
            });
        let Some(cid) = cid else {
            return Ok(false);
        };
        let then = self
            .source
            .fork_at(&loro::Frontiers::from(at))
            .map_err(damaged)?;
        if let Some(is_ref) = classify_field_in_doc(&then, &cid, module, key) {
            return Ok(is_ref);
        }
        if change_end != at {
            let end = self
                .source
                .fork_at(&loro::Frontiers::from(change_end))
                .map_err(damaged)?;
            if let Some(is_ref) = classify_field_in_doc(&end, &cid, module, key) {
                return Ok(is_ref);
            }
        }
        Ok(classify_field_in_doc(self.source, &cid, module, key).unwrap_or(false))
    }

    fn key(&self, path: &[String], key: &str) -> String {
        if self.points && path == ["entry_checkpoints"] {
            return self.rw.text(key);
        }
        if self.layout {
            return match path {
                [root] if root == "positions" => key
                    .split_once('/')
                    .map(|(scope, mode)| {
                        let mapped = if scope == "root" {
                            "root".into()
                        } else {
                            self.rw.text(scope)
                        };
                        format!("{mapped}/{mode}")
                    })
                    .unwrap_or_else(|| key.into()),
                [root, _] if root == "positions" => self.rw.text(key),
                _ => key.into(),
            };
        }
        if !self.book {
            return key.into();
        }
        if plain_identity(path) {
            return self.rw.text(key);
        }
        match path {
            [root, _, field] if root == "relations" && field == "members" => {
                self.rw.text(key)
            }
            [root] if root == "memberships" => key
                .split_once('|')
                .map(|(a, b)| format!("{}|{}", self.rw.text(a), self.rw.text(b)))
                .unwrap_or_else(|| key.into()),
            [root] if root == "plot_grids" => key
                .split_once('/')
                .map(|(entry, module)| format!("{}/{module}", self.rw.text(entry)))
                .unwrap_or_else(|| key.into()),
            [root, _, field]
                if root == "timeline_views"
                    && matches!(field.as_str(), "lanes" | "placements" | "scale") =>
            {
                self.rw.text(key)
            }
            // Row/column ids are local to a grid. UUID references and default
            // ids containing an entry still follow the new global entry id.
            [root, _, field] if root == "plot_grids" && field == "cells" => key
                .split_once('/')
                .map(|(row, col)| format!("{}/{}", self.rw.text(row), self.rw.text(col)))
                .unwrap_or_else(|| key.into()),
            [root, _, field]
                if root == "plot_grids" && matches!(field.as_str(), "rows" | "cols") =>
            {
                self.rw.text(key)
            }
            _ => key.into(),
        }
    }

    fn container(&self, container: &ContainerID) -> ContainerID {
        if let Some((parent, key, kind)) = container.parse_mergeable() {
            return ContainerID::new_mergeable(
                &self.container(&parent),
                &self.key(&self.paths.path(&parent), &key),
                kind,
            );
        }
        match container {
            ContainerID::Normal {
                peer,
                counter,
                container_type,
            } => ContainerID::Normal {
                peer: self.rw.peer(*peer),
                counter: *counter,
                container_type: *container_type,
            },
            _ => container.clone(),
        }
    }

    fn refs(&self, value: &LoroValue) -> LoroValue {
        match value {
            LoroValue::String(s) => self.rw.text(s).into(),
            LoroValue::List(items) => LoroValue::List(
                items
                    .iter()
                    .map(|v| self.refs(v))
                    .collect::<Vec<_>>()
                    .into(),
            ),
            _ => value.clone(),
        }
    }

    fn field_value_refs(&self, value: &LoroValue) -> LoroValue {
        match value {
            LoroValue::Map(m) if m.contains_key("v") => LoroValue::Map(
                m.iter()
                    .map(|(k, v)| {
                        (
                            k.clone(),
                            if k == "v" {
                                self.field_value_refs(v)
                            } else {
                                v.clone()
                            },
                        )
                    })
                    .collect::<HashMap<_, _>>()
                    .into(),
            ),
            _ => self.refs(value),
        }
    }

    fn value(&self, path: &[String], key: &str, value: &LoroValue) -> LoroValue {
        if let LoroValue::Container(c) = value {
            return LoroValue::Container(self.container(c));
        }
        if self.points
            && path == ["entry_checkpoints"]
            && let LoroValue::String(encoded) = value
            && let Some(mapped) = self.rw.checkpoints.get(encoded.as_str())
        {
            return LoroValue::from(mapped.clone());
        }
        if path == ["meta"] {
            if key == "book" {
                return self.refs(value);
            }
            if key == "doc"
                && let LoroValue::String(id) = value
            {
                return self
                    .rw
                    .doc_id(id)
                    .map(LoroValue::from)
                    .unwrap_or_else(|| value.clone());
            }
        }
        if self.conversation {
            return value.clone();
        }
        let reference = match path {
            [root, _] if root == "entries" => matches!(key, "id" | "primary"),
            [root, _] if root == "patches" => {
                matches!(key, "entry" | "source_entry" | "source_block")
            }
            [root, _] if root == "relations" => key == "type",
            [root, _] if root == "comments" => matches!(
                key,
                "target" | "target_block" | "projection_block" | "agent_conversation"
            ),
            [root, _] if root == "assets" => matches!(key, "folder" | "trashed_with"),
            [root, _] if root == "asset_folders" => matches!(key, "parent" | "trashed_with"),
            [root, _] if root == "memory" => {
                matches!(key, "target" | "target_block" | "supersedes")
            }
            [root, _, field, _] if root == "timeline_views" && field == "pins" => key == "entry",
            [root, _, field] if root == "entries" && field == "overrides" => key == "home",
            [root, _, media_mod, _] if root == "entries" && media_mod.starts_with("media:") => {
                key == "asset"
            }
            [root, _, field] if root == "templates" && field == "settings" => key == "home",
            [root, _] if root == "embeds" && !self.book => key == "asset",
            // `layout:<book>`: the tab the project is on follows its tab.
            [root] if self.layout && root == dr_doc::schema::side::TAB => {
                key == dr_doc::schema::side::TAB_ID
            }
            _ => false,
        };
        if reference {
            return self.refs(value);
        }
        if matches!(path, [root, _] if root == "comments")
            && key == "part"
            && let LoroValue::Map(m) = value
        {
            let kind = match m.get("kind") {
                Some(LoroValue::String(s)) => Some(s.as_str()),
                _ => None,
            };
            return LoroValue::Map(
                m.iter()
                    .map(|(k, v)| {
                        let is_ref = match kind {
                            Some("patch") => k == "patch",
                            Some("plot_cell") => matches!(k.as_str(), "row" | "col"),
                            Some("media") => k == "asset",
                            _ => false,
                        };
                        (k.clone(), if is_ref { self.refs(v) } else { v.clone() })
                    })
                    .collect::<HashMap<_, _>>()
                    .into(),
            );
        }
        if matches!(
            path,
            [root, _, modules, _, config]
                if root == "templates" && modules == "modules" && config == "config"
        ) && key == "defs"
            && let LoroValue::List(items) = value
        {
            return LoroValue::List(
                items
                    .iter()
                    .map(|item| match item {
                        LoroValue::Map(def)
                            if matches!(
                                def.get("field_type"),
                                Some(LoroValue::String(kind))
                                    if matches!(kind.as_str(), "image" | "entity_ref")
                            ) =>
                        {
                            LoroValue::Map(
                                def.iter()
                                    .map(|(k, v)| {
                                        (
                                            k.clone(),
                                            if k == "default_value" {
                                                self.field_value_refs(v)
                                            } else {
                                                v.clone()
                                            },
                                        )
                                    })
                                    .collect::<HashMap<_, _>>()
                                    .into(),
                            )
                        }
                        _ => item.clone(),
                    })
                    .collect::<Vec<_>>()
                    .into(),
            );
        }
        if path.last().is_some_and(|s| s == "anchor")
            && matches!(key, "start" | "end")
            && let LoroValue::Binary(bytes) = value
            && let Ok(mut cursor) = loro::cursor::Cursor::decode(bytes)
        {
            if let Some(id) = &mut cursor.id {
                self.rw.id(id);
            }
            cursor.container = self.container(&cursor.container);
            return LoroValue::Binary(cursor.encode().into());
        }
        if matches!(path, [root, _] if root == "comments")
            && key == "snapshots"
            && let LoroValue::List(items) = value
        {
            return LoroValue::List(
                items
                    .iter()
                    .map(|v| match v {
                        LoroValue::Map(m) => LoroValue::Map(
                            m.iter()
                                .map(|(k, v)| {
                                    (
                                        k.clone(),
                                        if k == "block" {
                                            self.refs(v)
                                        } else {
                                            v.clone()
                                        },
                                    )
                                })
                                .collect::<HashMap<_, _>>()
                                .into(),
                        ),
                        _ => v.clone(),
                    })
                    .collect::<Vec<_>>()
                    .into(),
            );
        }
        // A tab's mount names an entry or a view. (An older book's
        // `project.book.root` is carried as it is: the book has no start any
        // more and it is never read.)
        if matches!(path, [root, field, _] if root == "project" && field == "tabs")
            && key == "mount"
            && let LoroValue::Map(m) = value
        {
            return LoroValue::Map(
                m.iter()
                    .map(|(k, v)| {
                        (
                            k.clone(),
                            if matches!(k.as_str(), "entry" | "view" | "lane") {
                                self.refs(v)
                            } else {
                                v.clone()
                            },
                        )
                    })
                    .collect::<HashMap<_, _>>()
                    .into(),
            );
        }
        value.clone()
    }

    fn change(&self, change: &mut JsonChange) -> Result<()> {
        let original_peer = change.id.peer;
        let last_counter = change
            .ops
            .last()
            .map(|op| op.counter + op.content.op_len() as i32 - 1)
            .unwrap_or(change.id.counter);
        let change_end = loro::ID {
            peer: original_peer,
            counter: last_counter,
        };
        self.rw.id(&mut change.id);
        change.deps.iter_mut().for_each(|d| self.rw.id(d));
        for op in &mut change.ops {
            let old_container = op.container.clone();
            let path = self.paths.path(&op.container);
            op.container = self.container(&op.container);
            match &mut op.content {
                JsonOpContent::Map(MapOp::Insert { key, value }) => {
                    let old_key = key.clone();
                    let field_reference = self.field_reference(
                        &old_container,
                        &path,
                        &old_key,
                        value,
                        loro::ID {
                            peer: original_peer,
                            counter: op.counter,
                        },
                        change_end,
                    )?;
                    *key = self.key(&path, key);
                    *value = match marker_kind(value) {
                        Some(kind) => loro_common::mergeable_marker(&op.container, key, kind),
                        None if field_reference => self.field_value_refs(value),
                        None => self.value(&path, &old_key, value),
                    };
                }
                JsonOpContent::Map(MapOp::Delete { key }) => *key = self.key(&path, key),
                JsonOpContent::Text(TextOp::Mark {
                    style_key,
                    style_value,
                    ..
                }) if !self.conversation => {
                    if style_key == schema::block::ID || self.book && style_key == schema::inline::ENTITY {
                        *style_value = self.refs(style_value);
                    } else if let Some(target) = schema::inline::entity_target(style_key) {
                        *style_key = schema::inline::entity_key(&self.rw.text(target));
                        if let LoroValue::Map(m) = style_value {
                            *style_value = LoroValue::Map(
                                m.iter()
                                    .map(|(k, v)| {
                                        (
                                            k.clone(),
                                            if k == "block" || k == "end_block" {
                                                self.refs(v)
                                            } else {
                                                v.clone()
                                            },
                                        )
                                    })
                                    .collect::<HashMap<_, _>>()
                                    .into(),
                            );
                        }
                    }
                }
                JsonOpContent::List(ListOp::Delete { start_id, .. })
                | JsonOpContent::MovableList(MovableListOp::Delete { start_id, .. })
                | JsonOpContent::Text(TextOp::Delete { start_id, .. }) => self.rw.id(start_id),
                JsonOpContent::MovableList(
                    MovableListOp::Move { elem_id, .. } | MovableListOp::Set { elem_id, .. },
                ) => elem_id.peer = self.rw.peer(elem_id.peer),
                JsonOpContent::Tree(
                    TreeOp::Create { target, parent, .. } | TreeOp::Move { target, parent, .. },
                ) => {
                    target.peer = self.rw.peer(target.peer);
                    if let Some(parent) = parent {
                        parent.peer = self.rw.peer(parent.peer);
                    }
                }
                JsonOpContent::Tree(TreeOp::Delete { target }) => {
                    target.peer = self.rw.peer(target.peer)
                }
                JsonOpContent::Future(_) => return Err(damaged("unsupported future change")),
                _ => {}
            }
        }
        Ok(())
    }
}

pub(super) fn rewrite_doc(rw: &Rewrite, id: &str, bytes: &[u8]) -> Result<LoroDoc> {
    let kind = DocId::parse(id).map_err(damaged)?.kind();
    let source = LoroDoc::new();
    source.import(bytes).map_err(damaged)?;
    let mut json = source
        .export_json_updates_without_peer_compression(&VersionVector::default(), &source.oplog_vv())
        .map_err(damaged)?;
    let paths = Paths::of(&json.changes);
    let writer = Rewriter {
        rw,
        paths,
        source: &source,
        book: kind == DocKind::Book,
        conversation: kind == DocKind::Conversation,
        points: kind == DocKind::Checkpoints,
        layout: kind == DocKind::Layout,
    };
    for change in &mut json.changes {
        writer.change(change)?;
    }
    let out = LoroDoc::new();
    schema::configure(&out);
    out.import_json_updates(json).map_err(damaged)?;
    if out.len_ops() != source.len_ops() {
        return Err(damaged("a document lost changes"));
    }
    Ok(out)
}
