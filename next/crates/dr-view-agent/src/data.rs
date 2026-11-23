//! Short, read-only queries for the empty conversation's three requests.

use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

use crate::onboarding::StarterSource;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangeTarget {
    pub kind: String,
    pub id: String,
    pub module: Option<String>,
    /// Only an actual prose settlement offers prose history. A metadata
    /// change to an entry does not imply that its prose changed too.
    pub history: Option<String>,
    book: Option<String>,
}

impl ChangeTarget {
    /// One per changed object, and per prose module of a changed body.
    pub fn key(&self) -> String {
        match &self.module {
            Some(module) => format!("{}:{}/{}", self.kind, self.id, module),
            None => format!("{}:{}", self.kind, self.id),
        }
    }
}

/// Receipt documents identify storage, not metadata entities. Match the
/// receipt back to its own settled call before inspecting that call's effects.
pub fn change_targets(run: &crate::state::RunSnapshot, turn: u32) -> Vec<ChangeTarget> {
    let mut targets: Vec<ChangeTarget> = Vec::new();
    // A body receipt brings its module and that module's history together,
    // so a page and its history always open the same prose. Another module
    // of the same entry gets a target of its own; a metadata change (no
    // module) joins the object's first target.
    let mut add = |target: ChangeTarget| {
        if let Some(previous) = targets.iter_mut().find(|old| {
            old.kind == target.kind
                && old.id == target.id
                && (old.module.is_none() || target.module.is_none() || old.module == target.module)
        }) {
            if previous.module.is_none() && target.module.is_some() {
                previous.module = target.module;
                previous.history = target.history;
            } else if previous.module == target.module && target.history.is_some() {
                previous.history = target.history;
            }
        } else {
            targets.push(target);
        }
    };
    for change in run.changes.iter().filter(|change| change.turn == turn) {
        let receipt = &change.receipt;
        let Ok(doc) = dr_model::DocId::parse(&receipt.document) else {
            continue;
        };
        // Template default prose (`template:<template>/<module>`) has history in
        // F3, while the template editor page does not embed a default-prose
        // reveal hook yet. Do not offer a change/history button that cannot open
        // that prose, or substitute an unrelated entry's prose.
        if matches!(doc, dr_model::DocId::Template(_)) {
            continue;
        }
        if let dr_model::DocId::Body(body) = &doc {
            add(ChangeTarget {
                kind: "entry".into(),
                id: body.entry().to_string(),
                module: Some(body.module().to_string()),
                history: Some(receipt.document.clone()),
                book: None,
            });
            continue;
        }
        let Some(book) = receipt.document.strip_prefix("book:") else {
            continue;
        };
        let result = run
            .tools
            .iter()
            .filter_map(|tool| tool.result.as_ref())
            .find(|result| result.settlements.iter().any(|settled| settled == receipt));
        let Some(effects) = result.and_then(|result| result.output.get("effects")) else {
            // Recovered metadata with no precise effects must not pretend the
            // entire book was the object the author should inspect.
            continue;
        };
        let Ok(effects) = serde_json::from_value::<Vec<dr_workspace::Effect>>(effects.clone())
        else {
            continue;
        };
        for effect in effects {
            // History commands report collection roots (`CollectionV3::root`);
            // ordinary commands report singular entity kinds.
            use dr_doc::v3::CollectionV3 as Collection;
            let (kind, id) = match Collection::from_root(&effect.kind) {
                Some(Collection::Meta | Collection::Project) => ("book", book.to_owned()),
                Some(Collection::Entries) => ("entry", effect.id),
                Some(Collection::Templates) => ("entry_template", effect.id),
                Some(Collection::Memberships) => {
                    let Some((_, member)) = dr_model::v3::Membership::parse_key(&effect.id) else {
                        continue;
                    };
                    ("entry", member.to_string())
                }
                Some(Collection::TimelineViews) => ("timeline_view", effect.id),
                Some(Collection::Patches) => ("patch", effect.id),
                Some(Collection::PlotGrids) => ("plot_grid", effect.id),
                Some(Collection::Relations) => ("relation_row", effect.id),
                Some(Collection::Comments) => ("comment", effect.id),
                Some(Collection::Assets) => ("asset", effect.id),
                Some(Collection::Memory) => ("memory", effect.id),
                // Facts, AssetFolders, RelationTypes and module copies have no
                // dedicated shell page or single-record reveal hook yet; never
                // fake whole-book navigation for them.
                Some(
                    Collection::Facts
                    | Collection::AssetFolders
                    | Collection::RelationTypes
                    | Collection::Modules,
                ) => {
                    continue;
                }
                None => match effect.kind.as_str() {
                    "book" | "projects" | "tab" | "tabs" => ("book", book.to_owned()),
                    "entry" => ("entry", effect.id),
                    "entry_templates" | "entry_template" => ("entry_template", effect.id),
                    "membership" => {
                        let Some((_, member)) = dr_model::v3::Membership::parse_key(&effect.id)
                        else {
                            continue;
                        };
                        ("entry", member.to_string())
                    }
                    "timeline_view" => ("timeline_view", effect.id),
                    "time_pin" => ("time_pin", effect.id),
                    "patch" => ("patch", effect.id),
                    "plot_grid" => ("plot_grid", effect.id),
                    "relation_row" => ("relation_row", effect.id),
                    "comment" => ("comment", effect.id),
                    "asset" => ("asset", effect.id),
                    _ => continue,
                },
            };
            add(ChangeTarget {
                kind: kind.into(),
                id,
                module: None,
                history: None,
                book: Some(book.into()),
            });
        }
    }
    targets
}

pub enum ChangeLocation {
    Home,
    Page(dr_shell::nav::Target),
    Comment {
        id: String,
        target: Option<dr_shell::nav::Target>,
    },
    ProjectMemory(dr_model::id::MemoryId),
    History {
        doc: String,
        name: String,
        target: dr_shell::nav::Target,
    },
}

/// Resolve through F3 off the UI thread. Missing/deleted/cross-book objects
/// fail rather than falling back to an unrelated page or ending the guide.
pub fn resolve_change(
    ws: &Workspace,
    book: &str,
    change: &ChangeTarget,
    history: bool,
) -> Result<ChangeLocation, String> {
    use dr_shell::nav::Target;
    let missing = || "changed object is no longer available".to_owned();
    if change.book.as_deref().is_some_and(|owner| owner != book) {
        return Err(missing());
    }
    let snapshot = dr_shell::book::Book::load(ws, book).map_err(|e| e.to_string())?;
    let locate = |kind: &str, id: &str, module: Option<&str>| {
        let key = match kind {
            "entry" => module
                .map(|m| format!("entry:{id}/{m}"))
                .unwrap_or_else(|| format!("entry:{id}")),
            "entry_template" | "template" => format!("template:{id}"),
            "timeline_view" => format!("book-view:{id}"),
            "asset" => {
                let direct = format!("material:{id}");
                if Target::from_key(&direct).is_some_and(|t| snapshot.exists(&t)) {
                    direct
                } else if let Some(placed) = snapshot
                    .material_items()
                    .iter()
                    .find(|m| m.asset.as_deref() == Some(id))
                {
                    format!("material:{}", placed.id)
                } else {
                    direct
                }
            }
            _ => return None,
        };
        let target = Target::from_key(&key)?;
        snapshot.exists(&target).then(|| {
            (
                target.clone(),
                snapshot.title(&target).unwrap_or_default().to_owned(),
            )
        })
    };
    if history {
        let doc = change.history.as_ref().ok_or_else(missing)?;
        if ws
            .library()
            .doc_info(doc)
            .map_err(|e| e.to_string())?
            .and_then(|i| i.book_id)
            .as_deref()
            != Some(book)
        {
            return Err(missing());
        }
        let (target, name) = match dr_model::DocId::parse(doc).map_err(|e| e.to_string())? {
            dr_model::DocId::Body(b) => {
                locate("entry", b.entry().as_str(), Some(b.module().as_str()))
            }
            _ => None,
        }
        .ok_or_else(missing)?;
        return Ok(ChangeLocation::History {
            doc: doc.clone(),
            name,
            target,
        });
    }
    if change.kind == "book" {
        return (change.id == book && !snapshot.is_empty())
            .then_some(ChangeLocation::Home)
            .ok_or_else(missing);
    }
    if change.kind == "memory" {
        let book_id: dr_model::id::BookId = book
            .parse()
            .map_err(|e: dr_model::id::IdError| e.to_string())?;
        let id = dr_model::id::MemoryId::parse(&change.id).map_err(|_| missing())?;
        let projected = dr_agent::memory::project(ws, &book_id).map_err(|e| e.to_string())?;
        if !projected
            .entries
            .iter()
            .any(|entry| entry.id == id && entry.active())
        {
            return Err(missing());
        }
        return Ok(ChangeLocation::ProjectMemory(id));
    }
    if change.kind == "patch" {
        let book_id: dr_model::id::BookId = book
            .parse()
            .map_err(|e: dr_model::id::IdError| e.to_string())?;
        let patch_id = change.id.clone();
        let found = ws
            .read_book_v3(book, move |doc, _| {
                let borrowed = dr_doc::v3::BorrowedBookV3::new(doc, &book_id)
                    .map_err(|e| dr_workspace::WsError::Invalid(e.to_string()))?;
                Ok(borrowed
                    .view()
                    .patches()
                    .into_iter()
                    .find(|p| p.id.as_str() == patch_id))
            })
            .map_err(|e| e.to_string())?
            .ok_or_else(missing)?;
        return locate("entry", found.entry.as_str(), Some(found.module.as_str()))
            .map(|(target, _)| ChangeLocation::Page(target))
            .ok_or_else(missing);
    }
    if change.kind == "plot_grid" {
        let (entry_id, module_id) = change.id.split_once('/').ok_or_else(missing)?;
        let book_id: dr_model::id::BookId = book
            .parse()
            .map_err(|e: dr_model::id::IdError| e.to_string())?;
        let (e_str, m_str) = (entry_id.to_owned(), module_id.to_owned());
        let has_module = ws
            .read_book_v3(book, move |doc, _| {
                let borrowed = dr_doc::v3::BorrowedBookV3::new(doc, &book_id)
                    .map_err(|e| dr_workspace::WsError::Invalid(e.to_string()))?;
                let view = borrowed.view();
                let templates = view.templates_map();
                let defined = view
                    .entries()
                    .into_iter()
                    .find(|e| e.id.as_str() == e_str && !e.is_trashed())
                    .and_then(|e| e.effective_template(&templates).cloned())
                    .is_some_and(|tpl| {
                        tpl.modules.iter().any(|m| {
                            m.id.as_str() == m_str && m.kind == dr_model::v3::ModuleKind::PlotGrid
                        })
                    });
                let stored = view
                    .plot_grids()
                    .into_iter()
                    .any(|g| g.entry.as_str() == e_str && g.module.as_str() == m_str);
                Ok(defined || stored)
            })
            .map_err(|e| e.to_string())?;
        if !has_module {
            return Err(missing());
        }
        return locate("entry", entry_id, Some(module_id))
            .map(|(target, _)| ChangeLocation::Page(target))
            .ok_or_else(missing);
    }
    if change.kind == "time_pin" {
        let book_id: dr_model::id::BookId = book
            .parse()
            .map_err(|e: dr_model::id::IdError| e.to_string())?;
        let pin_id = change.id.clone();
        let view_id = ws
            .read_book_v3(book, move |doc, _| {
                let borrowed = dr_doc::v3::BorrowedBookV3::new(doc, &book_id)
                    .map_err(|e| dr_workspace::WsError::Invalid(e.to_string()))?;
                Ok(borrowed
                    .view()
                    .timeline_views()
                    .into_iter()
                    .find(|tv| tv.pins.iter().any(|p| p.id.as_str() == pin_id))
                    .map(|tv| tv.id.to_string()))
            })
            .map_err(|e| e.to_string())?
            .ok_or_else(missing)?;
        return locate("timeline_view", &view_id, None)
            .map(|(target, _)| ChangeLocation::Page(target))
            .ok_or_else(missing);
    }
    if change.kind == "relation_row" {
        let book_id: dr_model::id::BookId = book
            .parse()
            .map_err(|e: dr_model::id::IdError| e.to_string())?;
        let change_id = change.id.clone();
        let r = ws
            .read_book_v3(book, move |doc, _| {
                let borrowed = dr_doc::v3::BorrowedBookV3::new(doc, &book_id)
                    .map_err(|e| dr_workspace::WsError::Invalid(e.to_string()))?;
                Ok(borrowed
                    .view()
                    .relations_raw()
                    .into_iter()
                    .find(|r| r.id.as_str() == change_id))
            })
            .map_err(|e| e.to_string())?
            .ok_or_else(missing)?;
        return r
            .left
            .iter()
            .chain(&r.right)
            .find_map(|entry| locate("entry", entry.as_str(), None))
            .map(|(target, _)| ChangeLocation::Page(target))
            .ok_or_else(missing);
    }
    if change.kind == "comment" {
        let result = ws
            .call(&Actor::User, "comment.list", json!({"book":book}))
            .map_err(|e| e.to_string())?;
        let c = result["output"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|c| c["id"].as_str() == Some(&change.id))
            .ok_or_else(missing)?;
        let target = (c["unlocated"] != true)
            .then(|| {
                locate(
                    c["target"]["kind"].as_str()?,
                    c["target"]["id"].as_str()?,
                    c["module"].as_str(),
                )
                .map(|(t, _)| t)
            })
            .flatten();
        return Ok(ChangeLocation::Comment {
            id: change.id.clone(),
            target,
        });
    }
    locate(&change.kind, &change.id, change.module.as_deref())
        .map(|(t, _)| ChangeLocation::Page(t))
        .ok_or_else(missing)
}

pub fn starters(ws: &Workspace, book: &str) -> Result<StarterSource, String> {
    let book_id: dr_model::id::BookId = book
        .parse()
        .map_err(|e: dr_model::id::IdError| e.to_string())?;
    if !ws.is_v3_book(&book_id).map_err(|e| e.to_string())? {
        return Err("only books of the current format support the Agent".into());
    }
    Ok(StarterSource)
}

/// A provider activity may contain arbitrary data. Only a normal web URL is
/// offered as an external link; the activity text itself remains readable.
pub fn web_url(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    (matches!(url.scheme(), "https" | "http") && url.host_str().is_some()).then(|| url.into())
}

pub fn tool_name(call: &dr_agent::ToolCall) -> &str {
    if call.name == "call_tool" {
        call.arguments["name"]
            .as_str()
            .or_else(|| call.arguments["action"]["verb"].as_str())
            .or_else(|| call.arguments["action"].as_str())
            .unwrap_or(&call.name)
    } else {
        &call.name
    }
}

pub fn result_text(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{ChangedReceipt, ChatState, ToolActivity};
    use dr_agent::{SettlementRef, ToolResult, ToolStatus};
    use dr_testkit::seed::{self, Preset};

    #[test]
    fn template_settlements_do_not_offer_unimplemented_navigation_or_history() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = Workspace::open_dir(directory.path(), "m31-template-navigation").unwrap();
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().to_string();
        let text = seeded.books[0].prose[0].view().plain_text();
        seeded.write_to(workspace.library()).unwrap();
        for owner in ["tpl-character", "tpl-chapter"] {
            let arguments = json!({"book":book,"owner":owner,"template":true,"module":"mod-prose"});
            let doc = workspace
                .call(&Actor::User, "module.prose_document", arguments.clone())
                .unwrap()["output"]["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let session = format!("m31-template-{owner}");
            let mut arguments = arguments;
            arguments["paragraphs"] = json!(
                text.lines()
                    .map(|text| json!({"text":text}))
                    .collect::<Vec<_>>()
            );
            let output = workspace
                .call(
                    &Actor::agent(&session, 1, "write"),
                    "module.set_prose",
                    arguments,
                )
                .unwrap();
            let settlements = workspace
                .library()
                .settlements(Some(&session), None)
                .unwrap();
            assert_eq!(settlements.len(), 1);
            assert_eq!(settlements[0].doc_id, doc);
            assert!(!workspace.library().history(&doc).unwrap().is_empty());
            let receipts: Vec<_> = settlements
                .into_iter()
                .map(|row| SettlementRef {
                    id: row.id,
                    document: row.doc_id,
                    seq: row.seq,
                })
                .collect();
            let mut run = ChatState::new(session).snapshot();
            run.changes = receipts
                .iter()
                .cloned()
                .map(|receipt| ChangedReceipt { turn: 1, receipt })
                .collect();
            run.tools.push(ToolActivity {
                id: "write".into(),
                call: None,
                started: true,
                result: Some(ToolResult {
                    call: "write".into(),
                    status: ToolStatus::Success,
                    output,
                    settlements: receipts,
                }),
            });
            assert!(
                change_targets(&run, 1).is_empty(),
                "{doc} has no working UI destination"
            );
        }
        workspace.shutdown().unwrap();
    }

    #[test]
    fn metadata_targets_use_their_own_call_and_turn_effects() {
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().to_string();
        let mut run = ChatState::new("synthetic-session").snapshot();
        let receipt = |id| SettlementRef {
            id,
            document: format!("book:{book}"),
            seq: id,
        };
        let make_tool = |id: &str, settled, kind: &str, target: &str| ToolActivity {
            id: id.into(),
            call: None,
            started: true,
            result: Some(ToolResult {
                call: id.into(),
                status: ToolStatus::Success,
                output: json!({"effects":[{"action":"updated","kind":kind,"id":target}]}),
                settlements: vec![receipt(settled)],
            }),
        };
        run.changes = vec![
            ChangedReceipt {
                turn: 1,
                receipt: receipt(1),
            },
            ChangedReceipt {
                turn: 2,
                receipt: receipt(2),
            },
            // A recovered storage receipt alone says nothing about which
            // metadata object was affected. It must not borrow another call.
            ChangedReceipt {
                turn: 3,
                receipt: receipt(3),
            },
        ];
        run.tools = vec![
            make_tool("second", 2, "entry", "second-effect"),
            make_tool("first", 1, "book", &book),
        ];
        let first = change_targets(&run, 1);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].key(), format!("book:{book}"));
        assert_eq!(first[0].history, None);
        let second = change_targets(&run, 2);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].key(), "entry:second-effect");
        assert_eq!(second[0].history, None);
        assert!(change_targets(&run, 3).is_empty());
    }

    #[test]
    fn each_changed_body_module_opens_and_offers_history_for_that_module() {
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().to_string();
        let entry = dr_model::id::EntryId::new_v7().to_string();
        let mut run = ChatState::new("synthetic-session").snapshot();
        let receipt = |id, document: String| ChangedReceipt {
            turn: 1,
            receipt: SettlementRef {
                id,
                document,
                seq: id,
            },
        };
        // The entry's metadata, then two of its prose modules, in one turn.
        run.changes = vec![
            receipt(1, format!("book:{book}")),
            receipt(2, format!("body:{entry}/mod-prose")),
            receipt(3, format!("body:{entry}/mod-summary")),
        ];
        run.tools = vec![ToolActivity {
            id: "rename".into(),
            call: None,
            started: true,
            result: Some(ToolResult {
                call: "rename".into(),
                status: ToolStatus::Success,
                output: json!({"effects":[{"action":"updated","kind":"entry","id":entry}]}),
                settlements: vec![run.changes[0].receipt.clone()],
            }),
        }];
        let targets = change_targets(&run, 1);
        assert_eq!(
            targets
                .iter()
                .map(|t| (t.key(), t.module.clone(), t.history.clone()))
                .collect::<Vec<_>>(),
            ["mod-prose", "mod-summary"]
                .map(|module| (
                    format!("entry:{entry}/{module}"),
                    Some(module.to_owned()),
                    Some(format!("body:{entry}/{module}")),
                ))
                .to_vec(),
        );
    }

    #[test]
    fn v3_onboarding_does_not_infer_novel_starters_from_entry_shapes() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = Workspace::open_dir(directory.path(), "k6-v3-starters").unwrap();
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        seeded.write_to(workspace.library()).unwrap();
        let source = starters(&workspace, seeded.books[0].book_id().as_str()).unwrap();
        assert!(crate::onboarding::build_starter_prompts(&source).is_empty());
        workspace.shutdown().unwrap();
    }

    #[test]
    fn provider_activity_links_require_http_and_a_host() {
        for denied in [
            "javascript:alert(1)",
            "file:///tmp/example",
            "data:text/plain,example",
            "https://",
            "http:///",
            "/relative",
        ] {
            assert!(web_url(denied).is_none(), "{denied}");
        }
        assert_eq!(
            web_url("https://example.invalid/path?q=test").as_deref(),
            Some("https://example.invalid/path?q=test")
        );
        assert_eq!(
            web_url("http://example.invalid/").as_deref(),
            Some("http://example.invalid/")
        );
    }

    #[test]
    fn v5_project_tab_and_asset_settlements_resolve_to_home_and_material_targets() {
        use dr_doc::v3::novel::TPL_CHAPTER;
        let directory = tempfile::tempdir().unwrap();
        let workspace = Workspace::open_dir(directory.path(), "m31-v5-change-targets").unwrap();
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().to_string();
        let entry = seeded.books[0]
            .book
            .view()
            .entries()
            .into_iter()
            .find(|e| {
                e.template
                    .as_ref()
                    .is_some_and(|t| t.as_str() == TPL_CHAPTER)
            })
            .unwrap()
            .id
            .to_string();
        seeded.write_to(workspace.library()).unwrap();

        let unplaced_asset = "01950000-0000-7000-8000-000000000801";
        let placed_asset = "01950000-0000-7000-8000-000000000802";
        for (id, name, sha256) in [
            (
                unplaced_asset,
                "loose.png",
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde1",
            ),
            (
                placed_asset,
                "placed.png",
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde2",
            ),
        ] {
            workspace
                .call(
                    &Actor::User,
                    "asset.put",
                    json!({
                        "book": book,
                        "id": id,
                        "name": name,
                        "kind": "image",
                        "mime": "image/png",
                        "size": 64,
                        "sha256": sha256,
                        "width": 32,
                        "height": 32
                    }),
                )
                .unwrap();
        }
        workspace
            .call(
                &Actor::User,
                "entry_template.put_module",
                json!({
                    "book": book,
                    "template": TPL_CHAPTER,
                    "module": {"id": "mod-gallery", "kind": "media", "name": "图集"}
                }),
            )
            .unwrap();
        let placed_item = "01950000-0000-7000-8000-000000000811";
        workspace
            .call(
                &Actor::User,
                "module.put_media",
                json!({
                    "book": book,
                    "entry": entry,
                    "module": "mod-gallery",
                    "item": {"id": placed_item, "asset": placed_asset, "caption": "插图"}
                }),
            )
            .unwrap();

        let receipt = |id| SettlementRef {
            id,
            document: format!("book:{book}"),
            seq: id,
        };
        let make_tool = |id: &str, settled, kind: &str, target: &str| ToolActivity {
            id: id.into(),
            call: None,
            started: true,
            result: Some(ToolResult {
                call: id.into(),
                status: ToolStatus::Success,
                output: json!({"effects":[{"action":"updated","kind":kind,"id":target}]}),
                settlements: vec![receipt(settled)],
            }),
        };
        let mut run = ChatState::new("m31-v5-session").snapshot();
        run.changes = vec![
            ChangedReceipt {
                turn: 1,
                receipt: receipt(1),
            },
            ChangedReceipt {
                turn: 2,
                receipt: receipt(2),
            },
            ChangedReceipt {
                turn: 3,
                receipt: receipt(3),
            },
            ChangedReceipt {
                turn: 4,
                receipt: receipt(4),
            },
        ];
        run.tools = vec![
            make_tool("project-call", 1, "project", &book),
            make_tool("tab-call", 2, "tab", "tab-files"),
            make_tool("unplaced-asset", 3, "asset", unplaced_asset),
            make_tool("placed-asset", 4, "assets", placed_asset),
        ];

        for turn in [1, 2] {
            let targets = change_targets(&run, turn);
            assert_eq!(targets.len(), 1);
            assert_eq!(targets[0].key(), format!("book:{book}"));
            assert!(matches!(
                resolve_change(&workspace, &book, &targets[0], false).unwrap(),
                ChangeLocation::Home
            ));
        }

        let unplaced_targets = change_targets(&run, 3);
        assert_eq!(unplaced_targets.len(), 1);
        assert_eq!(unplaced_targets[0].key(), format!("asset:{unplaced_asset}"));
        match resolve_change(&workspace, &book, &unplaced_targets[0], false).unwrap() {
            ChangeLocation::Page(target) => {
                assert_eq!(target.key(), format!("material:{unplaced_asset}"))
            }
            _ => panic!("expected unplaced asset to resolve to Material page target"),
        }

        // A file a media module holds is still a file of the asset library
        // (T5, `kernel-v5.md` §6): its change opens the file's own viewer,
        // which lists the media module among its usages, not the media item.
        let placed_targets = change_targets(&run, 4);
        assert_eq!(placed_targets.len(), 1);
        assert_eq!(placed_targets[0].key(), format!("asset:{placed_asset}"));
        match resolve_change(&workspace, &book, &placed_targets[0], false).unwrap() {
            ChangeLocation::Page(target) => {
                assert_eq!(target.key(), format!("material:{placed_asset}"));
                assert_ne!(target.key(), format!("material:{placed_item}"));
            }
            _ => panic!("expected placed asset to resolve to its file's Material target"),
        }

        workspace.shutdown().unwrap();
    }

    #[test]
    fn v5_templates_memberships_timelines_pins_patches_grids_memory_and_untargetable_effects() {
        use dr_doc::v3::novel::{TPL_CHAPTER, TPL_CHARACTER};
        let directory = tempfile::tempdir().unwrap();
        let workspace = Workspace::open_dir(directory.path(), "m31-v5-all-effects").unwrap();
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().to_string();
        seeded.write_to(workspace.library()).unwrap();

        let chapter = dr_testkit::seed::acceptance::entries_by_template(
            &workspace,
            &book,
            TPL_CHAPTER,
        )[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let character =
            dr_testkit::seed::acceptance::entries_by_template(&workspace, &book, TPL_CHARACTER)[0]
                ["id"]
                .as_str()
                .unwrap()
                .to_owned();

        // Add a plot_grid module on chapter template and write a grid.
        workspace
            .call(
                &Actor::User,
                "entry_template.put_module",
                json!({
                    "book": book,
                    "template": TPL_CHAPTER,
                    "module": {"id": "mod-grid", "kind": "plot_grid", "name": "情节表"}
                }),
            )
            .unwrap();
        let mut grid = workspace
            .call(
                &Actor::User,
                "module.read",
                json!({
                    "book": book,
                    "entry": chapter,
                    "module": "mod-grid",
                }),
            )
            .unwrap()["output"]["grid"]
            .clone();
        grid["rows"][0]["label"] = json!("行");
        workspace
            .call(
                &Actor::User,
                "module.put_grid",
                json!({
                    "book": book,
                    "entry": chapter,
                    "module": "mod-grid",
                    "grid": grid,
                }),
            )
            .unwrap();

        // Add a patch on character.
        let patch_id = workspace
            .call(
                &Actor::User,
                "module.put_patch",
                json!({
                    "book": book,
                    "entry": character,
                    "module": "mod-patches",
                    "body": "人物补丁"
                }),
            )
            .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        // Find a timeline view and add a time pin.
        let view_id = workspace
            .call(&Actor::User, "timeline_view.list", json!({"book": book}))
            .unwrap()["output"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let pin_id = workspace
            .call(
                &Actor::User,
                "timeline_view.put_pin",
                json!({
                    "book": book,
                    "view": view_id,
                    "pin": {"id": "01950000-0000-7000-8000-000000000901", "label": "节点", "at": 1.0}
                }),
            )
            .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        // Add a Project Memory entry.
        let mem_id = workspace
            .call(
                &Actor::User,
                "memory.add",
                json!({"book": book, "body": "全书保持克制叙述"}),
            )
            .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        let receipt = |id| SettlementRef {
            id,
            document: format!("book:{book}"),
            seq: id,
        };
        let make_tool = |id: &str, settled, kind: &str, target: &str| ToolActivity {
            id: id.into(),
            call: None,
            started: true,
            result: Some(ToolResult {
                call: id.into(),
                status: ToolStatus::Success,
                output: json!({"effects": [{"action": "updated", "kind": kind, "id": target}]}),
                settlements: vec![receipt(settled)],
            }),
        };

        let membership_key = format!("{chapter}|{character}");
        let grid_key = format!("{chapter}/mod-grid");
        let mut run = ChatState::new("m31-v5-full").snapshot();
        let cases = [
            (1, "templates", TPL_CHAPTER),
            (2, "membership", membership_key.as_str()),
            (3, "timeline_view", view_id.as_str()),
            (4, "time_pin", pin_id.as_str()),
            (5, "patch", patch_id.as_str()),
            (6, "plot_grid", grid_key.as_str()),
            (7, "memory", mem_id.as_str()),
            (8, "meta", "name"),
            (9, "fact", "fact-1"),
            (10, "asset_folder", "folder-1"),
            (11, "relation_type", "rt-1"),
        ];
        for (turn, kind, target) in cases {
            run.changes.push(ChangedReceipt {
                turn,
                receipt: receipt(i64::from(turn)),
            });
            run.tools.push(make_tool(
                &format!("call-{turn}"),
                i64::from(turn),
                kind,
                target,
            ));
        }
        // Turn 12: Body prose receipt preserves module target.
        let body_doc = format!("body:{chapter}/mod-prose");
        run.changes.push(ChangedReceipt {
            turn: 12,
            receipt: SettlementRef {
                id: 12,
                document: body_doc.clone(),
                seq: 12,
            },
        });

        // 1. Restored `templates` collection root -> `Target::Template`.
        let t1 = change_targets(&run, 1);
        assert_eq!(t1[0].key(), format!("entry_template:{TPL_CHAPTER}"));
        match resolve_change(&workspace, &book, &t1[0], false).unwrap() {
            ChangeLocation::Page(target) => {
                assert_eq!(target.key(), format!("template:{TPL_CHAPTER}"))
            }
            _ => panic!("expected Template target"),
        }

        // 2. Pipe-delimited `membership` (`host|member`) -> member Entry.
        let t2 = change_targets(&run, 2);
        assert_eq!(t2[0].key(), format!("entry:{character}"));
        match resolve_change(&workspace, &book, &t2[0], false).unwrap() {
            ChangeLocation::Page(target) => assert_eq!(target.key(), format!("entry:{character}")),
            _ => panic!("expected member Entry target"),
        }

        // 3 & 4. `timeline_view` and `time_pin` -> `Target::BookView`.
        for turn in [3, 4] {
            let targets = change_targets(&run, turn);
            match resolve_change(&workspace, &book, &targets[0], false).unwrap() {
                ChangeLocation::Page(target) => {
                    assert_eq!(target.key(), format!("book-view:{view_id}"))
                }
                _ => panic!("expected BookView target for turn {turn}"),
            }
        }

        // 5. `patch` -> `Target::Entry { id: character, module: Some("mod-patches") }`.
        let t5 = change_targets(&run, 5);
        match resolve_change(&workspace, &book, &t5[0], false).unwrap() {
            ChangeLocation::Page(target) => {
                assert_eq!(target.key(), format!("entry:{character}/mod-patches"))
            }
            _ => panic!("expected entry patches module target"),
        }

        // 6. `plot_grid` -> `Target::Entry { id: chapter, module: Some("mod-grid") }`.
        let t6 = change_targets(&run, 6);
        match resolve_change(&workspace, &book, &t6[0], false).unwrap() {
            ChangeLocation::Page(target) => {
                assert_eq!(target.key(), format!("entry:{chapter}/mod-grid"))
            }
            _ => panic!("expected entry plot_grid module target"),
        }

        // 7. `memory` -> `ChangeLocation::ProjectMemory`.
        let t7 = change_targets(&run, 7);
        match resolve_change(&workspace, &book, &t7[0], false).unwrap() {
            ChangeLocation::ProjectMemory(id) => assert_eq!(id.as_str(), mem_id),
            _ => panic!("expected ProjectMemory location"),
        }

        // 8. `meta` collection root -> `ChangeLocation::Home`.
        let t8 = change_targets(&run, 8);
        assert!(matches!(
            resolve_change(&workspace, &book, &t8[0], false).unwrap(),
            ChangeLocation::Home
        ));

        // 9–11. Untargetable metadata objects never fake whole-book navigation.
        for turn in [9, 10, 11] {
            assert!(
                change_targets(&run, turn).is_empty(),
                "turn {turn} has no targetable UI destination"
            );
        }

        // 12. Body prose receipt scrolls to exact prose module and offers history.
        let t12 = change_targets(&run, 12);
        assert_eq!(t12[0].history.as_deref(), Some(body_doc.as_str()));
        match resolve_change(&workspace, &book, &t12[0], false).unwrap() {
            ChangeLocation::Page(target) => {
                assert_eq!(target.key(), format!("entry:{chapter}/mod-prose"))
            }
            _ => panic!("expected prose module page target"),
        }

        // Deleting targets makes `resolve_change` fail rather than faking Home/book.
        workspace
            .call(
                &Actor::User,
                "module.remove_patch",
                json!({"book": book, "entry": character, "module": "mod-patches", "id": patch_id}),
            )
            .unwrap();
        assert!(resolve_change(&workspace, &book, &t5[0], false).is_err());

        workspace
            .call(
                &Actor::User,
                "timeline_view.remove_pin",
                json!({"book": book, "view": view_id, "pin": pin_id}),
            )
            .unwrap();
        assert!(resolve_change(&workspace, &book, &change_targets(&run, 4)[0], false).is_err());

        workspace
            .call(
                &Actor::User,
                "memory.remove",
                json!({"book": book, "id": mem_id}),
            )
            .unwrap();
        assert!(resolve_change(&workspace, &book, &t7[0], false).is_err());

        workspace.shutdown().unwrap();
    }
}
