//! The ideas panel's tree, without GPUI: groups nested at most two levels
//! (F3's `MAX_GROUP_DEPTH`), each with its sub-groups then its ideas; the
//! loose ideas at the top level after the groups. The 0.1 client's
//! `DriftPanel` and `domain/drift-group.ts`.

use std::collections::{HashMap, HashSet};

use dr_workspace::dto::{GroupInfo, IdeaInfo};

/// Groups nest at most this many levels (F3 refuses deeper).
pub const MAX_DEPTH: usize = 2;

/// The name a new group starts with (0.1's `DEFAULT_DRIFT_GROUP_NAME`, the
/// same in every language).
pub const NEW_GROUP_NAME: &str = "新分组";

/// How ideas are ordered (0.1's `driftSortMode`; newest first by default).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Sort {
    /// Newest first (ids are UUID v7: their order is the order made in).
    #[default]
    Created,
    /// Last changed first.
    Updated,
    /// By title, numbers by value.
    Title,
}

/// What a row shows at its right (0.1's `driftCellMeta`; the date by
/// default). Hidden when the panel is narrower than 200 px.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Meta {
    #[default]
    Date,
    Words,
    Both,
    None,
}

/// One group in the tree.
#[derive(Clone, Debug)]
pub struct Node {
    pub group: GroupInfo,
    /// 0 at the top level.
    pub depth: usize,
    pub children: Vec<Node>,
    pub ideas: Vec<IdeaInfo>,
    /// Ideas in it and in its sub-groups.
    pub count: usize,
}

/// The panel's tree.
#[derive(Clone, Debug, Default)]
pub struct Tree {
    pub groups: Vec<Node>,
    /// Ideas in no group (or in a group that is gone).
    pub loose: Vec<IdeaInfo>,
}

impl Tree {
    /// Every group id, parents first (folding all of them).
    pub fn group_ids(&self) -> Vec<String> {
        fn walk(nodes: &[Node], out: &mut Vec<String>) {
            for n in nodes {
                out.push(n.group.id.clone());
                walk(&n.children, out);
            }
        }
        let mut out = Vec::new();
        walk(&self.groups, &mut out);
        out
    }

    pub fn find(&self, id: &str) -> Option<&Node> {
        fn walk<'a>(nodes: &'a [Node], id: &str) -> Option<&'a Node> {
            nodes.iter().find_map(|n| {
                (n.group.id == id)
                    .then_some(n)
                    .or_else(|| walk(&n.children, id))
            })
        }
        walk(&self.groups, id)
    }
}

/// `ideas` in the panel's order.
pub fn sort_ideas(ideas: &mut [IdeaInfo], sort: Sort, updated: &HashMap<String, i64>) {
    match sort {
        Sort::Created => ideas.sort_by(|a, b| b.id.cmp(&a.id)),
        Sort::Updated => ideas.sort_by(|a, b| {
            let ta = updated.get(&a.id).copied().unwrap_or(0);
            let tb = updated.get(&b.id).copied().unwrap_or(0);
            tb.cmp(&ta).then_with(|| b.id.cmp(&a.id))
        }),
        Sort::Title => ideas.sort_by(|a, b| {
            dr_view_elements::panel::natural(&a.title, &b.title).then_with(|| a.id.cmp(&b.id))
        }),
    }
}

/// The tree of `groups` and `ideas` (trashed ideas left out). A group whose
/// parent is gone, or nested deeper than [`MAX_DEPTH`], or in a cycle, sits
/// at the top level; an idea whose group is gone is loose (0.1: content is
/// never hidden under a key nothing draws).
pub fn tree(
    groups: &[GroupInfo],
    ideas: &[IdeaInfo],
    sort: Sort,
    updated: &HashMap<String, i64>,
) -> Tree {
    let ids: HashSet<&str> = groups.iter().map(|g| g.id.as_str()).collect();
    let parent_of = |g: &GroupInfo| -> Option<String> {
        g.parent
            .as_deref()
            .filter(|p| ids.contains(p) && *p != g.id)
            .map(str::to_owned)
    };
    let mut ideas: Vec<IdeaInfo> = ideas.iter().filter(|i| !i.trashed).cloned().collect();
    sort_ideas(&mut ideas, sort, updated);
    let mut by_group: HashMap<Option<String>, Vec<IdeaInfo>> = HashMap::new();
    for idea in ideas {
        let key = idea.group.clone().filter(|g| ids.contains(g.as_str()));
        by_group.entry(key).or_default().push(idea);
    }
    let mut placed: HashSet<String> = HashSet::new();
    fn build(
        parent: Option<&str>,
        depth: usize,
        groups: &[GroupInfo],
        parent_of: &dyn Fn(&GroupInfo) -> Option<String>,
        by_group: &mut HashMap<Option<String>, Vec<IdeaInfo>>,
        placed: &mut HashSet<String>,
    ) -> Vec<Node> {
        if depth >= MAX_DEPTH {
            return Vec::new();
        }
        let mut out = Vec::new();
        for g in groups.iter().filter(|g| parent_of(g).as_deref() == parent) {
            if !placed.insert(g.id.clone()) {
                continue;
            }
            let children = build(Some(&g.id), depth + 1, groups, parent_of, by_group, placed);
            let ideas = by_group.remove(&Some(g.id.clone())).unwrap_or_default();
            let count = ideas.len() + children.iter().map(|c| c.count).sum::<usize>();
            out.push(Node {
                group: g.clone(),
                depth,
                children,
                ideas,
                count,
            });
        }
        out
    }
    let mut top = build(None, 0, groups, &parent_of, &mut by_group, &mut placed);
    // What the walk could not reach (too deep, a cycle): at the top level.
    for g in groups {
        if placed.insert(g.id.clone()) {
            let ideas = by_group.remove(&Some(g.id.clone())).unwrap_or_default();
            top.push(Node {
                group: g.clone(),
                depth: 0,
                children: Vec::new(),
                count: ideas.len(),
                ideas,
            });
        }
    }
    Tree {
        groups: top,
        loose: by_group.remove(&None).unwrap_or_default(),
    }
}

/// Levels of `id` and below it (itself included).
fn height(groups: &[GroupInfo], id: &str) -> usize {
    1 + groups
        .iter()
        .filter(|g| g.parent.as_deref() == Some(id) && g.id != id)
        .map(|g| height(groups, &g.id))
        .max()
        .unwrap_or(0)
}

/// The level `id` is at (1 at the top).
fn level(groups: &[GroupInfo], id: &str) -> usize {
    let mut level = 1;
    let mut at = groups.iter().find(|g| g.id == id);
    while let Some(g) = at.and_then(|g| g.parent.as_deref()) {
        level += 1;
        if level > MAX_DEPTH + 1 {
            break;
        }
        at = groups.iter().find(|x| x.id == g);
    }
    level
}

/// `id` and every group under it.
pub fn subtree(groups: &[GroupInfo], id: &str) -> HashSet<String> {
    let mut out: HashSet<String> = HashSet::from([id.to_owned()]);
    loop {
        let more: Vec<String> = groups
            .iter()
            .filter(|g| g.parent.as_ref().is_some_and(|p| out.contains(p)) && !out.contains(&g.id))
            .map(|g| g.id.clone())
            .collect();
        if more.is_empty() {
            return out;
        }
        out.extend(more);
    }
}

/// Whether group `id` may move under `parent` (`None`: the top level):
/// not into itself or its own sub-groups, and its levels still fit
/// (0.1's `canMoveGroupUnder`, F3's rule).
pub fn can_move_group(groups: &[GroupInfo], id: &str, parent: Option<&str>) -> bool {
    match parent {
        None => true,
        Some(p) => {
            !subtree(groups, id).contains(p) && level(groups, p) + height(groups, id) <= MAX_DEPTH
        }
    }
}

/// Whether group `id` may have a sub-group (it is at the top level).
pub fn can_nest_under(groups: &[GroupInfo], id: &str) -> bool {
    level(groups, id) < MAX_DEPTH
}

/// A group as the move choices name it: 「父 / 子」 for a sub-group.
pub fn path(groups: &[GroupInfo], g: &GroupInfo) -> String {
    match g
        .parent
        .as_deref()
        .and_then(|p| groups.iter().find(|x| x.id == p))
    {
        Some(parent) => format!("{} / {}", parent.name, g.name),
        None => g.name.clone(),
    }
}

/// Groups in the tree's order, parents first (the move choices).
pub fn flat(tree: &Tree) -> Vec<&GroupInfo> {
    fn walk<'a>(nodes: &'a [Node], out: &mut Vec<&'a GroupInfo>) {
        for n in nodes {
            out.push(&n.group);
            walk(&n.children, out);
        }
    }
    let mut out = Vec::new();
    walk(&tree.groups, &mut out);
    out
}

/// A word count in a narrow slot (0.1's `formatWordCount`): 521, 1.2k, 12k.
pub fn short_words(n: u64) -> String {
    if n < 1000 {
        n.to_string()
    } else if n < 10_000 {
        format!("{:.1}k", n as f64 / 1000.0)
    } else {
        format!("{}k", (n as f64 / 1000.0).round() as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(id: &str, parent: Option<&str>) -> GroupInfo {
        GroupInfo {
            id: id.into(),
            name: id.to_uppercase(),
            color: None,
            parent: parent.map(Into::into),
        }
    }

    fn idea(id: &str, title: &str, group: Option<&str>) -> IdeaInfo {
        IdeaInfo {
            id: id.into(),
            title: title.into(),
            summary: String::new(),
            status: "drifting".into(),
            group: group.map(Into::into),
            x: 0.0,
            y: 0.0,
            narrative_order: None,
            trashed: false,
        }
    }

    #[test]
    fn the_tree_nests_two_levels_and_keeps_every_idea_in_sight() {
        let groups = [
            g("a", None),
            g("b", Some("a")),
            g("c", Some("b")),    // too deep: top level
            g("d", Some("gone")), // parent gone: top level
            g("e", Some("e")),    // its own parent: top level
        ];
        let ideas = [
            idea("01", "一", Some("a")),
            idea("02", "二", Some("b")),
            idea("03", "三", Some("missing")),
            idea("04", "四", None),
            idea("05", "五", Some("c")),
        ];
        let t = tree(&groups, &ideas, Sort::Created, &HashMap::new());
        let top: Vec<&str> = t.groups.iter().map(|n| n.group.id.as_str()).collect();
        assert_eq!(top, ["a", "d", "e", "c"]);
        let a = &t.groups[0];
        assert_eq!(a.children[0].group.id, "b");
        assert_eq!(a.children[0].depth, 1);
        assert_eq!(a.count, 2, "its own and its sub-group's");
        // Newest first; the idea of a gone group is loose.
        let loose: Vec<&str> = t.loose.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(loose, ["04", "03"]);
        assert_eq!(t.find("c").unwrap().ideas[0].id, "05");
        assert_eq!(t.group_ids().len(), 5);
    }

    #[test]
    fn ideas_sort_by_time_made_changed_or_title() {
        let mut ideas = vec![
            idea("01", "第10条", None),
            idea("02", "第2条", None),
            idea("03", "甲", None),
        ];
        sort_ideas(&mut ideas, Sort::Created, &HashMap::new());
        assert_eq!(ideas[0].id, "03");
        let updated = HashMap::from([("01".to_string(), 50), ("02".to_string(), 10)]);
        sort_ideas(&mut ideas, Sort::Updated, &updated);
        assert_eq!(
            ideas.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            ["01", "02", "03"]
        );
        sort_ideas(&mut ideas, Sort::Title, &HashMap::new());
        assert_eq!(ideas[0].title, "第2条", "numbers by value");
    }

    #[test]
    fn groups_move_only_where_their_levels_fit() {
        let groups = [
            g("a", None),
            g("b", Some("a")),
            g("x", None),
            g("y", None),
            g("z", Some("y")),
        ];
        assert!(
            can_move_group(&groups, "x", Some("a")),
            "a top group under another"
        );
        assert!(
            !can_move_group(&groups, "y", Some("a")),
            "y has a sub-group: three levels"
        );
        assert!(
            !can_move_group(&groups, "x", Some("b")),
            "under a sub-group: three levels"
        );
        assert!(
            !can_move_group(&groups, "a", Some("b")),
            "into its own sub-group"
        );
        assert!(!can_move_group(&groups, "a", Some("a")));
        assert!(can_move_group(&groups, "b", None));
        assert!(can_nest_under(&groups, "a") && !can_nest_under(&groups, "b"));
        assert_eq!(path(&groups, &groups[1]), "A / B");
        assert_eq!(subtree(&groups, "y").len(), 2);
    }

    #[test]
    fn words_read_short() {
        assert_eq!(short_words(521), "521");
        assert_eq!(short_words(1234), "1.2k");
        assert_eq!(short_words(12_400), "12k");
    }
}
