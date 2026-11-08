//! Short, read-only queries for the empty conversation's three requests.

use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

use crate::onboarding::{Chapter, Element, StarterSource};

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
            use dr_doc::book::Collection;
            let kind = match Collection::from_root(&effect.kind) {
                Some(Collection::Nodes) => "node",
                Some(Collection::Elements) => "element",
                Some(Collection::Categories) => "category",
                Some(Collection::Storylines) => "storyline",
                Some(Collection::Materials) => "material",
                Some(Collection::Comments) => "comment",
                Some(Collection::Relations) => "relation",
                _ => effect.kind.as_str(),
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
            ) {
                add(ChangeTarget {
                    kind: kind.into(),
                    id: effect.id,
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
    use dr_workspace::{LinkGroup, NavTarget};
    let missing = || "changed object is no longer available".to_owned();
    if change.book.as_deref().is_some_and(|owner| owner != book) {
        return Err(missing());
    }
    let catalog = ws.catalog(book).map_err(|error| error.to_string())?;
    if !catalog.exists(&NavTarget::Book) {
        return Err(missing());
    }
    if let Some(doc) = &change.history
        && ws
            .library()
            .doc_info(doc)
            .map_err(|error| error.to_string())?
            .and_then(|info| info.book_id)
            .as_deref()
            != Some(book)
    {
        return Err(missing());
    }
    let locate = |kind: &str, id: &str| {
        let nav = match kind {
            "node" => catalog
                .by_id(LinkGroup::Chapters, id)
                .or_else(|| catalog.by_id(LinkGroup::Drifts, id)),
            "element" => catalog.by_id(LinkGroup::Elements, id),
            "category" => catalog.by_id(LinkGroup::Categories, id),
            "storyline" => catalog.by_id(LinkGroup::Storylines, id),
            "material" => id
                .parse()
                .ok()
                .map(NavTarget::Material)
                .filter(|target| catalog.exists(target)),
            _ => None,
        }?;
        Some((
            dr_shell::nav::Target::from_key(&nav.key())?,
            catalog.title(&nav)?,
        ))
    };
    if history {
        let doc = change.history.as_ref().ok_or_else(missing)?;
        if !dr_model::DocId::parse(doc).is_ok_and(|doc| doc.profile().is_some())
            || ws
                .library()
                .doc_info(doc)
                .map_err(|error| error.to_string())?
                .and_then(|info| info.book_id)
                .as_deref()
                != Some(book)
        {
            return Err(missing());
        }
        let (target, name) = locate(&change.kind, &change.id).ok_or_else(missing)?;
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
        let result = ws
            .call(&Actor::User, "relation.list", json!({"book":book}))
            .map_err(|error| error.to_string())?;
        let relation = result["output"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|relation| relation["id"].as_str() == Some(change.id.as_str()))
            .ok_or_else(missing)?;
        // Relations have no standalone prose document. Open one of this
        // exact live relation's endpoints, preferring an element because
        // its page hosts M17's relations section. Never borrow endpoints
        // from another edge or fall back to the book's storage document.
        let ends = [&relation["from"], &relation["to"]];
        return ends
            .iter()
            .filter(|end| end["kind"] == "element")
            .chain(ends.iter().filter(|end| end["kind"] != "element"))
            .find_map(|end| {
                end["kind"]
                    .as_str()
                    .zip(end["id"].as_str())
                    .and_then(|(kind, id)| locate(kind, id))
            })
            .map(|(target, _)| ChangeLocation::Page(target))
            .ok_or_else(missing);
    }
    if change.kind == "comment" {
        let result = ws
            .call(&Actor::User, "comment.list", json!({"book":book}))
            .map_err(|error| error.to_string())?;
        let comment = result["output"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|comment| comment["id"].as_str() == Some(change.id.as_str()))
            .ok_or_else(missing)?;
        let target = if comment["unlocated"] == true {
            None
        } else {
            comment["target"]["kind"]
                .as_str()
                .zip(comment["target"]["id"].as_str())
                .and_then(|(kind, id)| locate(kind, id))
                .map(|(target, _)| target)
        };
        return Ok(ChangeLocation::Comment {
            id: change.id.clone(),
            target,
        });
    }
    locate(&change.kind, &change.id)
        .map(|(target, _)| ChangeLocation::Page(target))
        .ok_or_else(missing)
}

pub fn starters(ws: &Workspace, book: &str) -> Result<StarterSource, String> {
    let read = |name, input| {
        ws.call(&Actor::User, name, input)
            .map(|value| value["output"].clone())
            .map_err(|error| error.to_string())
    };
    let chapters = read("chapter.list", json!({"book":book}))?;
    let elements = read("element.list", json!({"book":book}))?;
    let relations = read("relation.list", json!({"book":book}))?;
    let recent = read("recent.list", json!({"book":book}))?;
    let mut chapter_rows = Vec::new();
    for (index, row) in chapters.as_array().into_iter().flatten().enumerate() {
        let (Some(id), Some(title)) = (row["id"].as_str(), row["title"].as_str()) else {
            continue;
        };
        let mut words = row["words"].as_u64().unwrap_or(0);
        if words == 0 {
            // Chapter words are a derived index and may not have been built
            // yet. The guide only needs presence, so consult the live F3
            // owner rather than treating an unindexed manuscript as empty.
            // Read all paragraphs: text after 200 empty paragraphs still counts.
            let prose = read(
                "prose.read",
                json!({"doc":format!("node:{id}"),"limit":usize::MAX}),
            )?;
            words = u64::from(prose["paragraphs"].as_array().into_iter().flatten().any(
                |paragraph| {
                    paragraph["text"]
                        .as_str()
                        .is_some_and(|text| !text.trim().is_empty())
                },
            ));
        }
        chapter_rows.push(Chapter {
            id: id.into(),
            title: title.into(),
            book_order: index,
            word_count: words,
        });
    }
    let mut source = StarterSource {
        chapters: chapter_rows,
        ..Default::default()
    };
    let mut rows: Vec<_> = elements.as_array().into_iter().flatten().collect();
    rows.sort_by_key(|row| (row["created_at"].as_i64().unwrap_or(0), row["id"].as_str()));
    source.elements = rows
        .into_iter()
        .filter_map(|row| {
            Some(Element {
                id: row["id"].as_str()?.into(),
                name: row["name"].as_str()?.into(),
            })
        })
        .collect();
    for row in relations.as_array().into_iter().flatten() {
        for key in ["from", "to"] {
            let target = &row[key];
            if target["kind"] == "element"
                && let Some(id) = target["id"].as_str()
            {
                *source.relation_counts.entry(id.into()).or_default() += 1;
            }
        }
    }
    source.recent_chapter_ids = recent
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let target = &row["target"];
            (target["kind"] == "node")
                .then(|| target["id"].as_str().map(str::to_owned))
                .flatten()
        })
        .collect();
    Ok(source)
}

/// A provider activity may contain arbitrary data. Only a normal web URL is
/// offered as an external link; the activity text itself remains readable.
pub fn web_url(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    (matches!(url.scheme(), "https" | "http") && url.host_str().is_some()).then(|| url.into())
}

pub fn tool_name(call: &dr_agent::ToolCall) -> &str {
    if call.name == "call_tool" {
        call.arguments["name"].as_str().unwrap_or(&call.name)
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
    use dr_i18n::keys::agent_panel::onboarding::prompts;
    use dr_testkit::seed::{self, Preset};

    #[test]
    fn template_settlements_do_not_offer_unimplemented_navigation_or_history() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = Workspace::open_dir(directory.path(), "m31-template-navigation").unwrap();
        let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().to_string();
        let text = seeded.books[0].prose[0].view().plain_text();
        seeded.write_to(workspace.library()).unwrap();
        for (kind, prefix) in [
            ("category", "category_template"),
            ("storyline", "chapter_template"),
        ] {
            let owner = workspace
                .call(&Actor::User, &format!("{kind}.list"), json!({"book":book}))
                .unwrap()["output"][0]["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let mut arguments = json!({"book":book});
            arguments[kind] = owner.into();
            let doc = workspace
                .call(
                    &Actor::User,
                    &format!("{prefix}.document"),
                    arguments.clone(),
                )
                .unwrap()["output"]["doc"]
                .as_str()
                .unwrap()
                .to_owned();
            let session = format!("m31-template-{kind}");
            arguments["paragraphs"] = json!([{"text":text}]);
            let output = workspace
                .call(
                    &Actor::agent(&session, 1, "write"),
                    &format!("{prefix}.set_body"),
                    arguments,
                )
                .unwrap();
            let settlements = workspace
                .library()
                .settlements(Some(&session), None)
                .unwrap();
            assert_eq!(settlements.len(), 1);
            assert_eq!(settlements[0].doc_id, doc);
            // The history capability is real; only a precise UI destination
            // is missing. These are actual F3 receipts, not test-only ids.
            workspace
                .call(&Actor::User, "history.points", json!({"doc":doc}))
                .unwrap();
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
        let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
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
    fn recent_node_routes_starters_to_the_non_first_written_chapter() {
        let directory = tempfile::tempdir().unwrap();
        let library = dr_store::Library::open(
            directory.path(),
            dr_workspace::library_options("m31-starters-test"),
        )
        .unwrap();
        let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().to_string();
        seeded.write_to(&library).unwrap();
        let workspace =
            Workspace::open(library, dr_workspace::WorkspaceOptions::default()).unwrap();
        let listed = workspace
            .call(&Actor::User, "chapter.list", json!({"book":book}))
            .unwrap();
        assert!(
            listed["output"]
                .as_array()
                .unwrap()
                .iter()
                .all(|chapter| chapter["words"] == 0),
            "the regression must exercise the unbuilt index"
        );
        let before = starters(&workspace, &book).unwrap();
        let written: Vec<_> = before
            .chapters
            .iter()
            .filter(|chapter| chapter.word_count > 0)
            .collect();
        assert!(
            written.len() > 1,
            "the tiny seed has several written chapters"
        );
        let first = written[0];
        let recent = written[1];
        assert_eq!(
            crate::onboarding::build_starter_prompts(&before)[0].values,
            vec![("chapter", first.title.clone())]
        );
        workspace
            .call(
                &Actor::User,
                "recent.touch",
                json!({"book":book,"target":{"kind":"node","id":recent.id}}),
            )
            .unwrap();
        let after = starters(&workspace, &book).unwrap();
        assert_eq!(after.recent_chapter_ids.first(), Some(&recent.id));
        let requests = crate::onboarding::build_starter_prompts(&after);
        assert_eq!(requests[0].key, prompts::COMMENT_CHAPTER);
        assert_eq!(requests[0].values, vec![("chapter", recent.title.clone())]);
        assert_eq!(requests[1].values, vec![("chapter", recent.title.clone())]);
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
