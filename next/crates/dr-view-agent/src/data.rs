//! Short, read-only queries for the empty conversation's three requests.

use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

use crate::onboarding::StarterSource;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangeTarget {
    pub kind: String,
    pub id: String,
    /// Only an actual prose settlement offers prose history. A metadata
    /// change to an element does not imply that its prose changed too.
    pub history: Option<String>,
    book: Option<String>,
}

impl ChangeTarget {
    pub fn key(&self) -> String {
        format!("{}:{}", self.kind, self.id)
    }
}

/// Receipt documents identify storage, not metadata entities. Match the
/// receipt back to its own settled call before inspecting that call's effects.
pub fn change_targets(run: &crate::state::RunSnapshot, turn: u32) -> Vec<ChangeTarget> {
    let mut targets: Vec<ChangeTarget> = Vec::new();
    let mut add = |target: ChangeTarget| {
        if let Some(previous) = targets.iter_mut().find(|old| old.key() == target.key()) {
            if target.history.is_some() {
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
        // Template prose has history in F3, but the shell has no template
        // navigation target or exact embedded-editor reveal hook yet.
        // Do not offer a change/history button that resolve_change cannot
        // open, or silently substitute the owner's unrelated prose.
        if matches!(doc, dr_model::DocId::Template(_)) {
            continue;
        }
        if let dr_model::DocId::Body(body) = &doc {
            add(ChangeTarget {
                kind: "entry".into(),
                id: body.entry().to_string(),
                history: Some(receipt.document.clone()),
                book: None,
            });
            continue;
        }
        if doc.profile().is_some() {
            if let Some((kind, id)) = receipt.document.split_once(':') {
                add(ChangeTarget {
                    kind: kind.into(),
                    id: id.into(),
                    history: Some(receipt.document.clone()),
                    book: None,
                });
            }
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
            // History commands report collection roots; ordinary commands
            // report singular entity kinds. Both identify the same object.
            // `meta` stays distinct: its id names a field, not the book.
            use dr_doc::v3::CollectionV3 as Collection;
            let (kind, id) = match Collection::from_root(&effect.kind) {
                Some(Collection::Materials) => ("material", effect.id),
                Some(Collection::Comments) => ("comment", effect.id),
                Some(Collection::Relations) => ("relation", effect.id),
                _ => match effect.kind.as_str() {
                    "entries" | "entry" => ("entry", effect.id),
                    "entry_templates" | "entry_template" => ("entry_template", effect.id),
                    "timeline_views" | "timeline_view" => ("timeline_view", effect.id),
                    "plot_grids" | "plot_grid" => (
                        "entry",
                        effect.id.split('/').next().unwrap_or(&effect.id).to_owned(),
                    ),
                    "memberships" | "membership" => (
                        "entry",
                        effect.id.split('/').nth(1).unwrap_or(&effect.id).to_owned(),
                    ),
                    other => (other, effect.id),
                },
            };
            if matches!(
                kind,
                "book"
                    | "node"
                    | "element"
                    | "category"
                    | "storyline"
                    | "material"
                    | "comment"
                    | "relation"
                    | "entry"
                    | "entry_template"
                    | "timeline_view"
            ) {
                add(ChangeTarget {
                    kind: kind.into(),
                    id,
                    history: None,
                    book: Some(book.into()),
                });
            }
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
            "material" => format!("material:{id}"),
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
            dr_model::DocId::Material(id) => locate("material", id.as_str(), None),
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
        return (change.id == book)
            .then_some(ChangeLocation::Home)
            .ok_or_else(missing);
    }
    if change.kind == "relation" {
        let copy = ws
            .library()
            .load_copy(&format!("book:{book}"))
            .map_err(|e| e.to_string())?;
        let book_id = book
            .parse()
            .map_err(|e: dr_model::id::IdError| e.to_string())?;
        let borrowed =
            dr_doc::v3::BorrowedBookV3::new(&copy, &book_id).map_err(|e| e.to_string())?;
        let r = borrowed
            .view()
            .relations_raw()
            .into_iter()
            .find(|r| r.id.as_str() == change.id)
            .ok_or_else(missing)?;
        return [&r.from, &r.to]
            .into_iter()
            .find_map(|e| locate(e.kind.as_str(), &e.id, None))
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
    locate(&change.kind, &change.id, None)
        .map(|(t, _)| ChangeLocation::Page(t))
        .ok_or_else(missing)
}

pub fn starters(ws: &Workspace, book: &str) -> Result<StarterSource, String> {
    let copy = ws
        .library()
        .load_copy(&format!("book:{book}"))
        .map_err(|e| e.to_string())?;
    if !dr_doc::v3::is_book_doc(&copy) {
        return Err("only canonical v3 books support the Agent".into());
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
            make_tool("second", 2, "element", "second-effect"),
            make_tool("first", 1, "book", &book),
        ];
        let first = change_targets(&run, 1);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].key(), format!("book:{book}"));
        assert_eq!(first[0].history, None);
        let second = change_targets(&run, 2);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].key(), "element:second-effect");
        assert_eq!(second[0].history, None);
        assert!(change_targets(&run, 3).is_empty());
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
}
