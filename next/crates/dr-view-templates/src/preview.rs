//! Local-only template projection. The historical book frontier and the draft
//! are captured together; neither this fork nor its actions enter the runtime.
use dr_agent_tools::{StructureContext, structure::TemplateSummary};
use dr_doc::v3::{BookViewV3, BorrowedBookV3};
use dr_model::id::BookId;
use dr_workspace::{Workspace, WsError, commands::v3::types::EntryTemplate, naming};
use serde::Serialize;

#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub book: String,
    pub frontier: String,
    pub draft: EntryTemplate,
}

#[derive(Debug, Serialize)]
pub struct Projection {
    pub source_frontier: String,
    pub draft_frontier: String,
    /// Also present for a new or unused template, which the runtime context
    /// intentionally does not include until entries/defaults/actions use it.
    pub template: TemplateSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level_defaults: Option<dr_workspace::commands::v3::types::LevelSettingsOverride>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lane: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub declared_actions: Option<Vec<dr_workspace::commands::v3::types::TemplateVerb>>,
    pub structure: StructureContext,
}

/// Use K6's shared projections for both the current template and its book view.
pub fn project(workspace: &Workspace, request: &Request) -> Result<Projection, WsError> {
    with_draft(workspace, request, |view, frontier| {
        let template = view
            .template(
                &request
                    .draft
                    .id
                    .parse()
                    .map_err(|e: dr_model::id::IdError| WsError::Invalid(e.to_string()))?,
            )
            .ok_or_else(|| WsError::Conflict("preview template is unavailable".into()))?;
        let structure = StructureContext::from_v3_view(None, view, frontier, None)
            .map_err(|e| WsError::Internal(e.to_string()))?;
        let level = request.draft.level;
        Ok(Projection {
            source_frontier: request.frontier.clone(),
            draft_frontier: frontier.into(),
            template: TemplateSummary::from_v3_template(&template),
            level_defaults: level.then(|| request.draft.settings.clone()),
            lane: level.then_some(request.draft.settings.lane == Some(true)),
            declared_actions: level.then(|| request.draft.verbs.clone()),
            structure,
        })
    })
}

#[derive(Default)]
pub(crate) struct Cache {
    pub request: Option<Request>,
    pub text: Option<Result<String, ()>>,
}

impl Cache {
    pub fn start(&mut self, request: Request) -> bool {
        if self.request.as_ref() == Some(&request) {
            return false;
        }
        self.request = Some(request);
        self.text = None;
        true
    }
    pub fn publish(&mut self, request: &Request, text: Result<String, ()>) -> bool {
        if self.request.as_ref() != Some(request) {
            return false;
        }
        self.text = Some(text);
        true
    }
}

/// Call the projector against an editable fork of this exact historical view.
/// A later live commit cannot change the input or be mixed into its settings.
fn with_draft<T>(
    workspace: &Workspace,
    request: &Request,
    project: impl FnOnce(&BookViewV3<'_>, &str) -> Result<T, WsError>,
) -> Result<T, WsError> {
    let book = BookId::parse(&request.book).map_err(|e| WsError::Invalid(e.to_string()))?;
    let frontier = naming::frontiers_from_hex(&request.frontier)?;
    let source = workspace
        .library()
        .load_copy_at(&format!("book:{book}"), &frontier)?;
    if source.state_frontiers() != frontier {
        return Err(WsError::Conflict("preview frontier is unavailable".into()));
    }
    let copy = source.fork();
    let borrowed = BorrowedBookV3::new(&copy, &book)?;
    if borrowed.view().trashed_at().is_some() {
        return Err(WsError::Conflict("preview book is unavailable".into()));
    }
    let draft: dr_model::v3::EntryTemplate = serde_json::from_value(
        serde_json::to_value(&request.draft).map_err(|e| WsError::Invalid(e.to_string()))?,
    )
    .map_err(|e| WsError::Invalid(e.to_string()))?;
    // Only the private fork is edited. No holder, Workspace write command,
    // journal receipt, runtime catalog or persistent prose document is touched.
    borrowed.txn().template(&draft.id)?.set_full(&draft)?;
    copy.commit();
    project(
        &borrowed.view(),
        &naming::frontiers_hex(&copy.oplog_frontiers()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model;
    use dr_workspace::{
        Actor,
        commands::{BookIn, v3::template::TemplateList},
    };
    use std::collections::BTreeMap;

    fn body_versions(workspace: &Workspace, book: &str) -> BTreeMap<String, String> {
        workspace
            .library()
            .docs(Some(book), None)
            .unwrap()
            .into_iter()
            .filter(|doc| doc.doc_id.starts_with("body:"))
            .map(|doc| {
                let copy = workspace.library().load_copy(&doc.doc_id).unwrap();
                (doc.doc_id, naming::frontiers_hex(&copy.oplog_frontiers()))
            })
            .collect()
    }

    fn fixture() -> (tempfile::TempDir, Workspace, String) {
        let dir = tempfile::tempdir().unwrap();
        let workspace = Workspace::open_dir(dir.path(), "k5-preview").unwrap();
        let seed = dr_testkit::seed::generate_v3(
            dr_testkit::seed::Preset::Tiny,
            dr_testkit::seed::DEFAULT_SEED,
        )
        .unwrap();
        let book = seed.books[0].book_id().to_string();
        seed.write_to(workspace.library()).unwrap();
        (dir, workspace, book)
    }
    fn template(workspace: &Workspace, book: &str, id: &str) -> EntryTemplate {
        workspace
            .run::<TemplateList>(&Actor::User, BookIn { book: book.into() })
            .unwrap()
            .output
            .into_iter()
            .find(|t| t.id == id)
            .unwrap()
    }

    #[test]
    fn fork_uses_the_requested_frontier_and_does_not_publish_new_templates() {
        let (_dir, workspace, book) = fixture();
        let before = workspace.observe(&format!("book:{book}")).unwrap();
        let original = template(&workspace, &book, "tpl-chapter");
        let mut remote = original.clone();
        remote.name = "Synthetic later chapter".into();
        model::save(&workspace, &book, Some(&original), &remote).unwrap();
        let live = workspace.observe(&format!("book:{book}")).unwrap();
        let mut draft = model::blank("leaf", "Synthetic unpublished template".into());
        model::add_module(
            &mut draft,
            model::module("prose", "Synthetic duplicate name".into()),
        );
        model::add_module(
            &mut draft,
            model::module("prose", "Synthetic duplicate name".into()),
        );
        let request = Request {
            book: book.clone(),
            frontier: before.version,
            draft: draft.clone(),
        };
        with_draft(&workspace, &request, |view, frontier| {
            assert_eq!(
                view.template(&"tpl-chapter".parse().unwrap()).unwrap().name,
                original.name
            );
            let projected = view.template(&draft.id.parse().unwrap()).unwrap();
            assert_eq!(projected.modules.len(), 2);
            assert_eq!(projected.modules[0].id.as_str(), draft.modules[0].id);
            assert_eq!(projected.modules[1].id.as_str(), draft.modules[1].id);
            assert_ne!(frontier, request.frontier);
            Ok(())
        })
        .unwrap();
        let after = workspace.observe(&format!("book:{book}")).unwrap();
        assert_eq!(after.version, live.version);
        assert_eq!(after.value, live.value);
        assert!(!after.value.to_string().contains(&draft.id));
        assert_eq!(template(&workspace, &book, &original.id), remote);
        workspace.close();
    }

    #[test]
    fn a_fork_keeps_the_books_modules_and_retained_content_isolated() {
        let (_dir, workspace, book) = fixture();
        let other = workspace
            .call(
                &Actor::User,
                "project.create",
                serde_json::json!({
                    "name": "Synthetic second preview book"
                }),
            )
            .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let doc = format!("book:{book}");
        let before = workspace.observe(&doc).unwrap();
        let before_other = workspace.observe(&format!("book:{other}")).unwrap();
        let bodies = body_versions(&workspace, &book);
        assert!(!bodies.is_empty());
        let stored = template(&workspace, &book, "tpl-chapter");
        let mut draft = stored.clone();
        draft.agent = Some(dr_workspace::commands::v3::types::TemplateAgentConfig {
            name: "Synthetic draft helper".into(),
            description: String::new(),
            instructions: "Synthetic draft-only instructions".into(),
        });
        draft.modules.clear();
        let request = Request {
            book: book.clone(),
            frontier: before.version.clone(),
            draft,
        };
        with_draft(&workspace, &request, |view, _| {
            assert!(
                view.template(&stored.id.parse().unwrap())
                    .unwrap()
                    .modules
                    .is_empty()
            );
            // Entry field values from removed definitions remain in this same
            // snapshot; the template overlay neither recreates nor deletes them.
            assert_eq!(
                serde_json::to_value(view.entries()).unwrap(),
                serde_json::to_value(
                    BorrowedBookV3::new(
                        &workspace
                            .library()
                            .load_copy_at(
                                &doc,
                                &naming::frontiers_from_hex(&before.version).unwrap()
                            )
                            .unwrap(),
                        &book.parse().unwrap(),
                    )
                    .unwrap()
                    .view()
                    .entries()
                )
                .unwrap()
            );
            Ok(())
        })
        .unwrap();
        let after = workspace.observe(&doc).unwrap();
        let other_after = workspace.observe(&format!("book:{other}")).unwrap();
        assert_eq!(body_versions(&workspace, &book), bodies);
        assert_eq!(
            (after.version, after.value),
            (before.version.clone(), before.value)
        );
        assert_eq!(
            (other_after.version, other_after.value),
            (before_other.version, before_other.value)
        );
        // A frontier is scoped to its document; it cannot be reused for a book
        // with matching built-in template/module ids.
        let wrong_book = Request {
            book: other,
            ..request
        };
        assert!(with_draft(&workspace, &wrong_book, |_, _| Ok(())).is_err());
        workspace.close();
    }

    #[test]
    fn late_projection_cannot_replace_a_newer_draft_frontier_or_book() {
        let old = Request {
            book: "synthetic-book-a".into(),
            frontier: "frontier-a".into(),
            draft: model::blank("leaf", "Synthetic old draft".into()),
        };
        let mut cache = Cache::default();
        assert!(cache.start(old.clone()));
        let mut typed = old.clone();
        typed.draft.name = "Synthetic new draft".into();
        assert!(cache.start(typed.clone()));
        assert!(!cache.publish(&old, Ok("old projection".into())));
        assert!(cache.text.is_none());
        assert!(cache.publish(&typed, Ok("current projection".into())));
        let moved = Request {
            frontier: "frontier-b".into(),
            ..typed.clone()
        };
        assert!(cache.start(moved.clone()));
        assert!(!cache.publish(&typed, Ok("old frontier".into())));
        assert!(cache.text.is_none());
        let other = Request {
            book: "synthetic-book-b".into(),
            ..moved.clone()
        };
        assert!(cache.start(other.clone()));
        assert!(!cache.publish(&moved, Ok("other book".into())));
        assert!(cache.publish(&other, Ok("new book".into())));
        assert!(!cache.start(other));
        assert_eq!(cache.text.as_ref().unwrap().as_ref().unwrap(), "new book");
    }
    #[test]
    fn shared_projection_covers_unused_and_used_drafts_without_publishing_them() {
        use dr_workspace::commands::v3::types::{ModuleAgentConfig, TemplateAgentConfig};
        let (_dir, workspace, book) = fixture();
        let book_id = book.parse().unwrap();
        let runtime = StructureContext::for_book(&workspace, &book_id, None)
            .unwrap()
            .unwrap();
        let before = workspace.observe(&format!("book:{book}")).unwrap();
        let mut draft = model::blank("leaf", "Synthetic unused preview".into());
        draft.agent = Some(TemplateAgentConfig {
            name: "Synthetic \"quoted\" helper".into(),
            description: "Synthetic description".into(),
            instructions: "Synthetic draft-only guidance\nH1/H2/H3".into(),
        });
        for _ in 0..2 {
            model::add_module(
                &mut draft,
                model::module("prose", "Synthetic same name".into()),
            );
        }
        draft.modules[0].agent = Some(ModuleAgentConfig {
            writable: false,
            read_tier: Some("on_demand".into()),
            instructions: "Synthetic first module".into(),
        });
        let request = Request {
            book: book.clone(),
            frontier: before.version.clone(),
            draft: draft.clone(),
        };
        let preview = project(&workspace, &request).unwrap();
        assert_eq!(preview.source_frontier, before.version);
        assert_eq!(preview.template.id, draft.id);
        assert_eq!(
            preview.template.agent.instructions,
            draft.agent.as_ref().unwrap().instructions
        );
        assert_eq!(
            preview
                .template
                .modules
                .iter()
                .map(|m| &m.id)
                .collect::<Vec<_>>(),
            draft.modules.iter().map(|m| &m.id).collect::<Vec<_>>()
        );
        assert!(!preview.template.modules[0].agent.writable);
        assert!(
            preview.template.modules[0]
                .capabilities
                .write_tools
                .is_empty()
        );
        assert_eq!(
            preview.template.modules[0].agent.read_tier.as_deref(),
            Some("on_demand")
        );
        assert!(preview.template.modules[1].capabilities.writable);
        assert!(!preview.structure.templates.iter().any(|t| t.id == draft.id));
        assert_eq!(
            StructureContext::for_book(&workspace, &book_id, None)
                .unwrap()
                .unwrap(),
            runtime
        );
        assert_eq!(
            workspace.observe(&format!("book:{book}")).unwrap().value,
            before.value
        );
        let text = serde_json::to_string(&preview).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).unwrap()["template"]["agent"]["name"],
            "Synthetic \"quoted\" helper"
        );
        // Only the author's explicit Save and Create make the definition
        // available to the actual runtime's in-use template selection.
        model::save(&workspace, &book, None, &draft).unwrap();
        workspace
            .call(
                &Actor::User,
                "entry.create",
                serde_json::json!({
                    "book": book, "template": draft.id, "title": "Synthetic saved template entry"
                }),
            )
            .unwrap();
        let persisted = StructureContext::for_book(&workspace, &book_id, None)
            .unwrap()
            .unwrap();
        assert_eq!(
            persisted.templates.iter().find(|t| t.id == draft.id),
            Some(&preview.template)
        );
        let mut second_draft = draft.clone();
        second_draft.agent.as_mut().unwrap().instructions = "Synthetic next unsaved note".into();
        let current = workspace.observe(&format!("book:{book}")).unwrap();
        let request = Request {
            book: book.clone(),
            frontier: current.version,
            draft: second_draft,
        };
        let changed = project(&workspace, &request).unwrap();
        assert_eq!(
            changed
                .structure
                .templates
                .iter()
                .find(|t| t.id == draft.id)
                .unwrap(),
            &changed.template
        );
        assert_eq!(
            changed.template.agent.instructions,
            "Synthetic next unsaved note"
        );
        assert_eq!(
            StructureContext::for_book(&workspace, &book_id, None)
                .unwrap()
                .unwrap(),
            persisted
        );
        let mut unused_level = model::blank("level", "Synthetic unused level".into());
        unused_level.settings.default_template = Some(None);
        unused_level.settings.home = Some(None);
        unused_level.settings.allow = Some(Vec::new());
        model::add_module(
            &mut unused_level,
            model::module("kv", "Synthetic level fields".into()),
        );
        let before_level = workspace.observe(&format!("book:{book}")).unwrap();
        let request = Request {
            book: book.clone(),
            frontier: before_level.version.clone(),
            draft: unused_level.clone(),
        };
        let projected = project(&workspace, &request).unwrap();
        assert_eq!(projected.template.id, unused_level.id);
        assert_eq!(projected.template.kind, "level");
        assert_eq!(
            projected.level_defaults.as_ref(),
            Some(&unused_level.settings)
        );
        assert_eq!(projected.lane, Some(false));
        assert!(
            !projected
                .structure
                .levels
                .iter()
                .any(|level| level.template.as_deref() == Some(&unused_level.id))
        );
        let json = serde_json::to_value(&projected).unwrap();
        assert_eq!(
            json["level_defaults"]["default_template"],
            serde_json::Value::Null
        );
        assert!(json["level_defaults"].get("default_template").is_some());
        assert_eq!(json["level_defaults"]["home"], serde_json::Value::Null);
        assert!(json["level_defaults"].get("home").is_some());
        assert_eq!(
            workspace.observe(&format!("book:{book}")).unwrap().value,
            before_level.value
        );
        workspace.close();
    }

    #[test]
    fn shared_level_projection_uses_canonical_sources_in_the_same_draft_snapshot() {
        use dr_workspace::commands::v3::types::TemplateVerb;
        let (_dir, workspace, book) = fixture();
        let before = workspace.observe(&format!("book:{book}")).unwrap();
        let mut draft = template(&workspace, &book, "tpl-storyline");
        draft.settings.accept = Some(false);
        draft.settings.home = Some(None);
        draft.lane = true;
        draft.verbs = vec![TemplateVerb {
            id: dr_model::id::new_uuid_v7(),
            name: "Synthetic preview action".into(),
            description: String::new(),
            target_template: Some("tpl-chapter".into()),
            pos: Some("a0".into()),
        }];
        let request = Request {
            book: book.clone(),
            frontier: before.version.clone(),
            draft: draft.clone(),
        };
        let preview = project(&workspace, &request).unwrap();
        assert_eq!(preview.level_defaults.as_ref().unwrap().accept, Some(false));
        assert_eq!(preview.lane, Some(true));
        assert_eq!(preview.declared_actions.as_ref().unwrap(), &draft.verbs);
        let levels: Vec<_> = preview
            .structure
            .levels
            .iter()
            .filter(|l| l.template.as_deref() == Some(&draft.id))
            .collect();
        assert!(!levels.is_empty());
        for level in levels {
            let resolved = with_draft(&workspace, &request, |view, _| {
                let snapshot = view.structure_snapshot();
                Ok(snapshot
                    .level_settings(&level.id.parse().unwrap())
                    .unwrap()
                    .clone())
            })
            .unwrap();
            assert_eq!(
                serde_json::to_value(&level.effective_settings.sources).unwrap(),
                serde_json::to_value(&resolved.sources).unwrap()
            );
            assert_eq!(level.effective_settings.values, resolved.settings);
            assert!(level.effective_settings.values.accept);
            assert_eq!(level.effective_settings.values.home, None);
            assert!(
                level
                    .actions
                    .iter()
                    .any(|a| a.name == "Synthetic preview action" && a.home_id == level.id)
            );
        }
        let after = workspace.observe(&format!("book:{book}")).unwrap();
        assert_eq!((after.version, after.value), (before.version, before.value));
        workspace.close();
    }
}
