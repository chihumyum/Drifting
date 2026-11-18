//! Entry-page `media` module (`kernel-v5.md` §10, `v5-tracks.md` line 400).
//!
//! Renders an entry's ordered media items in `featured` (`大图`), `grid` (`网格`),
//! or `list` (`列表`) layout, with a hover-revealed header toolbar, inline
//! captions (`说明` placeholder only on hover/edit), a `248px` hover card
//! (`打开`, `在素材库里找到`, `从这里拿走`), grip drag-and-drop reorder,
//! `MEDIA-ASSET-ONCE` drops from the library or OS files, `.gone` dashed
//! placeholders with folder-trash-aware `恢复`, and `UsageFlash` sand frames.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    rc::Rc,
};

use dr_i18n::keys;
use dr_model::{
    id::{AssetFolderId, AssetId, MediaItemId},
    kind::AssetKind,
    pos::PosKey,
};
use dr_shell::{
    book::Book,
    nav::{Open, Target as NavTarget},
    pages::UsageFlash,
    strings::{t, tf, tp},
    v3::{ModuleHost, Rendered},
};
use dr_store::asset::Variant;
use dr_ui::{
    AssetDrag, Theme,
    components::{
        Button, HoverCard, IconButton,
        hover_card::{CardAction, CardBody},
        menu::{RowIcon, float_shadow, slab_edge},
    },
    fonts::{Role, weight},
    glass::{self, Kind as GlassKind, Mode, Spec, Tone},
    input::{FieldEvent, TextField},
    sand::{self, Icon, SandFrame},
    style::DrStyled,
    tokens::{glass as g, menu as m_tok, radius},
};
use dr_workspace::{
    Actor,
    commands::{
        EntityIn, ListIn,
        asset::{
            AssetFolderInfo, AssetFolderList, AssetFolderListIn, AssetFolderRestore, AssetInfo,
            AssetList, AssetRestore,
        },
        v3::{
            module::{
                In as ModuleIn, MediaArrange, MediaArrangeIn, MediaPut, MediaPutIn, MediaRemove,
                MediaRemoveIn, ModuleRead,
            },
            types::MediaItem,
        },
    },
    events::WsEvent,
};
use gpui::{
    AnyElement, App, AppContext as _, ClickEvent, Context, ElementId, Entity, ExternalPaths,
    Focusable as _, InteractiveElement as _, IntoElement, ObjectFit, ParentElement as _,
    PathPromptOptions, Render, SharedString, StatefulInteractiveElement as _, Styled as _,
    StyledImage as _, Subscription, Task, Window, anchored, deferred, div, img,
    prelude::FluentBuilder as _, px,
};

pub fn register(cx: &mut App) {
    dr_shell::v3::add_module_view(cx, "media", |host, window, cx| {
        let view = cx.new(|cx| MediaModule::new(host, window, cx));
        let weak = view.downgrade();
        Rendered::new(view).on_refresh(move |book, cx| {
            weak.update(cx, |v, cx| v.refresh(book, cx)).ok();
        })
    });
}

#[derive(Clone, Debug)]
pub struct AssetMeta {
    pub id: String,
    pub name: String,
    pub kind: AssetKind,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub pages: Option<usize>,
    pub thumb: Option<PathBuf>,
    pub display: Option<PathBuf>,
    pub trashed: bool,
    /// Trashed ancestor folder ids (outermost to innermost) + whether the asset
    /// itself has `deleted_at.is_some()`. Empty and `trashed == true` means
    /// purged/missing from `assets_raw`.
    pub restorable_in_book: bool,
    pub trashed_folders: Vec<String>,
    pub self_trashed: bool,
}

#[derive(Clone, Debug)]
struct ReorderDrag {
    module_key: String,
    item_id: String,
    label: SharedString,
}

struct ReorderGhost {
    label: SharedString,
}

impl Render for ReorderGhost {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        div()
            .px(px(10.0))
            .py(px(4.0))
            .rounded(px(radius::SM))
            .bg(p.page.solid())
            .border_1()
            .border_color(p.hairline())
            .shadow_md()
            .font_role(Role::Ui)
            .type_px(s.secondary, s.line_body)
            .text_color(p.ink(1).solid())
            .child(self.label.clone())
    }
}

struct CaptionDraft {
    item_id: String,
    field: Entity<TextField>,
    _sub: Subscription,
}

#[derive(Clone, Debug, Default)]
struct PickerData {
    assets: Vec<AssetInfo>,
    folders: Vec<AssetFolderInfo>,
    thumbs: HashMap<String, PathBuf>,
}

pub struct MediaModule {
    host: ModuleHost,
    items: Vec<MediaItem>,
    arrangement: String,
    own_arrangement: bool,
    meta: HashMap<String, AssetMeta>,
    featured_id: Option<String>,
    hovered_module: bool,
    hovered_item: Option<String>,
    caption_edit: Option<CaptionDraft>,
    add_menu_open: bool,
    picker_open: bool,
    picker_folder: Option<String>,
    picker_search: Entity<TextField>,
    picker_query: String,
    picker_data: Option<PickerData>,
    picker_task: Option<Task<()>>,
    reading: bool,
    stale: bool,
    writing: usize,
    _search_sub: Subscription,
    _bus: Option<dr_workspace::events::Subscription>,
    _bus_task: Option<Task<()>>,
}

impl MediaModule {
    pub fn new(host: ModuleHost, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let find_ph = t(cx, keys::v5_files::FIND_FILE);
        let search_id = format!("media-pick-search-{}-{}", host.entry, host.module.id);
        let picker_search = cx.new(|cx| {
            TextField::new(ElementId::Name(search_id.into()), window, cx)
                .small()
                .placeholder(find_ph)
        });
        let search_sub = cx.subscribe_in(
            &picker_search,
            window,
            |this, field, e: &FieldEvent, _, cx| match e {
                FieldEvent::Changed(q) => {
                    this.picker_query = q.clone();
                    cx.notify();
                }
                FieldEvent::Cancelled => {
                    if !field.read(cx).text().is_empty() {
                        field.update(cx, |f, cx| f.set_text(String::new(), cx));
                        this.picker_query.clear();
                    } else {
                        this.picker_open = false;
                    }
                    cx.notify();
                }
                FieldEvent::Submitted(_) | FieldEvent::Blurred => {}
            },
        );

        let (tx, mut rx) = futures::channel::mpsc::unbounded::<()>();
        let watched_book = host.page.book_id.clone();
        let bus = host.page.library.subscribe(move |ev| {
            if let WsEvent::Book(b) = ev
                && b.book.as_str() == watched_book
            {
                let _ = tx.unbounded_send(());
            }
        });
        let bus_task = cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while rx.next().await.is_some() {
                while rx.try_recv().is_ok() {}
                if this
                    .update(cx, |v, cx| {
                        v.reload(cx);
                        if v.picker_open {
                            v.load_picker_data(cx);
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        });

        let mut this = Self {
            host,
            items: Vec::new(),
            arrangement: "featured".into(),
            own_arrangement: false,
            meta: HashMap::new(),
            featured_id: None,
            hovered_module: false,
            hovered_item: None,
            caption_edit: None,
            add_menu_open: false,
            picker_open: false,
            picker_folder: None,
            picker_search,
            picker_query: String::new(),
            picker_data: None,
            picker_task: None,
            reading: false,
            stale: false,
            writing: 0,
            _search_sub: search_sub,
            _bus: Some(bus),
            _bus_task: Some(bus_task),
        };
        this.reload(cx);
        this
    }

    pub fn refresh(&mut self, book: Rc<Book>, cx: &mut Context<Self>) {
        if let Some(module) = book
            .v3()
            .and_then(|b| b.template_of(&self.host.entry))
            .and_then(|t| t.modules.iter().find(|m| m.id == self.host.module.id))
        {
            self.host.module = module.clone();
        }
        self.host.page.book = book;
        self.reload(cx);
    }

    fn target(&self) -> ModuleIn {
        ModuleIn {
            book: self.host.page.book_id.clone(),
            entry: self.host.entry.clone(),
            module: self.host.module.id.clone(),
        }
    }

    fn module_key(&self) -> String {
        format!("{}:{}", self.host.entry, self.host.module.id)
    }

    pub fn items(&self) -> &[MediaItem] {
        &self.items
    }

    pub fn arrangement(&self) -> &str {
        &self.arrangement
    }

    pub fn own_arrangement(&self) -> bool {
        self.own_arrangement
    }

    pub fn is_settled(&self) -> bool {
        !self.reading && !self.stale && self.writing == 0
    }

    pub fn asset_meta(&self, asset_id: &str) -> Option<&AssetMeta> {
        self.meta.get(asset_id)
    }

    pub fn picker_assets(&self) -> Vec<String> {
        self.filtered_picker_assets()
            .into_iter()
            .map(|a| a.id)
            .collect()
    }

    pub fn reload(&mut self, cx: &mut Context<Self>) {
        if self.reading {
            self.stale = true;
            return;
        }
        self.reading = true;
        let lib = self.host.page.library.clone();
        let target = self.target();
        let job = cx.background_spawn(async move { load_module_state(&lib, target) });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            this.update(cx, |v, cx| {
                v.reading = false;
                if let Ok((items, arrangement, own_arrangement, meta)) = result {
                    v.items = items;
                    v.arrangement = arrangement;
                    v.own_arrangement = own_arrangement;
                    v.meta = meta;
                    if v.featured_id
                        .as_ref()
                        .is_none_or(|fid| !v.items.iter().any(|i| &i.id == fid))
                    {
                        v.featured_id = v.items.first().map(|i| i.id.clone());
                    }
                }
                if std::mem::take(&mut v.stale) {
                    v.reload(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn set_arrangement(&mut self, arrangement: Option<&str>, cx: &mut Context<Self>) {
        let lib = self.host.page.library.clone();
        let target = self.target();
        let arg = arrangement.map(str::to_owned);
        self.writing += 1;
        let job = cx.background_spawn(async move {
            lib.run::<MediaArrange>(
                &Actor::User,
                MediaArrangeIn {
                    target,
                    arrangement: arg,
                },
            )
        });
        cx.spawn(async move |this, cx| {
            let res = job.await;
            this.update(cx, |v, cx| {
                v.writing = v.writing.saturating_sub(1);
                if let Err(e) = res {
                    log::warn!("media.set_arrangement: {e}");
                }
                v.reload(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Appends `asset_ids` into this media module, enforcing `MEDIA-ASSET-ONCE`:
    /// assets already present in this module are sand-flashed instead of duplicated.
    pub fn put_assets(&mut self, asset_ids: Vec<String>, cx: &mut Context<Self>) {
        if asset_ids.is_empty() {
            return;
        }
        let mut flash = Vec::new();
        let mut to_add = Vec::new();
        let mut seen: HashSet<String> = self.items.iter().map(|i| i.asset.clone()).collect();
        for aid in asset_ids {
            if let Some(existing) = self.items.iter().find(|i| i.asset == aid) {
                flash.push(existing.id.clone());
                flash.push(format!(
                    "media:{}:{}:{}",
                    self.host.entry, self.host.module.id, aid
                ));
            } else if seen.insert(aid.clone()) {
                to_add.push(aid);
            }
        }
        if !flash.is_empty() {
            UsageFlash::trigger(flash, cx);
        }
        if to_add.is_empty() {
            return;
        }
        let lib = self.host.page.library.clone();
        let target = self.target();
        let mut last_pos = self
            .items
            .iter()
            .filter_map(|i| i.pos.as_deref().and_then(|s| PosKey::parse(s).ok()))
            .max();
        let new_items: Vec<MediaItem> = to_add
            .into_iter()
            .map(|asset| {
                let next = match &last_pos {
                    Some(prev) => prev.after(),
                    None => PosKey::first(),
                };
                last_pos = Some(next.clone());
                MediaItem {
                    id: dr_model::id::new_uuid_v7(),
                    asset,
                    caption: String::new(),
                    pos: Some(next.to_string()),
                    missing: false,
                }
            })
            .collect();
        let added_ids: Vec<String> = new_items.iter().map(|i| i.id.clone()).collect();
        self.writing += 1;
        let job = cx.background_spawn(async move {
            for item in new_items {
                lib.run::<MediaPut>(
                    &Actor::User,
                    MediaPutIn {
                        target: target.clone(),
                        item,
                    },
                )?;
            }
            Ok::<_, dr_workspace::WsError>(())
        });
        cx.spawn(async move |this, cx| {
            let res = job.await;
            this.update(cx, |v, cx| {
                v.writing = v.writing.saturating_sub(1);
                match res {
                    Ok(()) => {
                        UsageFlash::trigger(added_ids, cx);
                        v.reload(cx);
                    }
                    Err(e) => log::warn!("media.put_media: {e}"),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn remove_item(&mut self, item_id: String, cx: &mut Context<Self>) {
        let lib = self.host.page.library.clone();
        let target = self.target();
        self.writing += 1;
        let job = cx.background_spawn(async move {
            lib.run::<MediaRemove>(
                &Actor::User,
                MediaRemoveIn {
                    target,
                    item: item_id,
                },
            )
        });
        cx.spawn(async move |this, cx| {
            let res = job.await;
            this.update(cx, |v, cx| {
                v.writing = v.writing.saturating_sub(1);
                if let Err(e) = res {
                    log::warn!("media.remove_media: {e}");
                }
                v.reload(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn set_caption(&mut self, item_id: &str, caption: String, cx: &mut Context<Self>) {
        let Some(existing) = self.items.iter().find(|i| i.id == item_id).cloned() else {
            return;
        };
        let trimmed = caption.trim().to_owned();
        if existing.caption.trim() == trimmed {
            return;
        }
        let lib = self.host.page.library.clone();
        let target = self.target();
        let updated = MediaItem {
            caption: trimmed,
            ..existing
        };
        self.writing += 1;
        let job = cx.background_spawn(async move {
            lib.run::<MediaPut>(
                &Actor::User,
                MediaPutIn {
                    target,
                    item: updated,
                },
            )
        });
        cx.spawn(async move |this, cx| {
            let res = job.await;
            this.update(cx, |v, cx| {
                v.writing = v.writing.saturating_sub(1);
                if let Err(e) = res {
                    log::warn!("media caption save: {e}");
                }
                v.reload(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn reorder_before(
        &mut self,
        dragged_item_id: &str,
        before_item_id: &str,
        cx: &mut Context<Self>,
    ) {
        if dragged_item_id == before_item_id {
            return;
        }
        let Some(dragged) = self.items.iter().find(|i| i.id == dragged_item_id).cloned() else {
            return;
        };
        let siblings: Vec<&MediaItem> = self
            .items
            .iter()
            .filter(|i| i.id != dragged_item_id)
            .collect();
        let idx = siblings
            .iter()
            .position(|i| i.id == before_item_id)
            .unwrap_or(siblings.len());
        let before_pos = idx
            .checked_sub(1)
            .and_then(|j| siblings[j].pos.as_deref())
            .and_then(|s| PosKey::parse(s).ok());
        let after_pos = siblings
            .get(idx)
            .and_then(|i| i.pos.as_deref())
            .and_then(|s| PosKey::parse(s).ok());
        let next_pos = PosKey::between(before_pos.as_ref(), after_pos.as_ref())
            .or_else(|_| PosKey::between(before_pos.as_ref(), None))
            .unwrap_or_else(|_| PosKey::first());
        let lib = self.host.page.library.clone();
        let target = self.target();
        let updated = MediaItem {
            pos: Some(next_pos.to_string()),
            ..dragged
        };
        self.writing += 1;
        let job = cx.background_spawn(async move {
            lib.run::<MediaPut>(
                &Actor::User,
                MediaPutIn {
                    target,
                    item: updated,
                },
            )
        });
        cx.spawn(async move |this, cx| {
            let res = job.await;
            this.update(cx, |v, cx| {
                v.writing = v.writing.saturating_sub(1);
                if let Err(e) = res {
                    log::warn!("media reorder: {e}");
                }
                v.reload(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn restore_missing(&mut self, asset_id: &str, cx: &mut Context<Self>) {
        let Some(meta) = self.meta.get(asset_id).cloned() else {
            return;
        };
        if !meta.restorable_in_book {
            return;
        }
        let lib = self.host.page.library.clone();
        let book = self.host.page.book_id.clone();
        let aid = asset_id.to_owned();
        self.writing += 1;
        let job = cx.background_spawn(async move {
            for fid in meta.trashed_folders {
                let _ = lib.run::<AssetFolderRestore>(
                    &Actor::User,
                    EntityIn {
                        book: book.clone(),
                        id: fid,
                    },
                );
            }
            if meta.self_trashed {
                let _ = lib.run::<AssetRestore>(&Actor::User, EntityIn { book, id: aid });
            }
        });
        cx.spawn(async move |this, cx| {
            job.await;
            this.update(cx, |v, cx| {
                v.writing = v.writing.saturating_sub(1);
                v.reload(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn drop_library_drag(&mut self, drag: &AssetDrag, cx: &mut Context<Self>) {
        if drag.book != self.host.page.book_id {
            return;
        }
        if drag.folders.is_empty() {
            self.put_assets(drag.assets.clone(), cx);
            return;
        }
        let lib = self.host.page.library.clone();
        let book = self.host.page.book_id.clone();
        let direct = drag.assets.clone();
        let root_folders = drag.folders.clone();
        let resolve =
            cx.background_spawn(
                async move { expand_drag_assets(&lib, &book, direct, &root_folders) },
            );
        cx.spawn(async move |this, cx| {
            let assets = resolve.await;
            this.update(cx, |v, cx| v.put_assets(assets, cx)).ok();
        })
        .detach();
    }

    pub fn import_and_put_paths(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        if paths.is_empty() {
            return;
        }
        let lib = self.host.page.library.clone();
        let book = self.host.page.book_id.clone();
        self.writing += 1;
        let job = cx.background_spawn(async move {
            dr_view_material::import::import_paths(&lib, &book, None, &paths)
        });
        cx.spawn(async move |this, cx| {
            let report = job.await;
            this.update(cx, |v, cx| {
                v.writing = v.writing.saturating_sub(1);
                if !report.skipped.is_empty() {
                    let names: Vec<String> = report
                        .skipped
                        .iter()
                        .map(|(p, _)| {
                            p.file_name()
                                .map(|n| n.to_string_lossy().into_owned())
                                .unwrap_or_default()
                        })
                        .collect();
                    let text = tf(
                        cx,
                        keys::memo_material::error::PICK_FAILED,
                        &[("error", &names.join("、"))],
                    );
                    if let Some(ws) = v.host.page.workspace.upgrade() {
                        ws.update(cx, |ws, cx| ws.toast_error(text, cx));
                    }
                }
                let ids: Vec<String> = report.imported.into_iter().map(|i| i.material).collect();
                v.put_assets(ids, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn pick_from_computer(&mut self, cx: &mut Context<Self>) {
        self.add_menu_open = false;
        self.picker_open = false;
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: None,
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            this.update(cx, |v, cx| v.import_and_put_paths(paths, cx))
                .ok();
        })
        .detach();
        cx.notify();
    }

    pub fn open_library_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.add_menu_open = false;
        self.picker_open = true;
        self.picker_folder = None;
        self.picker_query.clear();
        self.picker_search
            .update(cx, |f, cx| f.set_text(String::new(), cx));
        let focus = self.picker_search.read(cx).focus_handle(cx);
        window.focus(&focus, cx);
        self.load_picker_data(cx);
        cx.notify();
    }

    fn load_picker_data(&mut self, cx: &mut Context<Self>) {
        let lib = self.host.page.library.clone();
        let book = self.host.page.book_id.clone();
        let job = cx.background_spawn(async move {
            let assets = lib
                .run::<AssetList>(
                    &Actor::User,
                    ListIn {
                        book: book.clone(),
                        trashed: false,
                    },
                )
                .map(|o| o.output)
                .unwrap_or_default();
            let folders = lib
                .run::<AssetFolderList>(
                    &Actor::User,
                    AssetFolderListIn {
                        book,
                        trashed: false,
                    },
                )
                .map(|o| o.output)
                .unwrap_or_default();
            let mut thumbs = HashMap::new();
            let store = lib.library();
            for a in &assets {
                if let Some(p) = best_thumb_path(store, &a.id) {
                    thumbs.insert(a.id.clone(), p);
                }
            }
            PickerData {
                assets,
                folders,
                thumbs,
            }
        });
        self.picker_task = Some(cx.spawn(async move |this, cx| {
            let data = job.await;
            this.update(cx, |v, cx| {
                v.picker_data = Some(data);
                v.picker_task = None;
                cx.notify();
            })
            .ok();
        }));
    }

    fn filtered_picker_assets(&self) -> Vec<AssetInfo> {
        let Some(data) = &self.picker_data else {
            return Vec::new();
        };
        let allowed_folders: Option<HashSet<String>> = self.picker_folder.as_ref().map(|fid| {
            let mut set = HashSet::new();
            collect_folder_subtree(&data.folders, fid, &mut set);
            set
        });
        let q = self.picker_query.trim().to_lowercase();
        data.assets
            .iter()
            .filter(|a| {
                allowed_folders
                    .as_ref()
                    .is_none_or(|set| a.folder.as_deref().is_some_and(|af| set.contains(af)))
                    && (q.is_empty() || a.name.to_lowercase().contains(&q))
            })
            .cloned()
            .collect()
    }

    fn start_caption_edit(&mut self, item_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(item) = self.items.iter().find(|i| i.id == item_id) else {
            return;
        };
        let initial = item.caption.clone();
        let placeholder = t(cx, keys::v5_files::MEDIA_CAPTION_PLACEHOLDER);
        let fid = format!(
            "media-cap-edit-{}-{}-{}",
            self.host.entry, self.host.module.id, item_id
        );
        let field = cx.new(|cx| {
            TextField::new(ElementId::Name(fid.into()), window, cx)
                .small()
                .placeholder(placeholder)
                .with_text(initial)
        });
        let iid = item_id.to_owned();
        let sub = cx.subscribe_in(
            &field,
            window,
            move |this, field, e: &FieldEvent, _, cx| match e {
                FieldEvent::Submitted(_) | FieldEvent::Blurred => {
                    let next = field.read(cx).text();
                    this.caption_edit = None;
                    this.set_caption(&iid, next, cx);
                    cx.notify();
                }
                FieldEvent::Cancelled => {
                    this.caption_edit = None;
                    cx.notify();
                }
                FieldEvent::Changed(_) => {}
            },
        );
        let focus = field.read(cx).focus_handle(cx);
        window.focus(&focus, cx);
        self.caption_edit = Some(CaptionDraft {
            item_id: item_id.to_owned(),
            field,
            _sub: sub,
        });
        cx.notify();
    }

    fn open_item(&self, item: &MediaItem, cx: &mut Context<Self>) {
        let id = MediaItemId::parse(&item.asset)
            .or_else(|_| MediaItemId::parse(&item.id))
            .ok();
        let Some(id) = id else {
            return;
        };
        if let Some(ws) = self.host.page.workspace.upgrade() {
            ws.update(cx, |ws, cx| {
                ws.open(NavTarget::Material(id), Open::PREVIEW, cx);
            });
        }
    }

    fn meta_subtitle(&self, asset_id: &str, cx: &App) -> SharedString {
        let Some(meta) = self.meta.get(asset_id) else {
            return t(cx, keys::v5_files::KIND_IMAGE);
        };
        match meta.kind {
            AssetKind::Pdf => match meta.pages {
                Some(pages) if pages > 0 => {
                    let count = tp(
                        cx,
                        keys::v5_files::PAGE_COUNT,
                        pages as u64,
                        &[("count", &pages)],
                    );
                    format!("{} · {count}", t(cx, keys::v5_files::KIND_PDF)).into()
                }
                _ => t(cx, keys::v5_files::KIND_PDF),
            },
            _ => match (meta.width, meta.height) {
                (Some(w), Some(h)) if w > 0 && h > 0 => {
                    format!("{} · {w} × {h}", t(cx, keys::v5_files::KIND_IMAGE)).into()
                }
                _ => t(cx, keys::v5_files::KIND_IMAGE),
            },
        }
    }

    fn item_hover_card(
        &self,
        prefix: &str,
        item: &MediaItem,
        target: AnyElement,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if item.missing {
            return target;
        }
        // An open comment on this file in this module: one sand dot on the
        // corner, never a count (`kernel-v5.md` §7).
        let comment_ids = self
            .host
            .page
            .book
            .v3()
            .map(|b| b.media_comments(&self.host.entry, &self.host.module.id, &item.asset))
            .unwrap_or_default();
        let target = if comment_ids.is_empty() {
            target
        } else {
            let hot = dr_shell::ReviewFocus::get(cx)
                .cards
                .iter()
                .any(|c| comment_ids.contains(c));
            let palette = Theme::of(window, cx).palette;
            div()
                .relative()
                .child(target)
                .child(
                    div()
                        .absolute()
                        .top(px(5.0))
                        .right(px(5.0))
                        .child(sand::comment_dot(8.0, hot, palette)),
                )
                .into_any_element()
        };
        let title: SharedString = self
            .meta
            .get(&item.asset)
            .map(|m| m.name.clone().into())
            .unwrap_or_else(|| t(cx, keys::common::UNTITLED));
        let subtitle = self.meta_subtitle(&item.asset, cx);
        let thumb_path = self
            .meta
            .get(&item.asset)
            .and_then(|m| m.thumb.clone().or_else(|| m.display.clone()));
        let is_pdf = self
            .meta
            .get(&item.asset)
            .is_some_and(|m| m.kind == AssetKind::Pdf);
        let open_label = t(cx, keys::v5_files::OPEN);
        let locate_label = t(cx, keys::v5_files::LOCATE_IN_LIBRARY);
        let remove_label = t(cx, keys::v5_files::REMOVE_FROM_HERE);
        let this = cx.entity();
        let ws_for_locate = self.host.page.workspace.clone();
        let item_for_open = item.clone();
        let asset_for_locate = item.asset.clone();
        let item_id_for_remove = item.id.clone();
        let comment_label = t(cx, keys::v3_review::WRITE_COMMENT);
        let frame_label = t(cx, keys::v3_review::DRAW_REGION_COMMENT);
        let ws_for_comment = self.host.page.workspace.clone();
        let comment_entry = self.host.entry.clone();
        let comment_module = self.host.module.id.clone();
        let comment_asset = item.asset.clone();
        let cid = format!(
            "media-hc-{prefix}-{}-{}-{}",
            self.host.entry, self.host.module.id, item.id
        );
        let body_id = cid.clone();
        HoverCard::new(ElementId::Name(cid.into()), target, move |window, cx| {
            let p = Theme::of(window, cx).palette;
            let preview = div()
                .w_full()
                .h(px(132.0))
                .rounded(px(radius::SM))
                .overflow_hidden()
                .bg(p.ink(1).alpha(0.05))
                .flex()
                .items_center()
                .justify_center()
                .child(match &thumb_path {
                    Some(path) => img(path.clone())
                        .size_full()
                        .object_fit(if is_pdf {
                            ObjectFit::Contain
                        } else {
                            ObjectFit::Cover
                        })
                        .into_any_element(),
                    None => sand::icon(
                        if is_pdf { Icon::FileText } else { Icon::Image },
                        24.0,
                        p.ink(3).solid(),
                    )
                    .into_any_element(),
                });
            let open_ent = this.clone();
            let item_clone = item_for_open.clone();
            let open_act = CardAction::new(
                ElementId::Name(format!("{body_id}-open").into()),
                RowIcon::Brush(Icon::GateOut),
                open_label.clone(),
            )
            .on_click(move |_, _, cx| {
                let it = item_clone.clone();
                open_ent.update(cx, |v, cx| v.open_item(&it, cx));
            })
            .into_any_element();

            let asset_id = asset_for_locate.clone();
            let ws_loc = ws_for_locate.clone();
            let locate_act = CardAction::new(
                ElementId::Name(format!("{body_id}-locate").into()),
                RowIcon::Brush(Icon::Locate),
                locate_label.clone(),
            )
            .on_click(move |_, window, cx| {
                dr_shell::pages::locate_asset(&ws_loc, &asset_id, window, cx);
            })
            .into_any_element();

            // T6: a comment on this file in this media module, or on a
            // region of it drawn in the viewer (`v5-tracks.md` §T6).
            let (ws_c, entry_c, module_c, asset_c) = (
                ws_for_comment.clone(),
                comment_entry.clone(),
                comment_module.clone(),
                comment_asset.clone(),
            );
            let comment_act = CardAction::new(
                ElementId::Name(format!("{body_id}-comment").into()),
                RowIcon::Brush(Icon::CommentPlus),
                comment_label.clone(),
            )
            .on_click(move |_, window, cx| {
                if let Some(ws) = ws_c.upgrade() {
                    let at = window.mouse_position();
                    let part = dr_workspace::dto::CommentPartDto::Media {
                        asset: asset_c.clone(),
                        region: None,
                    };
                    ws.update(cx, |ws, cx| {
                        ws.open_part_composer(&entry_c, &module_c, part, Some(at), None, window, cx)
                    });
                }
            })
            .into_any_element();
            let (ws_f, entry_f, module_f, asset_f) = (
                ws_for_comment.clone(),
                comment_entry.clone(),
                comment_module.clone(),
                comment_asset.clone(),
            );
            let frame_act = CardAction::new(
                ElementId::Name(format!("{body_id}-frame").into()),
                RowIcon::Brush(Icon::Fullscreen),
                frame_label.clone(),
            )
            .on_click(move |_, _, cx| {
                if let Some(ws) = ws_f.upgrade() {
                    let scope = dr_shell::FrameScope::Media {
                        entry: entry_f.clone(),
                        module: module_f.clone(),
                        asset: asset_f.clone(),
                    };
                    ws.update(cx, |ws, cx| ws.open_frame_viewer(scope, cx));
                }
            })
            .into_any_element();

            let rem_ent = this.clone();
            let rem_id = item_id_for_remove.clone();
            let remove_act = CardAction::new(
                ElementId::Name(format!("{body_id}-remove").into()),
                RowIcon::Brush(Icon::Minus),
                remove_label.clone(),
            )
            .danger()
            .on_click(move |_, _, cx| {
                let id = rem_id.clone();
                rem_ent.update(cx, |v, cx| v.remove_item(id, cx));
            })
            .into_any_element();

            CardBody::new(
                ElementId::Name(format!("{body_id}-body").into()),
                title.clone(),
            )
            .mark(sand::Kind::Material, None)
            .meta(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(preview)
                    .child(subtitle.clone()),
            )
            .section(vec![open_act, locate_act])
            .section(vec![comment_act, frame_act])
            .section(vec![remove_act])
            .into_any_element()
        })
        .into_any_element()
    }

    fn render_caption(
        &self,
        item: &MediaItem,
        show_empty_placeholder: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if let Some(draft) = &self.caption_edit
            && draft.item_id == item.id
        {
            return div()
                .w_full()
                .pt(px(4.0))
                .child(draft.field.clone())
                .into_any_element();
        }
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let has_text = !item.caption.trim().is_empty();
        if !has_text && !show_empty_placeholder {
            return div().h(px(18.0)).into_any_element();
        }
        let label: SharedString = if has_text {
            item.caption.clone().into()
        } else {
            t(cx, keys::v5_files::MEDIA_CAPTION_PLACEHOLDER)
        };
        let item_id = item.id.clone();
        let cid = format!(
            "media-cap-{}-{}-{}",
            self.host.entry, self.host.module.id, item.id
        );
        div()
            .id(ElementId::Name(cid.into()))
            .pt(px(4.0))
            .cursor_text()
            .font_role(Role::Prose)
            .type_px(s.caption, s.line_caption)
            .text_color(if has_text {
                p.ink(3).solid()
            } else {
                p.ink(4).alpha(0.65)
            })
            .child(label)
            .on_click(cx.listener(move |v, _: &ClickEvent, window, cx| {
                cx.stop_propagation();
                v.start_caption_edit(&item_id, window, cx);
            }))
            .into_any_element()
    }

    fn render_gone_box(
        &self,
        item: &MediaItem,
        compact: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let meta = self.meta.get(&item.asset);
        let name: SharedString = meta
            .map(|m| m.name.clone().into())
            .filter(|n: &SharedString| !n.is_empty())
            .unwrap_or_else(|| item.asset.clone().into());
        let is_pdf = meta.is_some_and(|m| m.kind == AssetKind::Pdf);
        let restorable = meta.is_some_and(|m| m.restorable_in_book);
        let asset_id = item.asset.clone();
        let item_id = item.id.clone();
        let gid = format!(
            "media-gone-{}-{}-{}",
            self.host.entry, self.host.module.id, item.id
        );
        let mut box_div = div()
            .id(ElementId::Name(gid.clone().into()))
            .w_full()
            .rounded(px(radius::SM))
            .border_1()
            .border_dashed()
            .border_color(p.hairline())
            .bg(p.ink(1).alpha(0.02))
            .px(px(10.0))
            .py(px(if compact { 6.0 } else { 14.0 }))
            .flex()
            .items_center()
            .gap(px(8.0));
        if !compact {
            box_div = box_div.flex_col().justify_center().min_h(px(116.0));
        }
        box_div
            .child(sand::icon(
                if is_pdf { Icon::FileText } else { Icon::Image },
                16.0,
                p.ink(4).solid(),
            ))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .line_through()
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.ink(4).solid())
                    .child(name),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.0))
                    .when(restorable, |d| {
                        let aid = asset_id.clone();
                        d.child(
                            Button::new(
                                ElementId::Name(format!("{gid}-restore").into()),
                                t(cx, keys::v5_files::RESTORE),
                            )
                            .text()
                            .small()
                            .on_click(cx.listener(
                                move |v, _, _, cx| {
                                    v.restore_missing(&aid, cx);
                                },
                            )),
                        )
                    })
                    .child(
                        Button::new(
                            ElementId::Name(format!("{gid}-remove").into()),
                            t(cx, keys::v5_files::REMOVE_FROM_HERE),
                        )
                        .text()
                        .small()
                        .on_click(cx.listener(move |v, _, _, cx| {
                            v.remove_item(item_id.clone(), cx);
                        })),
                    ),
            )
            .into_any_element()
    }

    fn flash_active(&self, item: &MediaItem, window: &mut Window, cx: &App) -> bool {
        let key = format!(
            "media:{}:{}:{}",
            self.host.entry, self.host.module.id, item.asset
        );
        UsageFlash::strength_for(&[item.id.as_str(), key.as_str()], window, cx) > 0.0
    }

    fn render_featured(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let current = self
            .featured_id
            .as_ref()
            .and_then(|id| self.items.iter().find(|i| &i.id == id))
            .or_else(|| self.items.first())
            .cloned();
        let Some(hero) = current else {
            return self.render_empty_add(window, cx);
        };
        let hero_hovered = self.hovered_item.as_deref() == Some(hero.id.as_str());
        let hero_lit = self.flash_active(&hero, window, cx);
        let hero_view = if hero.missing {
            self.render_gone_box(&hero, false, window, cx)
        } else {
            let meta = self.meta.get(&hero.asset);
            let is_pdf = meta.is_some_and(|m| m.kind == AssetKind::Pdf);
            let pic_path = meta.and_then(|m| m.display.clone().or_else(|| m.thumb.clone()));
            let open_item = hero.clone();
            let hover_id = hero.id.clone();
            let picture = div()
                .id(ElementId::Name(
                    format!("media-hero-pic-{}", hero.id).into(),
                ))
                .relative()
                .w_full()
                .h(px(280.0))
                .rounded(px(radius::MD))
                .overflow_hidden()
                .bg(p.ink(1).alpha(0.04))
                .cursor_pointer()
                .flex()
                .items_center()
                .justify_center()
                .on_hover(cx.listener(move |v, on: &bool, _, cx| {
                    if *on {
                        v.hovered_item = Some(hover_id.clone());
                    } else if v.hovered_item.as_deref() == Some(hover_id.as_str()) {
                        v.hovered_item = None;
                    }
                    cx.notify();
                }))
                .on_click(cx.listener(move |v, _, _, cx| v.open_item(&open_item, cx)))
                .child(match pic_path {
                    Some(path) => img(path)
                        .size_full()
                        .object_fit(ObjectFit::Contain)
                        .into_any_element(),
                    None => sand::icon(
                        if is_pdf { Icon::FileText } else { Icon::Image },
                        32.0,
                        p.ink(3).solid(),
                    )
                    .into_any_element(),
                })
                .when(is_pdf, |d| {
                    let sub = self.meta_subtitle(&hero.asset, cx);
                    d.child(
                        div()
                            .absolute()
                            .bottom(px(8.0))
                            .right(px(10.0))
                            .px(px(8.0))
                            .py(px(2.0))
                            .rounded(px(999.0))
                            .bg(p.page.alpha(0.9))
                            .border_1()
                            .border_color(p.hairline())
                            .font_role(Role::Index)
                            .type_px(theme.scale.caption, theme.scale.line_caption)
                            .text_color(p.ink(2).solid())
                            .child(sub),
                    )
                })
                .child(
                    div().absolute().inset_0().child(
                        SandFrame::new(
                            ElementId::Name(format!("media-hero-sf-{}", hero.id).into()),
                            hero_lit,
                        )
                        .color(p.accent),
                    ),
                )
                .into_any_element();
            self.item_hover_card("hero", &hero, picture, window, cx)
        };

        let mut strip = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(px(8.0))
            .pt(px(6.0));
        let mod_key = self.module_key();
        let wash = p.accent.alpha(0.14);
        for item in &self.items {
            let selected = item.id == hero.id;
            let meta = self.meta.get(&item.asset);
            let thumb = meta.and_then(|m| m.thumb.clone().or_else(|| m.display.clone()));
            let is_pdf = meta.is_some_and(|m| m.kind == AssetKind::Pdf);
            let label: SharedString = meta
                .map(|m| m.name.clone().into())
                .unwrap_or_else(|| t(cx, keys::common::UNTITLED));
            let drag = ReorderDrag {
                module_key: mod_key.clone(),
                item_id: item.id.clone(),
                label,
            };
            let click_id = item.id.clone();
            let click_item = item.clone();
            let before_id = item.id.clone();
            let expected_key = mod_key.clone();
            let cell = glass::glass_box(
                ElementId::Name(format!("media-strip-{}", item.id).into()),
                GlassKind::Rest,
                Mode::default(),
                selected,
                Spec::new(Tone::Clear, radius::SM),
                window,
                cx,
            )
            .w(px(64.0))
            .h(px(48.0))
            .rounded(px(radius::SM))
            .overflow_hidden()
            .cursor_pointer()
            .flex()
            .items_center()
            .justify_center()
            .child(if item.missing {
                sand::icon(Icon::Image, 14.0, p.ink(4).solid()).into_any_element()
            } else if let Some(path) = thumb {
                img(path)
                    .size_full()
                    .object_fit(if is_pdf {
                        ObjectFit::Contain
                    } else {
                        ObjectFit::Cover
                    })
                    .into_any_element()
            } else {
                sand::icon(
                    if is_pdf { Icon::FileText } else { Icon::Image },
                    16.0,
                    p.ink(3).solid(),
                )
                .into_any_element()
            })
            .on_click(cx.listener(move |v, e: &ClickEvent, _, cx| {
                if e.click_count() > 1 {
                    v.open_item(&click_item, cx);
                } else {
                    v.featured_id = Some(click_id.clone());
                    cx.notify();
                }
            }))
            .on_drag(drag, |d, _, _, cx| {
                cx.new(|_| ReorderGhost {
                    label: d.label.clone(),
                })
            })
            .drag_over::<ReorderDrag>(move |st, _, _, _| st.bg(wash))
            .on_drop(cx.listener(move |v, d: &ReorderDrag, _, cx| {
                if d.module_key == expected_key {
                    v.reorder_before(&d.item_id, &before_id, cx);
                }
            }));
            strip = strip.child(cell);
        }
        strip = strip.child(
            glass::glass_box(
                ElementId::Name(
                    format!(
                        "media-strip-add-{}-{}",
                        self.host.entry, self.host.module.id
                    )
                    .into(),
                ),
                GlassKind::Rest,
                Mode::default(),
                false,
                Spec::new(Tone::Clear, radius::SM),
                window,
                cx,
            )
            .w(px(48.0))
            .h(px(48.0))
            .rounded(px(radius::SM))
            .cursor_pointer()
            .role(gpui::Role::Button)
            .aria_label(t(cx, keys::v5_files::ADD_FILES))
            .flex()
            .items_center()
            .justify_center()
            .child(sand::icon(Icon::Plus, 16.0, p.ink(3).solid()))
            .on_click(cx.listener(|v, _, _, cx| {
                v.add_menu_open = !v.add_menu_open;
                cx.notify();
            })),
        );

        div()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .child(hero_view)
            .child(self.render_caption(&hero, hero_hovered, window, cx))
            .child(strip)
            .into_any_element()
    }

    fn render_grid(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let mod_key = self.module_key();
        let wash = p.accent.alpha(0.14);
        let mut grid = div().flex().flex_row().flex_wrap().gap(px(12.0));
        for item in &self.items {
            let hovered = self.hovered_item.as_deref() == Some(item.id.as_str());
            let lit = self.flash_active(item, window, cx);
            if item.missing {
                grid = grid.child(
                    div()
                        .w(px(176.0))
                        .child(self.render_gone_box(item, false, window, cx)),
                );
                continue;
            }
            let meta = self.meta.get(&item.asset);
            let thumb = meta.and_then(|m| m.thumb.clone().or_else(|| m.display.clone()));
            let is_pdf = meta.is_some_and(|m| m.kind == AssetKind::Pdf);
            let label: SharedString = meta
                .map(|m| m.name.clone().into())
                .unwrap_or_else(|| t(cx, keys::common::UNTITLED));
            let drag = ReorderDrag {
                module_key: mod_key.clone(),
                item_id: item.id.clone(),
                label: label.clone(),
            };
            let hover_id = item.id.clone();
            let click_item = item.clone();
            let before_id = item.id.clone();
            let expected_key = mod_key.clone();
            let pic_card = glass::glass_box(
                ElementId::Name(format!("media-grid-card-{}", item.id).into()),
                GlassKind::Rest,
                Mode::default(),
                false,
                Spec::new(Tone::Clear, radius::SM),
                window,
                cx,
            )
            .relative()
            .w(px(176.0))
            .p(px(6.0))
            .rounded(px(radius::SM))
            .cursor_pointer()
            .flex()
            .flex_col()
            .on_click(cx.listener(move |v, _, _, cx| v.open_item(&click_item, cx)))
            .child(
                div()
                    .relative()
                    .w_full()
                    .h(px(124.0))
                    .rounded(px(radius::SM - 2.0))
                    .overflow_hidden()
                    .bg(p.ink(1).alpha(0.04))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(match thumb {
                        Some(path) => img(path)
                            .size_full()
                            .object_fit(if is_pdf {
                                ObjectFit::Contain
                            } else {
                                ObjectFit::Cover
                            })
                            .into_any_element(),
                        None => sand::icon(
                            if is_pdf { Icon::FileText } else { Icon::Image },
                            24.0,
                            p.ink(3).solid(),
                        )
                        .into_any_element(),
                    })
                    .when(hovered, |d| {
                        d.child(
                            div()
                                .absolute()
                                .top(px(6.0))
                                .left(px(6.0))
                                .size(px(20.0))
                                .rounded(px(4.0))
                                .bg(p.page.alpha(0.85))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(sand::icon(Icon::Grip, 12.0, p.ink(3).solid())),
                        )
                    }),
            )
            .child(
                div()
                    .pt(px(5.0))
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .font_role(Role::Ui)
                    .type_px(theme.scale.secondary, theme.scale.line_body)
                    .text_color(p.ink(1).solid())
                    .child(label),
            )
            .child(self.render_caption(item, hovered, window, cx))
            .child(
                div().absolute().inset_0().child(
                    SandFrame::new(
                        ElementId::Name(format!("media-grid-sf-{}", item.id).into()),
                        lit,
                    )
                    .color(p.accent),
                ),
            )
            .into_any_element();

            let wrapped = self.item_hover_card("grid", item, pic_card, window, cx);
            grid = grid.child(
                div()
                    .id(ElementId::Name(
                        format!("media-grid-wrap-{}", item.id).into(),
                    ))
                    .on_hover(cx.listener(move |v, on: &bool, _, cx| {
                        if *on {
                            v.hovered_item = Some(hover_id.clone());
                        } else if v.hovered_item.as_deref() == Some(hover_id.as_str()) {
                            v.hovered_item = None;
                        }
                        cx.notify();
                    }))
                    .on_drag(drag, |d, _, _, cx| {
                        cx.new(|_| ReorderGhost {
                            label: d.label.clone(),
                        })
                    })
                    .drag_over::<ReorderDrag>(move |st, _, _, _| st.bg(wash))
                    .on_drop(cx.listener(move |v, d: &ReorderDrag, _, cx| {
                        if d.module_key == expected_key {
                            v.reorder_before(&d.item_id, &before_id, cx);
                        }
                    }))
                    .child(wrapped),
            );
        }
        grid = grid.child(
            glass::glass_box(
                ElementId::Name(
                    format!("media-grid-add-{}-{}", self.host.entry, self.host.module.id).into(),
                ),
                GlassKind::Rest,
                Mode::default(),
                false,
                Spec::new(Tone::Clear, radius::SM),
                window,
                cx,
            )
            .w(px(176.0))
            .min_h(px(136.0))
            .rounded(px(radius::SM))
            .cursor_pointer()
            .role(gpui::Role::Button)
            .aria_label(t(cx, keys::v5_files::ADD_FILES))
            .flex()
            .items_center()
            .justify_center()
            .child(sand::icon(Icon::Plus, 20.0, p.ink(3).solid()))
            .on_click(cx.listener(|v, _, _, cx| {
                v.add_menu_open = !v.add_menu_open;
                cx.notify();
            })),
        );
        grid.into_any_element()
    }

    fn render_list(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let mod_key = self.module_key();
        let wash = p.accent.alpha(0.14);
        let mut list = div().flex().flex_col().gap(px(4.0));
        for item in &self.items {
            if item.missing {
                list = list.child(self.render_gone_box(item, true, window, cx));
                continue;
            }
            let hovered = self.hovered_item.as_deref() == Some(item.id.as_str());
            let lit = self.flash_active(item, window, cx);
            let meta = self.meta.get(&item.asset);
            let thumb = meta.and_then(|m| m.thumb.clone().or_else(|| m.display.clone()));
            let is_pdf = meta.is_some_and(|m| m.kind == AssetKind::Pdf);
            let label: SharedString = meta
                .map(|m| m.name.clone().into())
                .unwrap_or_else(|| t(cx, keys::common::UNTITLED));
            let subtitle = self.meta_subtitle(&item.asset, cx);
            let drag = ReorderDrag {
                module_key: mod_key.clone(),
                item_id: item.id.clone(),
                label: label.clone(),
            };
            let hover_id = item.id.clone();
            let click_item = item.clone();
            let before_id = item.id.clone();
            let expected_key = mod_key.clone();
            let row = glass::glass_box(
                ElementId::Name(format!("media-list-row-{}", item.id).into()),
                GlassKind::Hidden,
                Mode::default(),
                false,
                Spec::new(Tone::Clear, radius::SM),
                window,
                cx,
            )
            .relative()
            .px(px(8.0))
            .py(px(6.0))
            .rounded(px(radius::SM))
            .cursor_pointer()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.0))
            .on_click(cx.listener(move |v, _, _, cx| v.open_item(&click_item, cx)))
            .child(
                div()
                    .w(px(14.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(if hovered {
                        sand::icon(Icon::Grip, 12.0, p.ink(4).solid()).into_any_element()
                    } else {
                        div().size(px(12.0)).into_any_element()
                    }),
            )
            .child(
                div()
                    .size(px(36.0))
                    .rounded(px(4.0))
                    .overflow_hidden()
                    .bg(p.ink(1).alpha(0.05))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(match thumb {
                        Some(path) => img(path)
                            .size_full()
                            .object_fit(if is_pdf {
                                ObjectFit::Contain
                            } else {
                                ObjectFit::Cover
                            })
                            .into_any_element(),
                        None => sand::icon(
                            if is_pdf { Icon::FileText } else { Icon::Image },
                            16.0,
                            p.ink(3).solid(),
                        )
                        .into_any_element(),
                    }),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .font_role(Role::Ui)
                            .type_px(s.body, s.line_body)
                            .text_color(p.ink(1).solid())
                            .child(label),
                    )
                    .child(self.render_caption(item, hovered, window, cx)),
            )
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.ink(4).solid())
                    .child(subtitle),
            )
            .child(
                div().absolute().inset_0().child(
                    SandFrame::new(
                        ElementId::Name(format!("media-list-sf-{}", item.id).into()),
                        lit,
                    )
                    .color(p.accent),
                ),
            )
            .into_any_element();

            let wrapped = self.item_hover_card("list", item, row, window, cx);
            list = list.child(
                div()
                    .id(ElementId::Name(
                        format!("media-list-wrap-{}", item.id).into(),
                    ))
                    .on_hover(cx.listener(move |v, on: &bool, _, cx| {
                        if *on {
                            v.hovered_item = Some(hover_id.clone());
                        } else if v.hovered_item.as_deref() == Some(hover_id.as_str()) {
                            v.hovered_item = None;
                        }
                        cx.notify();
                    }))
                    .on_drag(drag, |d, _, _, cx| {
                        cx.new(|_| ReorderGhost {
                            label: d.label.clone(),
                        })
                    })
                    .drag_over::<ReorderDrag>(move |st, _, _, _| st.bg(wash))
                    .on_drop(cx.listener(move |v, d: &ReorderDrag, _, cx| {
                        if d.module_key == expected_key {
                            v.reorder_before(&d.item_id, &before_id, cx);
                        }
                    }))
                    .child(wrapped),
            );
        }
        list = list.child(
            glass::glass_box(
                ElementId::Name(
                    format!("media-list-add-{}-{}", self.host.entry, self.host.module.id).into(),
                ),
                GlassKind::Hidden,
                Mode::default(),
                false,
                Spec::new(Tone::Clear, radius::SM),
                window,
                cx,
            )
            .px(px(10.0))
            .py(px(6.0))
            .rounded(px(radius::SM))
            .cursor_pointer()
            .role(gpui::Role::Button)
            .aria_label(t(cx, keys::v5_files::ADD_FILES))
            .flex()
            .items_center()
            .gap(px(6.0))
            .font_role(Role::Index)
            .type_px(s.secondary, s.line_body)
            .text_color(p.ink(3).solid())
            .child(sand::icon(Icon::Plus, 14.0, p.ink(3).solid()))
            .child(t(cx, keys::v5_files::ADD_FILES))
            .on_click(cx.listener(|v, _, _, cx| {
                v.add_menu_open = !v.add_menu_open;
                cx.notify();
            })),
        );
        list.into_any_element()
    }

    fn render_empty_add(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        glass::glass_box(
            ElementId::Name(
                format!(
                    "media-empty-add-{}-{}",
                    self.host.entry, self.host.module.id
                )
                .into(),
            ),
            GlassKind::Rest,
            Mode::default(),
            false,
            Spec::new(Tone::Clear, radius::SM),
            window,
            cx,
        )
        .w_full()
        .h(px(88.0))
        .rounded(px(radius::SM))
        .cursor_pointer()
        .role(gpui::Role::Button)
        .aria_label(t(cx, keys::v5_files::ADD_FILES))
        .flex()
        .flex_row()
        .items_center()
        .justify_center()
        .gap(px(8.0))
        .font_role(Role::Ui)
        .type_px(s.secondary, s.line_body)
        .text_color(p.ink(3).solid())
        .child(sand::icon(Icon::Plus, 16.0, p.ink(3).solid()))
        .child(t(cx, keys::v5_files::ADD_FILES))
        .on_click(cx.listener(|v, _, _, cx| {
            v.add_menu_open = !v.add_menu_open;
            cx.notify();
        }))
        .into_any_element()
    }

    fn render_toolbar(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let show = self.hovered_module || self.add_menu_open || self.picker_open;
        if !show {
            return div().into_any_element();
        }
        let seg = glass::glass_box(
            ElementId::Name(
                format!("media-seg-{}-{}", self.host.entry, self.host.module.id).into(),
            ),
            GlassKind::Surface,
            Mode::default(),
            false,
            Spec::new(Tone::Clear, (g::PILL_HEIGHT + 2.0 * g::TRAY_PADDING) / 2.0).filled(p.page),
            window,
            cx,
        )
        .flex()
        .flex_row()
        .items_center()
        .gap(px(2.0))
        .p(px(g::TRAY_PADDING))
        .rounded(px((g::PILL_HEIGHT + 2.0 * g::TRAY_PADDING) / 2.0))
        .bg(p.page.solid())
        .child(
            IconButton::new(
                ElementId::Name(
                    format!(
                        "media-arr-featured-{}-{}",
                        self.host.entry, self.host.module.id
                    )
                    .into(),
                ),
                Icon::Image,
            )
            .in_tray()
            .selected(self.arrangement == "featured")
            .label(t(cx, keys::v5_files::LAYOUT_FEATURED))
            .on_click(cx.listener(|v, _, _, cx| v.set_arrangement(Some("featured"), cx))),
        )
        .child(
            IconButton::new(
                ElementId::Name(
                    format!("media-arr-grid-{}-{}", self.host.entry, self.host.module.id).into(),
                ),
                Icon::ViewGrid,
            )
            .in_tray()
            .selected(self.arrangement == "grid")
            .label(t(cx, keys::v5_files::LAYOUT_GRID))
            .on_click(cx.listener(|v, _, _, cx| v.set_arrangement(Some("grid"), cx))),
        )
        .child(
            IconButton::new(
                ElementId::Name(
                    format!("media-arr-list-{}-{}", self.host.entry, self.host.module.id).into(),
                ),
                Icon::ViewList,
            )
            .in_tray()
            .selected(self.arrangement == "list")
            .label(t(cx, keys::v5_files::LAYOUT_LIST))
            .on_click(cx.listener(|v, _, _, cx| v.set_arrangement(Some("list"), cx))),
        );

        let mut bar = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .child(seg);
        if self.own_arrangement {
            bar = bar.child(
                IconButton::new(
                    ElementId::Name(
                        format!(
                            "media-arr-reset-{}-{}",
                            self.host.entry, self.host.module.id
                        )
                        .into(),
                    ),
                    Icon::Rotate,
                )
                .label(t(cx, keys::v5_files::RESET_ARRANGEMENT))
                .on_click(cx.listener(|v, _, _, cx| v.set_arrangement(None, cx))),
            );
        }
        bar = bar.child(
            IconButton::new(
                ElementId::Name(
                    format!(
                        "media-toolbar-add-{}-{}",
                        self.host.entry, self.host.module.id
                    )
                    .into(),
                ),
                Icon::Plus,
            )
            .selected(self.add_menu_open || self.picker_open)
            .label(t(cx, keys::v5_files::ADD_FILES))
            .on_click(cx.listener(|v, _, _, cx| {
                v.add_menu_open = !v.add_menu_open;
                if v.add_menu_open {
                    v.picker_open = false;
                }
                cx.notify();
            })),
        );
        bar.into_any_element()
    }

    fn render_add_menu(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.add_menu_open {
            return None;
        }
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let base_id = format!("media-add-menu-{}-{}", self.host.entry, self.host.module.id);
        let menu = div()
            .id(ElementId::Name(base_id.clone().into()))
            .relative()
            .occlude()
            .w(px(196.0))
            .p(px(m_tok::PAD_Y))
            .rounded(px(radius::SHEET))
            .bg(p.desk.solid())
            .shadow(float_shadow(p))
            .flex()
            .flex_col()
            .gap(px(2.0))
            .child(slab_edge(p, radius::SHEET))
            .on_mouse_down_out(cx.listener(|v, _, _, cx| {
                v.add_menu_open = false;
                cx.notify();
            }))
            .child(
                div()
                    .id(ElementId::Name(format!("{base_id}-lib").into()))
                    .px(px(8.0))
                    .py(px(6.0))
                    .rounded(px(radius::MENU_ROW))
                    .cursor_pointer()
                    .role(gpui::Role::MenuItem)
                    .hover(move |st| st.bg(p.ink(1).alpha(0.06)))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.ink(1).solid())
                    .child(sand::icon(Icon::Folder, 14.0, p.ink(2).solid()))
                    .child(t(cx, keys::v5_files::PICK_FROM_LIBRARY))
                    .on_click(cx.listener(|v, _, window, cx| v.open_library_picker(window, cx))),
            )
            .child(
                div()
                    .id(ElementId::Name(format!("{base_id}-disk").into()))
                    .px(px(8.0))
                    .py(px(6.0))
                    .rounded(px(radius::MENU_ROW))
                    .cursor_pointer()
                    .role(gpui::Role::MenuItem)
                    .hover(move |st| st.bg(p.ink(1).alpha(0.06)))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.ink(1).solid())
                    .child(sand::icon(Icon::ImagePlus, 14.0, p.ink(2).solid()))
                    .child(t(cx, keys::v5_files::PICK_FROM_COMPUTER))
                    .on_click(cx.listener(|v, _, _, cx| v.pick_from_computer(cx))),
            );
        Some(
            div()
                .absolute()
                .top(px(2.0))
                .right_0()
                .child(deferred(
                    anchored().snap_to_window_with_margin(px(12.0)).child(menu),
                ))
                .into_any_element(),
        )
    }

    fn render_picker(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.picker_open {
            return None;
        }
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let base_id = format!("media-picker-{}-{}", self.host.entry, self.host.module.id);
        let all_count = self
            .picker_data
            .as_ref()
            .map(|d| d.assets.len())
            .unwrap_or(0);
        let mut chips = div().flex().flex_row().flex_wrap().gap(px(4.0));
        let all_selected = self.picker_folder.is_none();
        chips = chips.child(
            div()
                .id(ElementId::Name(format!("{base_id}-chip-all").into()))
                .px(px(8.0))
                .py(px(2.0))
                .rounded(px(999.0))
                .cursor_pointer()
                .role(gpui::Role::Button)
                .bg(if all_selected {
                    p.accent.alpha(0.16)
                } else {
                    p.ink(1).alpha(0.04)
                })
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(if all_selected {
                    p.ink(1).solid()
                } else {
                    p.ink(3).solid()
                })
                .child(format!(
                    "{} {all_count}",
                    t(cx, keys::v5_files::ALL_FOLDERS)
                ))
                .on_click(cx.listener(|v, _, _, cx| {
                    v.picker_folder = None;
                    cx.notify();
                })),
        );
        if let Some(data) = &self.picker_data {
            for folder in &data.folders {
                let mut set = HashSet::new();
                collect_folder_subtree(&data.folders, &folder.id, &mut set);
                let count = data
                    .assets
                    .iter()
                    .filter(|a| a.folder.as_deref().is_some_and(|f| set.contains(f)))
                    .count();
                let selected = self.picker_folder.as_deref() == Some(folder.id.as_str());
                let fid = folder.id.clone();
                chips = chips.child(
                    div()
                        .id(ElementId::Name(
                            format!("{base_id}-chip-{}", folder.id).into(),
                        ))
                        .px(px(8.0))
                        .py(px(2.0))
                        .rounded(px(999.0))
                        .cursor_pointer()
                        .role(gpui::Role::Button)
                        .bg(if selected {
                            p.accent.alpha(0.16)
                        } else {
                            p.ink(1).alpha(0.04)
                        })
                        .font_role(Role::Index)
                        .type_px(s.caption, s.line_caption)
                        .text_color(if selected {
                            p.ink(1).solid()
                        } else {
                            p.ink(3).solid()
                        })
                        .child(format!("{} {count}", folder.name))
                        .on_click(cx.listener(move |v, _, _, cx| {
                            v.picker_folder = Some(fid.clone());
                            cx.notify();
                        })),
                );
            }
        }

        let shown = self.filtered_picker_assets();
        let mut grid = div()
            .max_h(px(248.0))
            .id(ElementId::Name(format!("{base_id}-grid").into()))
            .overflow_y_scroll()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(6.0));
        if shown.is_empty() {
            grid = grid.child(
                div()
                    .w_full()
                    .py(px(18.0))
                    .flex()
                    .justify_center()
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.ink(4).solid())
                    .child(t(cx, keys::v5_files::EMPTY)),
            );
        } else {
            for a in shown {
                let thumb = self
                    .picker_data
                    .as_ref()
                    .and_then(|d| d.thumbs.get(&a.id).cloned());
                let is_pdf = a.kind == "pdf";
                let aid = a.id.clone();
                let already = self.items.iter().any(|i| i.asset == a.id);
                grid = grid.child(
                    div()
                        .id(ElementId::Name(format!("{base_id}-cell-{}", a.id).into()))
                        .w(px(100.0))
                        .p(px(4.0))
                        .rounded(px(radius::SM))
                        .cursor_pointer()
                        .role(gpui::Role::Button)
                        .aria_label(a.name.clone())
                        .when(already, |d| d.opacity(0.6))
                        .hover(move |st| st.bg(p.ink(1).alpha(0.06)))
                        .flex()
                        .flex_col()
                        .gap(px(3.0))
                        .child(
                            div()
                                .w_full()
                                .h(px(70.0))
                                .rounded(px(4.0))
                                .overflow_hidden()
                                .bg(p.ink(1).alpha(0.05))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(match thumb {
                                    Some(path) => img(path)
                                        .size_full()
                                        .object_fit(if is_pdf {
                                            ObjectFit::Contain
                                        } else {
                                            ObjectFit::Cover
                                        })
                                        .into_any_element(),
                                    None => sand::icon(
                                        if is_pdf { Icon::FileText } else { Icon::Image },
                                        18.0,
                                        p.ink(3).solid(),
                                    )
                                    .into_any_element(),
                                }),
                        )
                        .child(
                            div()
                                .w_full()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .font_role(Role::Ui)
                                .type_px(s.caption, s.line_caption)
                                .text_color(p.ink(2).solid())
                                .child(a.name),
                        )
                        .on_click(cx.listener(move |v, _, _, cx| {
                            v.picker_open = false;
                            v.put_assets(vec![aid.clone()], cx);
                            cx.notify();
                        })),
                );
            }
        }

        let card = div()
            .id(ElementId::Name(base_id.clone().into()))
            .relative()
            .occlude()
            .w(px(340.0))
            .p(px(10.0))
            .rounded(px(radius::SHEET))
            .bg(p.desk.solid())
            .shadow(float_shadow(p))
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(slab_edge(p, radius::SHEET))
            .on_mouse_down_out(cx.listener(|v, _, _, cx| {
                v.picker_open = false;
                cx.notify();
            }))
            .child(self.picker_search.clone())
            .child(chips)
            .child(grid)
            .child(div().h(px(1.0)).w_full().bg(p.hairline()))
            .child(
                div()
                    .id(ElementId::Name(format!("{base_id}-from-disk").into()))
                    .px(px(8.0))
                    .py(px(5.0))
                    .rounded(px(radius::MENU_ROW))
                    .cursor_pointer()
                    .role(gpui::Role::MenuItem)
                    .hover(move |st| st.bg(p.ink(1).alpha(0.06)))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .font_role(Role::Index)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.ink(2).solid())
                    .weight(weight::MEDIUM)
                    .child(sand::icon(Icon::ImagePlus, 14.0, p.ink(2).solid()))
                    .child(t(cx, keys::v5_files::PICK_FROM_COMPUTER))
                    .on_click(cx.listener(|v, _, _, cx| v.pick_from_computer(cx))),
            );
        Some(
            div()
                .absolute()
                .top(px(2.0))
                .right_0()
                .child(deferred(
                    anchored().snap_to_window_with_margin(px(12.0)).child(card),
                ))
                .into_any_element(),
        )
    }
}

impl Render for MediaModule {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Theme::of(window, cx).palette;
        let wash = p.accent.alpha(0.10);
        let ring = p.accent.alpha(0.45);
        let root_id = format!("v3-media-{}-{}", self.host.entry, self.host.module.id);
        let dbg_id = root_id.clone();

        let body = if self.items.is_empty() {
            self.render_empty_add(window, cx)
        } else {
            match self.arrangement.as_str() {
                "grid" => self.render_grid(window, cx),
                "list" => self.render_list(window, cx),
                _ => self.render_featured(window, cx),
            }
        };

        div()
            .id(ElementId::Name(root_id.into()))
            .debug_selector(move || dbg_id.clone())
            .relative()
            .w_full()
            .rounded(px(radius::SM))
            .border_1()
            .border_color(gpui::transparent_black())
            .on_hover(cx.listener(|v, on: &bool, _, cx| {
                v.hovered_module = *on;
                cx.notify();
            }))
            .drag_over::<AssetDrag>(move |st, _, _, _| st.bg(wash).border_color(ring))
            .on_drop(cx.listener(|v, drag: &AssetDrag, _, cx| {
                v.drop_library_drag(drag, cx);
            }))
            .drag_over::<ExternalPaths>(move |st, _, _, _| st.bg(wash).border_color(ring))
            .on_drop(cx.listener(|v, paths: &ExternalPaths, _, cx| {
                v.import_and_put_paths(paths.paths().to_vec(), cx);
            }))
            .child(
                div()
                    .absolute()
                    .top(px(-32.0))
                    .left_0()
                    .right_0()
                    .h(px(32.0))
                    .flex()
                    .items_center()
                    .justify_end()
                    .child(self.render_toolbar(window, cx)),
            )
            .child(body)
            .children(self.render_add_menu(window, cx))
            .children(self.render_picker(window, cx))
    }
}

fn best_thumb_path(store: &dr_store::Library, asset_id: &str) -> Option<PathBuf> {
    store
        .asset(asset_id, Variant::Thumbnail)
        .ok()
        .flatten()
        .or_else(|| store.asset(asset_id, Variant::Display).ok().flatten())
        .or_else(|| store.asset(asset_id, Variant::Source).ok().flatten())
        .map(|r| r.path)
}

fn best_display_path(store: &dr_store::Library, asset_id: &str) -> Option<PathBuf> {
    store
        .asset(asset_id, Variant::Display)
        .ok()
        .flatten()
        .or_else(|| store.asset(asset_id, Variant::Source).ok().flatten())
        .or_else(|| store.asset(asset_id, Variant::Thumbnail).ok().flatten())
        .map(|r| r.path)
}

type LoadedMediaState = (Vec<MediaItem>, String, bool, HashMap<String, AssetMeta>);

fn load_module_state(
    lib: &dr_workspace::Workspace,
    target: ModuleIn,
) -> Result<LoadedMediaState, dr_workspace::WsError> {
    let book = target.book.clone();
    let data = lib.run::<ModuleRead>(&Actor::User, target)?.output;
    let arrangement = data.arrangement.unwrap_or_else(|| "featured".into());
    let own_arrangement = data.own_arrangement;
    let mut items = data.media;
    items.sort_by(|a, b| {
        let pa = a.pos.as_deref().and_then(|s| PosKey::parse(s).ok());
        let pb = b.pos.as_deref().and_then(|s| PosKey::parse(s).ok());
        dr_model::pos::cmp_pos((pa.as_ref(), &a.id), (pb.as_ref(), &b.id))
    });

    let needed: HashSet<String> = items.iter().map(|i| i.asset.clone()).collect();
    let raw_map: HashMap<String, (dr_model::shared::Asset, Vec<String>, bool)> =
        if needed.is_empty() {
            HashMap::new()
        } else {
            let needed_ids = needed.clone();
            dr_editor::v3::read(lib, &book, move |v| {
                let live_ids: HashSet<String> =
                    v.assets().into_iter().map(|a| a.id.to_string()).collect();
                let raw_folders: HashMap<AssetFolderId, dr_model::shared::AssetFolder> = v
                    .asset_folders_raw()
                    .into_iter()
                    .map(|f| (f.id.clone(), f))
                    .collect();
                let mut map = HashMap::new();
                for a in v.assets_raw() {
                    if !needed_ids.contains(a.id.as_str()) {
                        continue;
                    }
                    let is_live = live_ids.contains(a.id.as_str());
                    let mut trashed_chain = Vec::new();
                    let mut cur = a.folder.clone();
                    let mut visited = HashSet::new();
                    while let Some(fid) = cur {
                        if !visited.insert(fid.clone()) {
                            break;
                        }
                        if let Some(f) = raw_folders.get(&fid) {
                            if f.is_trashed() {
                                trashed_chain.push(f.id.to_string());
                            }
                            cur = f.parent.clone();
                        } else {
                            break;
                        }
                    }
                    trashed_chain.reverse();
                    map.insert(a.id.to_string(), (a, trashed_chain, is_live));
                }
                map
            })?
        };

    let store = lib.library();
    let mut meta = HashMap::new();
    for aid in needed {
        if let Some((a, trashed_folders, is_live)) = raw_map.get(&aid) {
            let thumb = best_thumb_path(store, &aid);
            let display = if a.kind == AssetKind::Pdf {
                thumb.clone()
            } else {
                best_display_path(store, &aid)
            };
            let pages = if a.kind == AssetKind::Pdf {
                dr_view_material::media::read_pdf(store, &aid)
                    .and_then(dr_view_material::media::PdfDoc::open)
                    .ok()
                    .map(|d| d.pages.len())
            } else {
                None
            };
            meta.insert(
                aid,
                AssetMeta {
                    id: a.id.to_string(),
                    name: a.name.clone(),
                    kind: a.kind.clone(),
                    width: a.width,
                    height: a.height,
                    pages,
                    thumb,
                    display,
                    trashed: !*is_live,
                    restorable_in_book: !*is_live,
                    trashed_folders: trashed_folders.clone(),
                    self_trashed: a.is_trashed(),
                },
            );
        } else {
            meta.insert(
                aid.clone(),
                AssetMeta {
                    id: aid,
                    name: String::new(),
                    kind: AssetKind::Image,
                    width: None,
                    height: None,
                    pages: None,
                    thumb: None,
                    display: None,
                    trashed: true,
                    restorable_in_book: false,
                    trashed_folders: Vec::new(),
                    self_trashed: false,
                },
            );
        }
    }
    for item in &mut items {
        if let Some(m) = meta.get(&item.asset) {
            item.missing = m.trashed;
        }
    }
    Ok((items, arrangement, own_arrangement, meta))
}

fn collect_folder_subtree(folders: &[AssetFolderInfo], root: &str, out: &mut HashSet<String>) {
    if !out.insert(root.to_owned()) {
        return;
    }
    for f in folders {
        if f.parent.as_deref() == Some(root) {
            collect_folder_subtree(folders, &f.id, out);
        }
    }
}

fn expand_drag_assets(
    lib: &dr_workspace::Workspace,
    book: &str,
    mut direct: Vec<String>,
    root_folders: &[String],
) -> Vec<String> {
    let folders = lib
        .run::<AssetFolderList>(
            &Actor::User,
            AssetFolderListIn {
                book: book.to_owned(),
                trashed: false,
            },
        )
        .map(|o| o.output)
        .unwrap_or_default();
    let assets = lib
        .run::<AssetList>(
            &Actor::User,
            ListIn {
                book: book.to_owned(),
                trashed: false,
            },
        )
        .map(|o| o.output)
        .unwrap_or_default();
    let mut subtree = HashSet::new();
    for rf in root_folders {
        collect_folder_subtree(&folders, rf, &mut subtree);
    }
    for a in assets {
        if a.folder.as_deref().is_some_and(|f| subtree.contains(f)) {
            direct.push(a.id);
        }
    }
    let _ = AssetId::parse;
    direct
}
