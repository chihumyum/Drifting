//! What the Review tab lists: comments and TODOs filtered by kind and scope,
//! grouped by where they are (the old client's `review-groups.ts`). Plain
//! data, no GPUI.
//!
//! - **Filter**: all, comments (notes) or TODOs.
//! - **Scope**: the current tab's entity, or the whole project.
//! - **Groups**: one per target (a chapter, an idea, an element …), the
//!   group of the newest item first; items attached to nothing come last
//!   (未挂载), and items whose target is gone are their own group (已删除).
//!   Inside a group the newest item comes first.
//! - Resolved items are listed apart (the folded 「已解决」 section).

use std::collections::HashSet;

use dr_workspace::dto::{CommentInfo, Target};

/// Which kinds are listed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Filter {
    #[default]
    All,
    Comments,
    Todos,
}

impl Filter {
    pub const ALL: [Filter; 3] = [Filter::All, Filter::Comments, Filter::Todos];

    pub fn index(self) -> usize {
        Filter::ALL.iter().position(|f| *f == self).unwrap_or(0)
    }

    fn admits(self, item: &CommentInfo) -> bool {
        match self {
            Filter::All => true,
            Filter::Comments => item.kind != "todo",
            Filter::Todos => item.kind == "todo",
        }
    }
}

/// Where a group's items are.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Place {
    /// On an entity.
    On(Target),
    /// On something that is gone (in the trash, deleted).
    Gone,
    /// On nothing.
    Floating,
}

#[derive(Clone, Debug)]
pub struct Group {
    pub place: Place,
    pub items: Vec<CommentInfo>,
}

impl Group {
    /// A key for the group's element ids.
    pub fn key(&self) -> String {
        match &self.place {
            Place::On(t) => format!("{}:{}", t.kind, t.id),
            Place::Gone => "gone".into(),
            Place::Floating => "floating".into(),
        }
    }
}

/// The open and the resolved groups.
#[derive(Clone, Debug, Default)]
pub struct Listing {
    pub open: Vec<Group>,
    pub resolved: Vec<Group>,
    /// How many resolved items there are.
    pub resolved_count: usize,
}

fn place_of(item: &CommentInfo) -> Place {
    match (&item.target, item.unlocated) {
        (Some(_), true) => Place::Gone,
        (Some(t), false) => Place::On(t.clone()),
        (None, _) => Place::Floating,
    }
}

/// Groups `items` (in any order) for the tab.
pub fn arrange(items: &[CommentInfo], filter: Filter, scope: Option<&Target>) -> Listing {
    arrange_with_related(items, filter, scope, &HashSet::new())
}

/// Current scope includes comments pointing at the entity through a generic
/// association, as well as comments directly attached to it. Associations
/// affect inclusion only; grouping still describes each comment's source.
pub fn arrange_with_related(
    items: &[CommentInfo],
    filter: Filter,
    scope: Option<&Target>,
    related: &HashSet<String>,
) -> Listing {
    let mut chosen: Vec<&CommentInfo> = items
        .iter()
        .filter(|i| filter.admits(i))
        .filter(|i| scope.is_none_or(|s| i.target.as_ref() == Some(s) || related.contains(&i.id)))
        .collect();
    // Newest first; the id breaks ties so the order is stable.
    chosen.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    let group = |resolved: bool| {
        let mut groups: Vec<Group> = Vec::new();
        for item in chosen
            .iter()
            .filter(|i| (i.status == "resolved") == resolved)
        {
            let place = place_of(item);
            match groups.iter_mut().find(|g| g.place == place) {
                Some(g) => g.items.push((*item).clone()),
                None => groups.push(Group {
                    place,
                    items: vec![(*item).clone()],
                }),
            }
        }
        // Entities first (by their newest item), then gone, then floating.
        groups.sort_by_key(|g| match g.place {
            Place::On(_) => 0,
            Place::Gone => 1,
            Place::Floating => 2,
        });
        groups
    };
    let resolved = group(true);
    Listing {
        open: group(false),
        resolved_count: resolved.iter().map(|g| g.items.len()).sum(),
        resolved,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, kind: &str, on: Option<&str>, status: &str, at: i64) -> CommentInfo {
        CommentInfo {
            id: id.into(),
            kind: kind.into(),
            target: on.map(|id| Target {
                kind: "node".into(),
                id: id.into(),
            }),
            unlocated: false,
            target_block: None,
            anchored: true,
            quote: None,
            body: id.into(),
            status: status.into(),
            priority: None,
            author_kind: "user".into(),
            author_name: None,
            source: "manual".into(),
            agent_conversation: None,
            projection: None,
            region: None,
            created_at: Some(at),
            updated_at: None,
        }
    }

    #[test]
    fn items_are_filtered_scoped_and_grouped_by_place() {
        let items = vec![
            item("a", "note", Some("c1"), "open", 1),
            item("b", "todo", Some("c2"), "open", 5),
            item("c", "note", Some("c1"), "open", 3),
            item("d", "todo", None, "open", 9),
            item("e", "note", Some("c1"), "resolved", 7),
        ];
        let all = arrange(&items, Filter::All, None);
        let keys: Vec<String> = all.open.iter().map(Group::key).collect();
        // The chapter with the newest item first; floating last.
        assert_eq!(keys, ["node:c2", "node:c1", "floating"]);
        let c1: Vec<&str> = all.open[1].items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(c1, ["c", "a"], "newest first inside a group");
        assert_eq!(all.resolved_count, 1);
        let todos = arrange(&items, Filter::Todos, None);
        assert_eq!(todos.open.len(), 2);
        assert!(
            todos
                .open
                .iter()
                .all(|g| g.items.iter().all(|i| i.kind == "todo"))
        );
        let here = Target {
            kind: "node".into(),
            id: "c1".into(),
        };
        let scoped = arrange(&items, Filter::Comments, Some(&here));
        assert_eq!(scoped.open.len(), 1);
        assert_eq!(scoped.open[0].items.len(), 2);
        assert_eq!(scoped.resolved_count, 1);
    }

    #[test]
    fn items_on_something_gone_are_their_own_group() {
        let mut gone = item("x", "note", Some("c9"), "open", 1);
        gone.unlocated = true;
        let listing = arrange(&[gone], Filter::All, None);
        assert_eq!(listing.open[0].place, Place::Gone);
    }

    #[test]
    fn associated_items_enter_current_scope_once_and_keep_their_source_group() {
        let here = Target {
            kind: "node".into(),
            id: "c1".into(),
        };
        let items = vec![
            item("a", "note", Some("c1"), "open", 1),
            item("b", "todo", None, "open", 2),
            item("c", "note", Some("c2"), "resolved", 3),
            item("d", "note", Some("c2"), "open", 4),
        ];
        let related = HashSet::from(["a".into(), "b".into(), "c".into()]);
        let listing = arrange_with_related(&items, Filter::All, Some(&here), &related);
        assert_eq!(
            listing
                .open
                .iter()
                .flat_map(|g| &g.items)
                .map(|i| i.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(listing.open[1].place, Place::Floating);
        assert_eq!(listing.resolved_count, 1);
        assert_eq!(listing.resolved[0].key(), "node:c2");
        let todos = arrange_with_related(&items, Filter::Todos, Some(&here), &related);
        assert_eq!(todos.open[0].items[0].id, "b");
        assert_eq!(todos.resolved_count, 0);
        assert_eq!(
            arrange(&items, Filter::All, Some(&here)).open[0]
                .items
                .len(),
            1
        );
    }
}
