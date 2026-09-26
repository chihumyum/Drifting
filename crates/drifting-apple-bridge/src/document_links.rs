//! Automatic entity links in an open body, with the renderer's name map:
//! every live element's name and aliases, then chapter titles (a later
//! entry for the same name wins), excluding the body's own element or chapter.
use super::*;
use drifting_core::workspace::WorkspaceStore;
use drifting_document::EntityLinkTarget;

pub(super) fn targets(
    gateway: &DatabaseGateway,
    project_id: &str,
    exclude_kind: &str,
    exclude_id: &str,
) -> Result<Vec<EntityLinkTarget>, String> {
    let store = WorkspaceStore::new(gateway, CLIENT);
    let mut targets = Vec::new();
    for element in store.elements(project_id)? {
        if exclude_kind == "element" && element.id == exclude_id {
            continue;
        }
        for name in std::iter::once(element.name).chain(element.aliases) {
            targets.push(EntityLinkTarget {
                name,
                kind: "element".into(),
                id: element.id.clone(),
            });
        }
    }
    for chapter in store.list_chapters(project_id)? {
        if exclude_kind == "node" && chapter.id == exclude_id {
            continue;
        }
        targets.push(EntityLinkTarget {
            name: chapter.title,
            kind: "node".into(),
            id: chapter.id,
        });
    }
    Ok(targets)
}

/// Background linking never fails a write: with pending input, a failed save
/// or a stored remote block it links nothing and the host retries later.
pub(super) fn link(session: &mut LabSession) -> Result<Value, String> {
    if !session.owner.workspace {
        return Err("Entity links require a workspace body".into());
    }
    if session.write_blocked() {
        return Ok(json!({"linked": 0, "state": session.document_state()?}));
    }
    let targets = targets(
        &session.gateway,
        &session.owner.scope.project_id,
        session.owner.target_kind,
        &session.owner.target_id,
    )?;
    let linked = session.document.link_entities(&targets)?;
    if linked > 0 {
        session.persist();
    }
    Ok(json!({"linked": linked, "state": session.document_state()?}))
}
