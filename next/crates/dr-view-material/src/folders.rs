//! Material folders (素材夹) as a tree, and what can be done to them (the
//! 0.1 client's `MaterialFolderTree` model and `useMaterialFolder`).
//!
//! - The root has no row. Under each folder: its sub-folders, then its
//!   materials. Folders by name, materials titled first, then by title
//!   (numbers by value), then by id (UUID v7: the order they were made in).
//!   A material whose folder is gone shows at the root.
//! - A folder row counts every material below it. While a filter narrows
//!   the list, folders holding none of what is shown are left out.
//! - A selection is materials and folders together. A click selects one; ⌘
//!   adds or takes away one; ⇧ takes the run from the last plain or ⌘
//!   click. An action on a row that is part of a selection of two or more
//!   acts on the whole selection.
//! - A folder never moves into itself or below itself; moving there leaves
//!   it where it is.
//!
//! The commands ([`move_to`], [`create_folder`], [`rename_folder`],
//! [`rename_material`], [`delete`]) run F3's material commands as the
//! author, each its own undo step; call them off the main thread.
//!
//! Public for M23 (审阅与素材): [`Tree`], [`Selection`], [`Picker`] and the
//! commands are the folder interface the Super View uses.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use dr_workspace::commands::EntityIn;
use dr_workspace::commands::material::{
    FolderCreate, FolderCreateIn, FolderDelete, FolderUpdate, FolderUpdateIn, MaterialDelete,
    MaterialUpdate, MaterialUpdateIn,
};
use dr_workspace::dto::{GroupInfo, MaterialInfo};
use dr_workspace::{Actor, Workspace as Library};

/// A folder row's key.
pub fn folder_key(id: &str) -> String {
    format!("f:{id}")
}

/// A material row's key.
pub fn material_key(id: &str) -> String {
    format!("i:{id}")
}

/// Materials and folders, by id.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Selection {
    pub materials: Vec<String>,
    pub folders: Vec<String>,
}

impl Selection {
    /// The selection of row keys (`f:` folders, `i:` materials).
    pub fn of(keys: &[String]) -> Selection {
        let mut s = Selection::default();
        for k in keys {
            if let Some(id) = k.strip_prefix("f:") {
                s.folders.push(id.to_owned());
            } else if let Some(id) = k.strip_prefix("i:") {
                s.materials.push(id.to_owned());
            }
        }
        s
    }

    pub fn material(id: &str) -> Selection {
        Selection {
            materials: vec![id.to_owned()],
            folders: Vec::new(),
        }
    }

    pub fn folder(id: &str) -> Selection {
        Selection {
            materials: Vec::new(),
            folders: vec![id.to_owned()],
        }
    }

    pub fn len(&self) -> usize {
        self.materials.len() + self.folders.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// One row of the tree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Entry {
    Folder {
        id: String,
        name: String,
        depth: usize,
        open: bool,
        /// Materials anywhere below it.
        count: usize,
    },
    Material {
        id: String,
        depth: usize,
    },
}

impl Entry {
    pub fn key(&self) -> String {
        match self {
            Entry::Folder { id, .. } => folder_key(id),
            Entry::Material { id, .. } => material_key(id),
        }
    }

    pub fn depth(&self) -> usize {
        match self {
            Entry::Folder { depth, .. } | Entry::Material { depth, .. } => *depth,
        }
    }
}

/// Somewhere a selection can move to: the root (`None`) or a folder, with
/// its path (「旧城 / 街区」).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    pub folder: Option<String>,
    pub path: String,
    /// Where the moved thing is now (shown, not offered).
    pub current: bool,
}

/// Strings in reading order, numbers by value (「第2章」 before 「第10章」),
/// case aside.
pub fn natural(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let mut m = String::new();
                while let Some(c) = x.peek().copied().filter(char::is_ascii_digit) {
                    m.push(c);
                    x.next();
                }
                let mut n = String::new();
                while let Some(d) = y.peek().copied().filter(char::is_ascii_digit) {
                    n.push(d);
                    y.next();
                }
                let (m, n) = (m.trim_start_matches('0'), n.trim_start_matches('0'));
                let o = m.len().cmp(&n.len()).then_with(|| m.cmp(n));
                if o != Ordering::Equal {
                    return o;
                }
            }
            (Some(c), Some(d)) => {
                let o = c.to_lowercase().cmp(d.to_lowercase());
                if o != Ordering::Equal {
                    return o;
                }
                x.next();
                y.next();
            }
        }
    }
}

fn material_order(a: &MaterialInfo, b: &MaterialInfo) -> Ordering {
    let (ta, tb) = (a.title.trim(), b.title.trim());
    // Titled first (false before true), then by title, then by id.
    ta.is_empty()
        .cmp(&tb.is_empty())
        .then_with(|| natural(ta, tb))
        .then_with(|| a.id.cmp(&b.id))
}

/// The folders and materials of a book, arranged.
pub struct Tree<'a> {
    folders: HashMap<&'a str, &'a GroupInfo>,
    children: HashMap<Option<&'a str>, Vec<&'a GroupInfo>>,
    materials: HashMap<Option<&'a str>, Vec<&'a MaterialInfo>>,
    totals: HashMap<&'a str, usize>,
}

impl<'a> Tree<'a> {
    /// The tree of `folders` and `materials`; with `only`, of those
    /// materials alone.
    pub fn new(
        folders: &'a [GroupInfo],
        materials: &'a [MaterialInfo],
        only: Option<&HashSet<String>>,
    ) -> Tree<'a> {
        let by_id: HashMap<&str, &GroupInfo> = folders.iter().map(|f| (f.id.as_str(), f)).collect();
        let mut children: HashMap<Option<&str>, Vec<&GroupInfo>> = HashMap::new();
        for f in folders {
            // A parent that is gone (or a cycle a sync left) puts it at the root.
            let parent = f
                .parent
                .as_deref()
                .filter(|p| by_id.contains_key(p) && !reaches(&by_id, p, &f.id));
            children.entry(parent).or_default().push(f);
        }
        for list in children.values_mut() {
            list.sort_by(|a, b| natural(&a.name, &b.name).then_with(|| a.id.cmp(&b.id)));
        }
        let mut by_folder: HashMap<Option<&str>, Vec<&MaterialInfo>> = HashMap::new();
        for m in materials {
            if only.is_some_and(|o| !o.contains(&m.id)) {
                continue;
            }
            let folder = m.folder.as_deref().filter(|f| by_id.contains_key(f));
            by_folder.entry(folder).or_default().push(m);
        }
        for list in by_folder.values_mut() {
            list.sort_by(|a, b| material_order(a, b));
        }
        let mut tree = Tree {
            folders: by_id,
            children,
            materials: by_folder,
            totals: HashMap::new(),
        };
        tree.count(None);
        tree
    }

    fn count(&mut self, key: Option<&'a str>) -> usize {
        let mut total = self.materials.get(&key).map_or(0, Vec::len);
        let kids: Vec<&'a str> = self
            .children
            .get(&key)
            .map(|v| v.iter().map(|f| f.id.as_str()).collect())
            .unwrap_or_default();
        for k in kids {
            total += self.count(Some(k));
        }
        if let Some(k) = key {
            self.totals.insert(k, total);
        }
        total
    }

    /// Materials anywhere below `folder`.
    pub fn total(&self, folder: &str) -> usize {
        self.totals.get(folder).copied().unwrap_or(0)
    }

    /// The rows, open folders unfolded; `narrowed`: folders holding none of
    /// the shown materials are left out.
    pub fn entries(&self, expanded: &HashSet<String>, narrowed: bool) -> Vec<Entry> {
        let mut out = Vec::new();
        self.walk(None, 0, expanded, narrowed, &mut out);
        out
    }

    fn walk(
        &self,
        key: Option<&str>,
        depth: usize,
        expanded: &HashSet<String>,
        narrowed: bool,
        out: &mut Vec<Entry>,
    ) {
        for f in self.children.get(&key).into_iter().flatten() {
            let count = self.total(&f.id);
            if narrowed && count == 0 {
                continue;
            }
            let open = expanded.contains(&f.id);
            out.push(Entry::Folder {
                id: f.id.clone(),
                name: f.name.clone(),
                depth,
                open,
                count,
            });
            if open {
                self.walk(Some(&f.id), depth + 1, expanded, narrowed, out);
            }
        }
        for m in self.materials.get(&key).into_iter().flatten() {
            out.push(Entry::Material {
                id: m.id.clone(),
                depth,
            });
        }
    }

    /// `folder` and every folder below it.
    pub fn subtree(&self, folder: &str) -> Vec<String> {
        let mut out = vec![folder.to_owned()];
        for f in self.children.get(&Some(folder)).into_iter().flatten() {
            out.extend(self.subtree(&f.id));
        }
        out
    }

    /// Whether `folder` is `ancestor` or lies below it.
    pub fn within(&self, folder: &str, ancestor: &str) -> bool {
        reaches(&self.folders, folder, ancestor)
    }

    pub fn has_folder(&self, id: &str) -> bool {
        self.folders.contains_key(id)
    }

    /// `folder`'s path from the root: 「旧城 / 街区」.
    pub fn path(&self, folder: &str) -> String {
        let mut names = Vec::new();
        let mut at = Some(folder);
        let mut seen = HashSet::new();
        while let Some(id) = at {
            if !seen.insert(id) {
                break;
            }
            let Some(f) = self.folders.get(id) else {
                break;
            };
            names.push(f.name.as_str());
            at = f.parent.as_deref();
        }
        names.reverse();
        names.join(" / ")
    }

    /// Where `moving` can go, from `current`: the root, then every folder
    /// by its path, depth first; never a moving folder or anything below it.
    pub fn choices(&self, moving: &Selection, current: Option<&str>, root: &str) -> Vec<Choice> {
        let mut out = vec![Choice {
            folder: None,
            path: root.to_owned(),
            current: current.is_none(),
        }];
        self.choose(None, moving, current, &mut out);
        out
    }

    fn choose(
        &self,
        key: Option<&str>,
        moving: &Selection,
        current: Option<&str>,
        out: &mut Vec<Choice>,
    ) {
        for f in self.children.get(&key).into_iter().flatten() {
            if moving.folders.iter().any(|m| self.within(&f.id, m)) {
                continue;
            }
            out.push(Choice {
                folder: Some(f.id.clone()),
                path: self.path(&f.id),
                current: current == Some(f.id.as_str()),
            });
            self.choose(Some(&f.id), moving, current, out);
        }
    }
}

/// Whether walking up from `from` meets `to` (or `from` is `to`).
fn reaches(folders: &HashMap<&str, &GroupInfo>, from: &str, to: &str) -> bool {
    let mut at = Some(from);
    let mut seen = HashSet::new();
    while let Some(id) = at {
        if id == to {
            return true;
        }
        if !seen.insert(id.to_owned()) {
            return false;
        }
        at = folders.get(id).and_then(|f| f.parent.as_deref());
    }
    false
}

/// The rows selected, and the last row clicked plainly or with ⌘.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Picker {
    pub selected: Vec<String>,
    pub anchor: Option<String>,
}

impl Picker {
    /// A click on row `key` among `order` (the rows as shown). ⌘ adds or
    /// takes it away; ⇧ takes the run from the anchor; a plain click keeps
    /// only it and says so (the row then also acts: opens or folds).
    pub fn click(&mut self, key: &str, command: bool, shift: bool, order: &[String]) -> bool {
        if command {
            if let Some(i) = self.selected.iter().position(|k| k == key) {
                self.selected.remove(i);
            } else {
                self.selected.push(key.to_owned());
            }
            self.anchor = Some(key.to_owned());
            return false;
        }
        if shift
            && let Some(anchor) = &self.anchor
            && let (Some(a), Some(b)) = (
                order.iter().position(|k| k == anchor),
                order.iter().position(|k| k == key),
            )
        {
            self.selected = order[a.min(b)..=a.max(b)].to_vec();
            return false;
        }
        self.selected = vec![key.to_owned()];
        self.anchor = Some(key.to_owned());
        true
    }

    pub fn all(&mut self, order: &[String]) {
        self.selected = order.to_vec();
    }

    pub fn clear(&mut self) {
        self.selected.clear();
    }

    pub fn is_selected(&self, key: &str) -> bool {
        self.selected.iter().any(|k| k == key)
    }

    /// What an action on row `key` acts on: the whole selection when the
    /// row is part of one of two or more, else the row alone.
    pub fn target(&self, key: &str) -> Selection {
        if self.selected.len() > 1 && self.is_selected(key) {
            Selection::of(&self.selected)
        } else {
            Selection::of(&[key.to_owned()])
        }
    }

    /// Drops rows that are no longer shown.
    pub fn keep(&mut self, order: &[String]) {
        self.selected.retain(|k| order.contains(k));
    }
}

fn run<O: dr_workspace::Op>(lib: &Library, input: O::Input) -> Result<O::Output, String> {
    lib.run::<O>(&Actor::User, input)
        .map(|o| o.output)
        .map_err(|e| e.to_string())
}

/// Moves `sel` into `folder` (`None`: the root): the materials first, then
/// the folders (a folder never into itself or below itself).
pub fn move_to(
    lib: &Library,
    book: &str,
    sel: &Selection,
    folder: Option<&str>,
) -> Result<(), String> {
    for id in &sel.materials {
        run::<MaterialUpdate>(
            lib,
            MaterialUpdateIn {
                book: book.to_owned(),
                id: id.clone(),
                folder: Some(folder.map(str::to_owned)),
                ..Default::default()
            },
        )?;
    }
    for id in &sel.folders {
        if Some(id.as_str()) == folder {
            continue;
        }
        let result = run::<FolderUpdate>(
            lib,
            FolderUpdateIn {
                book: book.to_owned(),
                id: id.clone(),
                name: None,
                parent: Some(folder.map(str::to_owned)),
            },
        );
        // Into its own subtree: F3 refuses; it stays where it is.
        if let Err(e) = result {
            log::info!("material: folder {id} stays: {e}");
        }
    }
    Ok(())
}

/// A new folder `name` in `parent` (`None`: the root); its id.
pub fn create_folder(
    lib: &Library,
    book: &str,
    name: &str,
    parent: Option<&str>,
) -> Result<String, String> {
    run::<FolderCreate>(
        lib,
        FolderCreateIn {
            book: book.to_owned(),
            name: name.to_owned(),
            parent: parent.map(str::to_owned),
        },
    )
    .map(|n| n.id)
}

pub fn rename_folder(lib: &Library, book: &str, id: &str, name: &str) -> Result<(), String> {
    run::<FolderUpdate>(
        lib,
        FolderUpdateIn {
            book: book.to_owned(),
            id: id.to_owned(),
            name: Some(name.to_owned()),
            parent: None,
        },
    )
    .map(|_| ())
}

pub fn rename_material(lib: &Library, book: &str, id: &str, title: &str) -> Result<(), String> {
    run::<MaterialUpdate>(
        lib,
        MaterialUpdateIn {
            book: book.to_owned(),
            id: id.to_owned(),
            title: Some(title.to_owned()),
            ..Default::default()
        },
    )
    .map(|_| ())
}

/// Deletes `sel`: the materials first, then the folders (whatever is left
/// in a deleted folder moves up to its parent).
pub fn delete(lib: &Library, book: &str, sel: &Selection) -> Result<(), String> {
    for id in &sel.materials {
        run::<MaterialDelete>(
            lib,
            EntityIn {
                book: book.to_owned(),
                id: id.clone(),
            },
        )?;
    }
    for id in &sel.folders {
        run::<FolderDelete>(
            lib,
            EntityIn {
                book: book.to_owned(),
                id: id.clone(),
            },
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(id: &str, name: &str, parent: Option<&str>) -> GroupInfo {
        GroupInfo {
            id: id.into(),
            name: name.into(),
            color: None,
            parent: parent.map(Into::into),
        }
    }

    fn material(id: &str, title: &str, folder: Option<&str>) -> MaterialInfo {
        MaterialInfo {
            id: id.into(),
            title: title.into(),
            kind: "image".into(),
            asset: None,
            folder: folder.map(Into::into),
            pos: None,
            task_todos: false,
            description: String::new(),
        }
    }

    fn keys(entries: &[Entry]) -> Vec<String> {
        entries.iter().map(Entry::key).collect()
    }

    #[test]
    fn numbers_read_by_value() {
        assert_eq!(natural("第2章", "第10章"), Ordering::Less);
        assert_eq!(natural("Map b", "map A"), Ordering::Greater);
        assert_eq!(natural("a01", "a1"), Ordering::Equal);
    }

    #[test]
    fn folders_then_materials_and_counts_below() {
        let folders = vec![
            folder("f2", "旧城", None),
            folder("f1", "地图", None),
            folder("f3", "街区", Some("f2")),
            folder("gone-child", "孤儿", Some("nowhere")),
        ];
        let materials = vec![
            material("m3", "", None),
            material("m2", "图10", None),
            material("m1", "图2", None),
            material("m4", "巷口", Some("f3")),
            material("m5", "城墙", Some("f2")),
            material("m6", "没了的夹", Some("deleted")),
        ];
        let tree = Tree::new(&folders, &materials, None);
        assert_eq!(tree.total("f2"), 2, "its own and its sub-folder's");
        assert_eq!(tree.total("f3"), 1);
        let closed = tree.entries(&HashSet::new(), false);
        // Folders by name (地 before 孤 before 旧 by code point), then the
        // root's materials: titled first, numbers by value, the untitled
        // last; a material whose folder is gone shows at the root.
        assert_eq!(
            keys(&closed),
            [
                "f:f1",
                "f:gone-child",
                "f:f2",
                "i:m1",
                "i:m2",
                "i:m6",
                "i:m3"
            ]
        );
        let open: HashSet<String> = ["f2".into(), "f3".into()].into();
        let entries = tree.entries(&open, false);
        assert_eq!(
            keys(&entries),
            [
                "f:f1",
                "f:gone-child",
                "f:f2",
                "f:f3",
                "i:m4",
                "i:m5",
                "i:m1",
                "i:m2",
                "i:m6",
                "i:m3"
            ]
        );
        assert_eq!(entries[3].depth(), 1);
        assert_eq!(entries[4].depth(), 2);
        // Narrowed to one material: only the folders on its way.
        let only: HashSet<String> = ["m4".into()].into();
        let narrowed = Tree::new(&folders, &materials, Some(&only));
        assert_eq!(
            keys(&narrowed.entries(&open, true)),
            ["f:f2", "f:f3", "i:m4"]
        );
    }

    #[test]
    fn a_folder_never_moves_into_itself() {
        let folders = vec![
            folder("a", "甲", None),
            folder("b", "乙", Some("a")),
            folder("c", "丙", Some("b")),
            folder("d", "丁", None),
        ];
        let tree = Tree::new(&folders, &[], None);
        assert!(tree.within("c", "a") && !tree.within("a", "c"));
        assert_eq!(tree.path("c"), "甲 / 乙 / 丙");
        assert_eq!(tree.subtree("a"), ["a", "b", "c"]);
        let choices = tree.choices(&Selection::folder("b"), Some("a"), "素材库");
        let to: Vec<Option<&str>> = choices.iter().map(|c| c.folder.as_deref()).collect();
        // 丁 sorts before 甲 by code point; b and c are left out.
        assert_eq!(to, [None, Some("d"), Some("a")]);
        assert!(
            choices
                .iter()
                .find(|c| c.folder.as_deref() == Some("a"))
                .unwrap()
                .current
        );
        assert_eq!(choices[0].path, "素材库");
    }

    #[test]
    fn clicks_select_one_toggle_or_take_a_run() {
        let order: Vec<String> = ["f:a", "i:1", "i:2", "i:3"].map(String::from).to_vec();
        let mut p = Picker::default();
        assert!(p.click("i:1", false, false, &order), "a plain click acts");
        assert!(!p.click("i:3", true, false, &order));
        assert_eq!(p.selected, ["i:1", "i:3"]);
        assert_eq!(p.target("i:3"), Selection::of(&p.selected));
        assert_eq!(p.target("i:2"), Selection::material("2"), "not part of it");
        assert!(!p.click("f:a", false, true, &order));
        assert_eq!(
            p.selected,
            ["f:a", "i:1", "i:2", "i:3"],
            "the run from the anchor"
        );
        let sel = Selection::of(&p.selected);
        assert_eq!((sel.folders.len(), sel.materials.len()), (1, 3));
        p.click("i:1", true, false, &order);
        assert!(!p.is_selected("i:1"));
        p.keep(&order[..2]);
        assert_eq!(p.selected, ["f:a"]);
        p.all(&order);
        assert_eq!(p.selected.len(), 4);
        p.clear();
        assert!(p.selected.is_empty());
    }
}
