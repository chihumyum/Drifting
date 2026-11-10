//! The global search host keeps v3 entry/module identity and paragraph positions.
use super::*;
use dr_view_search::{SearchEvent, SearchPanel};
use serde_json::{Value, json};

fn target(value: &dr_view_search::v3::Target) -> Option<Target> {
    Some(match value {
        dr_view_search::v3::Target::Entry { id, module } => Target::Entry {
            id: id.parse().ok()?,
            module: module.as_ref().map(|m| m.parse()).transpose().ok()?,
        },
        dr_view_search::v3::Target::Material(id) => Target::Material(id.parse().ok()?),
    })
}

impl Workspace {
    /// ⌘⇧F chooses the panel for this book's version. V3 hits go directly to
    /// the navigator; they never pass through the legacy Book fallback.
    pub fn toggle_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.search.take().is_some() {
            self.refocus(window, cx);
            return;
        }
        // While a book is loading its version is unknown; an empty snapshot
        // must not be mistaken for a v2.2 book.
        if self.book.is_empty() {
            return;
        }
        let strings = crate::Strings::get(cx);
        let (locale, platform) = (strings.locale(), strings.platform());
        let book = self.book.clone();
        let (lib, id) = (self.library.clone(), self.book_id.clone());
        let origin = id.clone();
        let panel = cx.new(|cx| {
            let marks = Rc::new(move |t: &dr_view_search::v3::Target| {
                target(t).map_or((dr_ui::sand::Kind::Element, None), |t| book.mark(&t))
            });
            SearchPanel::new_v3(lib, id, marks, locale, platform, window, cx)
        });
        cx.subscribe_in(&panel, window, move |ws, panel, event, window, cx| {
            // A closed panel or a result from the previous book cannot close
            // the new search or navigate in the newly opened book.
            if ws.book_id != origin
                || ws
                    .search
                    .as_ref()
                    .is_none_or(|p| p.entity_id() != panel.entity_id())
            {
                return;
            }
            ws.search = None;
            // The destination may already be the active page. Invalidate the
            // focus cache too, so closing search gives that editor typing back.
            ws.refocus(window, cx);
            match event {
                SearchEvent::JumpV3(jump) => {
                    if ws.book.v3().is_some()
                        && let Some(target) = target(&jump.target)
                        && ws.book.exists(&target)
                    {
                        ws.super_view = None;
                        ws.nav.open_at(
                            target,
                            jump.line.map(|start| nav::Lines { start, end: None }),
                        );
                        ws.changed(cx);
                    }
                }

                SearchEvent::Close => {}
            }
            cx.notify();
        })
        .detach();
        panel.update(cx, |p, cx| p.focus(window, cx));
        let workspace = cx.entity().downgrade();
        let pending = panel.downgrade();
        self.search = Some(panel);
        // A page renderer may already have queued its own prose handoff.
        // The newer search request wins, provided this panel is still on top.
        window.defer(cx, move |window, cx| {
            let (Some(workspace), Some(panel)) = (workspace.upgrade(), pending.upgrade()) else {
                return;
            };
            let current = workspace.read(cx);
            if current.top_layer() == Some(Layer::Search)
                && current
                    .search
                    .as_ref()
                    .is_some_and(|p| p.entity_id() == panel.entity_id())
            {
                panel.update(cx, |p, cx| p.focus(window, cx));
            }
        });
        cx.notify();
    }

    /// Read-only state for F8 acceptance: actual panel results and the same
    /// target conversion used when selecting one. No query is run here.
    pub fn search_state(&self, cx: &App) -> Option<Value> {
        let panel = self.search.as_ref()?.read(cx);
        let rows = |rows: &[dr_view_search::model::Row]| {
            rows.iter()
                .map(|r| {
                    json!({
                        "snippet": r.snippet, "field": format!("{:?}", r.field),
                        "line": r.paragraph.map(|n| 2 * n + 1),
                    })
                })
                .collect::<Vec<_>>()
        };
        let (version, groups) = if let Some(groups) = panel.v3_groups() {
            (
                3,
                groups
                    .iter()
                    .map(|g| {
                        json!({
                            "target": target(&g.target).map(|t| t.key()), "title": g.title,
                            "module": g.module_name, "rows": rows(&g.rows),
                        })
                    })
                    .collect::<Vec<_>>(),
            )
        } else {
            (3, Vec::new())
        };
        Some(json!({"version": version, "searching": panel.is_searching(), "groups": groups}))
    }
}
