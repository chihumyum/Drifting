//! Off-main-thread snapshot and usage resolution for the v5 asset library
//! (`LibraryPanel`) and file viewer (`MediaPage`).
//!
//! Uses `dr-workspace`'s `asset.list`, `asset.get`, and `asset_folder.list`
//! commands as the single authority for live vs. trashed files and folders
//! (`v5-tracks.md` line 415: a file is in Recently Deleted iff it is absent
//! from `asset.list { trashed: false }`, never by checking `deleted_at` alone).

use std::collections::{HashMap, HashSet};

use dr_doc::v3::BorrowedBookV3;
use dr_model::{id::BookId, v3::ModuleKind};
use dr_shell::book::MaterialInfo;
use dr_store::OpenDoc;
use dr_workspace::{
    Actor, Workspace as Library,
    commands::{
        ListIn,
        asset::{
            AssetFolderInfo, AssetFolderList, AssetFolderListIn, AssetGet, AssetGetIn, AssetInfo,
            AssetList, AssetUsage,
        },
    },
    dto::GroupInfo,
};

/// One resolved usage of a file, ready to render in a hover card's `用在`
/// section or `MediaPage`'s `用在` bar and jump to on click.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedUsage {
    pub entry_id: String,
    pub entry_title: String,
    pub entry_color: Option<String>,
    pub is_chapter: bool,
    pub module_id: Option<String>,
    pub module_name: String,
    /// Keys passed to `dr_shell::pages::UsageFlash::trigger` when jumping here.
    pub flash_keys: Vec<String>,
}

/// One item in the `当前` section at the top of `LibraryPanel`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CurrentItem {
    pub asset_id: String,
    pub module_name: String,
}

#[derive(Clone, Debug)]
pub struct EntryMeta {
    pub title: String,
    pub color: Option<String>,
    pub is_chapter: bool,
    pub modules: Vec<(String, ModuleKind, String)>,
    /// Ordered asset ids per media module (`module_id -> Vec<asset_id>`).
    pub media_assets: HashMap<String, Vec<String>>,
}

/// Complete material-library snapshot for one book.
#[derive(Clone, Debug, Default)]
pub struct LibrarySnapshot {
    pub live_assets: Vec<AssetInfo>,
    pub live_materials: Vec<MaterialInfo>,
    pub live_folders: Vec<GroupInfo>,
    pub trashed_assets: Vec<AssetInfo>,
    pub trashed_folders: Vec<AssetFolderInfo>,
    pub by_id: HashMap<String, AssetInfo>,
    pub usages: HashMap<String, Vec<ResolvedUsage>>,
    pub entries: HashMap<String, EntryMeta>,
}

impl LibrarySnapshot {
    /// Computes the `当前` pinned items for `entry_id` in the entry's template
    /// module order (embeds in prose, items in media modules, image fields,
    /// and relations to live files), deduplicated by file id.
    pub fn current_for_entry(&self, entry_id: &str) -> Vec<CurrentItem> {
        let Some(meta) = self.entries.get(entry_id) else {
            return Vec::new();
        };
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        let mut push = |asset_id: &str, module_name: &str| {
            if self.by_id.contains_key(asset_id) && seen.insert(asset_id.to_owned()) {
                out.push(CurrentItem {
                    asset_id: asset_id.to_owned(),
                    module_name: module_name.to_owned(),
                });
            }
        };

        for (mod_id, kind, label) in &meta.modules {
            match kind {
                ModuleKind::Prose => {
                    for asset in &self.live_assets {
                        if asset.usages.iter().any(|u| {
                            matches!(
                                u,
                                AssetUsage::Embed { entry, module, .. }
                                    if entry == entry_id && module == mod_id
                            )
                        }) {
                            push(&asset.id, label);
                        }
                    }
                }
                ModuleKind::Media => {
                    if let Some(ordered) = meta.media_assets.get(mod_id) {
                        for aid in ordered {
                            push(aid, label);
                        }
                    } else {
                        for asset in &self.live_assets {
                            if asset.usages.iter().any(|u| {
                                matches!(
                                    u,
                                    AssetUsage::Media { entry, module, .. }
                                        if entry == entry_id && module == mod_id
                                )
                            }) {
                                push(&asset.id, label);
                            }
                        }
                    }
                }
                ModuleKind::Fields => {
                    for asset in &self.live_assets {
                        if asset.usages.iter().any(|u| {
                            matches!(
                                u,
                                AssetUsage::Field { entry, module, .. }
                                    if entry == entry_id && module == mod_id
                            )
                        }) {
                            push(&asset.id, label);
                        }
                    }
                }
                _ => {}
            }
        }

        out
    }
}

fn read_entry_metas(lib: &Library, book: &str) -> HashMap<String, EntryMeta> {
    let Ok(book_id) = BookId::parse(book) else {
        return HashMap::new();
    };
    let Ok(doc) = lib
        .library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)
    else {
        return HashMap::new();
    };
    doc.read(move |loro| {
        if !dr_doc::v3::is_book_doc(loro) {
            return HashMap::new();
        }
        let Ok(borrowed) = BorrowedBookV3::new(loro, &book_id) else {
            return HashMap::new();
        };
        let view = borrowed.view();
        let templates = view.templates_map();
        let entries = view.entries();
        let mut manuscript_root: Option<String> = None;
        for e in &entries {
            if e.parent.is_none()
                && e.level
                && let Some(tid) = &e.template
                && let Some(tpl) = templates.get(tid)
                && tpl.modules.is_empty()
                && manuscript_root.is_none()
            {
                manuscript_root = Some(e.id.to_string());
            }
        }

        let mut out = HashMap::new();
        for e in entries {
            let color = e.mark.clone().or_else(|| {
                e.template
                    .as_ref()
                    .and_then(|tid| templates.get(tid))
                    .and_then(|t| t.color.clone())
            });
            let is_chapter = e
                .parent
                .as_ref()
                .is_some_and(|p| manuscript_root.as_deref() == Some(p.as_str()));
            let modules: Vec<(String, ModuleKind, String)> = e
                .template
                .as_ref()
                .and_then(|tid| templates.get(tid))
                .map(|tpl| {
                    let mut specs = tpl.modules.clone();
                    dr_model::v3::sort_modules(&mut specs);
                    specs
                        .into_iter()
                        .map(|m| (m.id.to_string(), m.kind, m.name))
                        .collect()
                })
                .unwrap_or_default();
            let mut media_assets = HashMap::new();
            for (mod_id, items) in &e.media {
                let mut sorted = items.clone();
                sorted.sort_by(|a, b| {
                    dr_model::pos::cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id))
                });
                media_assets.insert(
                    mod_id.to_string(),
                    sorted.into_iter().map(|i| i.asset.to_string()).collect(),
                );
            }
            out.insert(
                e.id.to_string(),
                EntryMeta {
                    title: e.title,
                    color,
                    is_chapter,
                    modules,
                    media_assets,
                },
            );
        }
        out
    })
    .unwrap_or_default()
}

fn resolve_usages_for_asset(
    asset_id: &str,
    raw: &[AssetUsage],
    entries: &HashMap<String, EntryMeta>,
    untitled_label: &str,
) -> Vec<ResolvedUsage> {
    let mut out = Vec::new();
    for u in raw {
        match u {
            AssetUsage::Media {
                entry,
                module,
                item,
            } => {
                let Some(meta) = entries.get(entry) else {
                    continue;
                };
                let mod_name = meta
                    .modules
                    .iter()
                    .find(|(id, _, _)| id == module)
                    .map(|(_, _, n)| n.clone())
                    .unwrap_or_default();
                out.push(ResolvedUsage {
                    entry_id: entry.clone(),
                    entry_title: non_empty(&meta.title, untitled_label),
                    entry_color: meta.color.clone(),
                    is_chapter: meta.is_chapter,
                    module_id: Some(module.clone()),
                    module_name: mod_name,
                    flash_keys: vec![
                        item.clone(),
                        format!("media:{entry}:{module}:{asset_id}"),
                        asset_id.to_owned(),
                    ],
                });
            }
            AssetUsage::Embed {
                entry,
                module,
                block,
            } => {
                let Some(meta) = entries.get(entry) else {
                    continue;
                };
                let mod_name = meta
                    .modules
                    .iter()
                    .find(|(id, _, _)| id == module)
                    .map(|(_, _, n)| n.clone())
                    .unwrap_or_default();
                let mut flash_keys = vec![
                    format!("embed:{entry}:{module}:{asset_id}"),
                    asset_id.to_owned(),
                ];
                if let Some(b) = block {
                    flash_keys.push(b.clone());
                    flash_keys.push(format!("embed:{entry}:{module}:{b}"));
                }
                out.push(ResolvedUsage {
                    entry_id: entry.clone(),
                    entry_title: non_empty(&meta.title, untitled_label),
                    entry_color: meta.color.clone(),
                    is_chapter: meta.is_chapter,
                    module_id: Some(module.clone()),
                    module_name: mod_name,
                    flash_keys,
                });
            }
            AssetUsage::Link {
                entry,
                module,
                block,
            } => {
                let Some(meta) = entries.get(entry) else {
                    continue;
                };
                let mod_name = meta
                    .modules
                    .iter()
                    .find(|(id, _, _)| id == module)
                    .map(|(_, _, n)| n.clone())
                    .unwrap_or_default();
                let mut flash_keys = vec![
                    format!("link:{entry}:{module}:{asset_id}"),
                    asset_id.to_owned(),
                ];
                if let Some(b) = block {
                    flash_keys.push(b.clone());
                }
                out.push(ResolvedUsage {
                    entry_id: entry.clone(),
                    entry_title: non_empty(&meta.title, untitled_label),
                    entry_color: meta.color.clone(),
                    is_chapter: meta.is_chapter,
                    module_id: Some(module.clone()),
                    module_name: mod_name,
                    flash_keys,
                });
            }
            AssetUsage::Field {
                entry,
                module,
                field,
            } => {
                let Some(meta) = entries.get(entry) else {
                    continue;
                };
                let mod_name = meta
                    .modules
                    .iter()
                    .find(|(id, _, _)| id == module)
                    .map(|(_, _, n)| n.clone())
                    .unwrap_or_default();
                out.push(ResolvedUsage {
                    entry_id: entry.clone(),
                    entry_title: non_empty(&meta.title, untitled_label),
                    entry_color: meta.color.clone(),
                    is_chapter: meta.is_chapter,
                    module_id: Some(module.clone()),
                    module_name: mod_name,
                    flash_keys: vec![
                        format!("field:{entry}:{module}:{field}"),
                        field.clone(),
                        asset_id.to_owned(),
                    ],
                });
            }

        }
    }
    out
}

fn non_empty(s: &str, fallback: &str) -> String {
    if s.trim().is_empty() {
        fallback.to_owned()
    } else {
        s.to_owned()
    }
}

/// Loads the complete live + trashed library snapshot for `book`.
pub fn load_snapshot(
    lib: &Library,
    book: &str,
    untitled_label: &str,
) -> Result<LibrarySnapshot, String> {
    let live_assets = lib
        .run::<AssetList>(
            &Actor::User,
            ListIn {
                book: book.to_owned(),
                trashed: false,
            },
        )
        .map_err(|e| e.to_string())?
        .output;
    let all_assets = lib
        .run::<AssetList>(
            &Actor::User,
            ListIn {
                book: book.to_owned(),
                trashed: true,
            },
        )
        .map_err(|e| e.to_string())?
        .output;
    let live_folders_raw = lib
        .run::<AssetFolderList>(
            &Actor::User,
            AssetFolderListIn {
                book: book.to_owned(),
                trashed: false,
            },
        )
        .map_err(|e| e.to_string())?
        .output;
    let all_folders_raw = lib
        .run::<AssetFolderList>(
            &Actor::User,
            AssetFolderListIn {
                book: book.to_owned(),
                trashed: true,
            },
        )
        .map_err(|e| e.to_string())?
        .output;

    let live_asset_ids: HashSet<String> = live_assets.iter().map(|a| a.id.clone()).collect();
    let live_folder_ids: HashSet<String> = live_folders_raw.iter().map(|f| f.id.clone()).collect();

    // `v5-tracks.md` line 415: a file is in Recently Deleted iff it is absent
    // from `asset.list { trashed: false }`.
    let trashed_assets: Vec<AssetInfo> = all_assets
        .into_iter()
        .filter(|a| !live_asset_ids.contains(&a.id))
        .collect();
    let trashed_folders: Vec<AssetFolderInfo> = all_folders_raw
        .into_iter()
        .filter(|f| !live_folder_ids.contains(&f.id))
        .collect();

    let live_folders: Vec<GroupInfo> = live_folders_raw
        .into_iter()
        .map(|f| GroupInfo {
            id: f.id,
            name: f.name,
            color: None,
            parent: f.parent,
        })
        .collect();

    let live_materials: Vec<MaterialInfo> = live_assets
        .iter()
        .map(|a| MaterialInfo {
            id: a.id.clone(),
            title: a.name.clone(),
            kind: a.kind.clone(),
            asset: Some(a.id.clone()),
            folder: a.folder.clone(),
            pos: a.pos.clone(),
            task_todos: false,
            description: String::new(),
            entry: None,
            module: None,
        })
        .collect();

    let entries = read_entry_metas(lib, book);
    let mut by_id = HashMap::with_capacity(live_assets.len());
    let mut usages = HashMap::with_capacity(live_assets.len());
    for a in &live_assets {
        usages.insert(
            a.id.clone(),
            resolve_usages_for_asset(&a.id, &a.usages, &entries, untitled_label),
        );
        by_id.insert(a.id.clone(), a.clone());
    }

    Ok(LibrarySnapshot {
        live_assets,
        live_materials,
        live_folders,
        trashed_assets,
        trashed_folders,
        by_id,
        usages,
        entries,
    })
}

/// Loads resolved usages for a single file (`MediaPage`'s `用在` bar).
pub fn load_asset_usages(
    lib: &Library,
    book: &str,
    asset_id: &str,
    untitled_label: &str,
) -> Vec<ResolvedUsage> {
    let Ok(out) = lib.run::<AssetGet>(
        &Actor::User,
        AssetGetIn {
            book: book.to_owned(),
            id: asset_id.to_owned(),
            usages: true,
        },
    ) else {
        return Vec::new();
    };
    let entries = read_entry_metas(lib, book);
    resolve_usages_for_asset(
        asset_id,
        &out.output.usages,
        &entries,
        untitled_label,
    )
}
