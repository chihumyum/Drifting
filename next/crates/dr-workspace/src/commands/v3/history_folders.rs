//! Selected material-folder restoration; shares the book commit with map records.
use super::*;
use dr_doc::v3::{BookTxnV3, BookViewV3, EntrySnapshotV3};
use dr_model::id::MaterialFolderId;

pub(super) struct FolderPlan {
    id: MaterialFolderId,
    parent: Option<MaterialFolderId>,
    siblings: Vec<MaterialFolderId>,
    snapshot: Option<EntrySnapshotV3>,
}

pub(super) fn plan(
    old: &BookViewV3<'_>,
    current: &BookViewV3<'_>,
    targets: &[history::Key],
) -> Result<Vec<FolderPlan>> {
    let old_folders = old.material_folders();
    let mut desired: BTreeMap<_, _> = current
        .material_folders()
        .into_iter()
        .map(|f| (f.id.clone(), f))
        .collect();
    let selected: BTreeSet<MaterialFolderId> = targets
        .iter()
        .filter(|k| k.collection == "material_folders")
        .map(|k| pid("material folder", &k.id))
        .collect::<Result<_>>()?;
    if selected.is_empty() {
        return Ok(Vec::new());
    }
    for id in &selected {
        if let Some(f) = old_folders.iter().find(|f| &f.id == id) {
            desired.insert(id.clone(), f.clone());
        } else {
            desired.remove(id);
        }
    }
    // Missing historical parents fall back to root, as for entry restoration.
    let present: BTreeSet<_> = desired.keys().cloned().collect();
    for id in &selected {
        if let Some(f) = desired.get_mut(id) {
            f.parent = f.parent.take().filter(|p| present.contains(p));
        }
    }
    for f in desired.values() {
        let mut cursor = Some(&f.id);
        let mut seen = BTreeSet::new();
        while let Some(id) = cursor {
            if !seen.insert(id) {
                return Err(WsError::invalid("folder restoration would create a cycle"));
            }
            let node = desired.get(id).ok_or_else(|| {
                WsError::invalid("folder restoration would move an unselected child")
            })?;
            cursor = node.parent.as_ref();
        }
    }
    // Deleting a folder must not implicitly rewrite an unselected material.
    for material in current.materials() {
        if material
            .folder
            .as_ref()
            .is_some_and(|f| selected.contains(f) && !present.contains(f))
            && !targets
                .iter()
                .any(|k| k.collection == "materials" && k.id == material.id.as_str())
        {
            return Err(WsError::invalid(
                "folder restoration would move an unselected material",
            ));
        }
    }
    let depth = |f: &MaterialFolderId| {
        let mut n = 0;
        let mut parent = desired.get(f).and_then(|f| f.parent.as_ref());
        while let Some(p) = parent {
            n += 1;
            parent = desired.get(p).and_then(|f| f.parent.as_ref());
        }
        n
    };
    let mut plans: Vec<_> = selected
        .into_iter()
        .map(|id| {
            let parent = desired.get(&id).and_then(|f| f.parent.clone());
            let siblings = old_folders
                .iter()
                .filter(|f| f.parent == parent)
                .map(|f| f.id.clone())
                .collect();
            FolderPlan {
                snapshot: old.material_folder_snapshot(&id),
                id,
                parent,
                siblings,
            }
        })
        .collect();
    plans.sort_by_key(|p| {
        (
            depth(&p.id),
            p.siblings.iter().position(|id| id == &p.id).unwrap_or(0),
        )
    });
    Ok(plans)
}

pub(super) fn apply(txn: &mut BookTxnV3<'_>, plans: &[FolderPlan]) -> Result<()> {
    for p in plans {
        if let Some(snapshot) = &p.snapshot {
            txn.restore_material_folder(&p.id, None, snapshot)?;
        }
    }
    for p in plans {
        if p.snapshot.is_none() && txn.view().material_folder_snapshot(&p.id).is_some() {
            txn.delete_material_folder(&p.id)?;
        }
    }
    for p in plans.iter().filter(|p| p.snapshot.is_some()) {
        let siblings: Vec<_> = txn
            .view()
            .material_folders()
            .into_iter()
            .filter(|f| f.parent == p.parent && f.id != p.id)
            .map(|f| f.id)
            .collect();
        let old_index = p.siblings.iter().position(|id| id == &p.id).unwrap_or(0);
        let before = p.siblings[..old_index]
            .iter()
            .rev()
            .find_map(|id| siblings.iter().position(|s| s == id).map(|i| i + 1));
        let after = p
            .siblings
            .iter()
            .skip(old_index + 1)
            .find_map(|id| siblings.iter().position(|s| s == id));
        let index = before.or(after).unwrap_or(old_index.min(siblings.len()));
        txn.move_material_folder_to_at(&p.id, p.parent.as_ref(), index)?;
    }
    Ok(())
}
