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

/// `template_projector` is K6's shared, pure template projection. Keeping it
/// explicit lets snapshot preparation and host isolation be tested separately.
pub fn project(
    workspace: &Workspace,
    request: &Request,
    template_projector: impl FnOnce(&dr_model::v3::EntryTemplate) -> TemplateSummary,
) -> Result<Projection, WsError> {
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
        let level = request.draft.kind == "level";
        Ok(Projection {
            source_frontier: request.frontier.clone(),
            draft_frontier: frontier.into(),
            template: template_projector(&template),
            level_defaults: level.then(|| request.draft.settings.clone()),
            lane: level.then_some(request.draft.lane),
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
}
