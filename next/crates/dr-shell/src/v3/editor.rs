//! An editor belongs to its mounted renderer, never to a global document id.
use crate::{pages::PageViewHost, workspace::editors::PageView};
use gpui::{App, Entity, EntityId, Global, Subscription};
use std::{collections::HashMap, rc::Rc};

type ReadEditor = Rc<dyn Fn(&App) -> Option<PageView>>;
struct Binding {
    workspace: EntityId,
    library: usize,
    book: String,
    read: ReadEditor,
    _changed: Subscription,
}
#[derive(Default)]
struct Editors(HashMap<EntityId, Binding>);
impl Global for Editors {}

/// Expose the editor the renderer actually owns, including while it loads or
/// replaces it. Call once for the view returned in `Rendered` or `ModulePage`.
/// The getter must only read that view; it must not open another session.
///
/// A registration holds the renderer weakly and disappears when it is released.
/// The shell additionally checks its workspace, library, book and exact document
/// before adopting it. Two renderers of the same body remain separate instances.
pub fn register_editor<V: 'static>(
    host: &PageViewHost,
    view: &Entity<V>,
    read: impl Fn(&V, &App) -> Option<PageView> + 'static,
    cx: &mut App,
) {
    let id = view.entity_id();
    let weak = view.downgrade();
    let workspace = host.workspace.clone();
    let changed = cx.observe(view, move |_, cx| {
        workspace.update(cx, |_, cx| cx.notify()).ok();
    });
    cx.default_global::<Editors>().0.insert(
        id,
        Binding {
            workspace: host.workspace.entity_id(),
            library: host.library.library() as *const _ as usize,
            book: host.book_id.clone(),
            read: Rc::new(move |cx| read(weak.upgrade()?.read(cx), cx)),
            _changed: changed,
        },
    );
    cx.observe_release(view, move |_, cx| {
        cx.default_global::<Editors>().0.remove(&id);
    })
    .detach();
}

pub(crate) fn registered_editor(
    view: EntityId,
    workspace: EntityId,
    library: &dr_workspace::Workspace,
    book: &str,
    cx: &App,
) -> Option<PageView> {
    let binding = cx.try_global::<Editors>()?.0.get(&view)?;
    if binding.workspace != workspace
        || binding.library != library.library() as *const _ as usize
        || binding.book != book
    {
        return None;
    }
    (binding.read)(cx)
}
