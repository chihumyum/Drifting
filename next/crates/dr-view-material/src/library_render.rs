//! Rendering and hover cards for `LibraryPanel` and `LibraryHead`
//! (`v5-tracks.md` lines 393–399 & `files-proto.html` Group 1).

use std::collections::HashSet;
use std::rc::Rc;

use dr_i18n::keys;
use dr_shell::book::MaterialInfo;
use dr_shell::nav::{Open, Target as NavTarget};
use dr_shell::pages::UsageFlash;
use dr_shell::strings::tp;
use dr_shell::t;
use dr_shell::workspace::SuperView;
use dr_ui::Theme;
use dr_ui::components::{CardAction, CardBody, EmptyState, HoverCard, IconButton, SandCell};
use dr_ui::fonts::{Role, weight};
use dr_ui::glass::{self, Kind as GlassKind, Mode, Spec, Tone};
use dr_ui::sand::{self, Icon, KindMark, SandFrame};
use dr_ui::style::DrStyled;
use dr_ui::tokens::{menu as m, radius};
use dr_workspace::commands::asset::{AssetFolderInfo, AssetInfo};
use dr_workspace::dto::GroupInfo;
use gpui::{
    AnyElement, App, AppContext as _, ClickEvent, Context, ElementId, Entity, ExternalPaths,
    InteractiveElement, IntoElement, ObjectFit, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, StyledImage as _, Subscription, Window, canvas, div, img,
    prelude::FluentBuilder, px,
};

use crate::card;
use crate::folders::{self, Entry, Tree};
use crate::library::{
    ClearSelection, DragGhost, KEY_CONTEXT, LibraryPanel, MaterialDrag, PasteFiles, SelectAll,
    ViewMode,
};
use crate::library_data::CurrentItem;
use crate::page::MediaKind;
use crate::previews;

type RowAction = Rc<dyn Fn(&mut LibraryPanel, &mut Window, &mut Context<LibraryPanel>)>;

enum MasonryEntry<'a> {
    Folder(&'a GroupInfo, Vec<&'a MaterialInfo>, usize),
    File(&'a MaterialInfo, Option<SharedString>),
}

impl LibraryPanel {
    fn subline_of(&self, m: &MaterialInfo, cx: &App) -> SharedString {
        let kind = card::kind_label(&m.kind, cx);
        let n = self.usage_count(&m.id);
        if n > 0 {
            let count = tp(cx, keys::v5_files::USAGE_COUNT, n as u64, &[("count", &n)]);
            format!("{kind} · {count}").into()
        } else {
            kind
        }
    }

    fn file_meta_line(&self, m: &MaterialInfo, cx: &mut App) -> SharedString {
        let mut parts = vec![card::kind_label(&m.kind, cx).to_string()];
        let info = self.asset_info(&m.id);
        match m.kind.as_str() {
            "image" => {
                if let Some((w, h)) = info.and_then(|a| a.width.zip(a.height)) {
                    parts.push(format!("{w} × {h}"));
                } else if let Some(asset) = m.asset.as_deref()
                    && let Some(pic) = previews::thumbnail(asset, MediaKind::Image, cx)
                {
                    parts.push(format!("{} × {}", pic.width, pic.height));
                }
            }
            "pdf" => {
                if let Some(asset) = m.asset.as_deref()
                    && let Some(pages) = previews::pdf_pages(asset, cx)
                {
                    parts.push(
                        tp(
                            cx,
                            keys::v5_files::PAGE_COUNT,
                            pages as u64,
                            &[("count", &pages)],
                        )
                        .to_string(),
                    );
                }
            }
            _ => {}
        }
        if let Some(size) = info.map(|a| a.size).filter(|s| *s > 0) {
            parts.push(previews::format_bytes(size));
        }
        parts.join(" · ").into()
    }

    fn aspect_h_over_w(&self, m: &MaterialInfo, cx: &mut App) -> f32 {
        if m.kind == "image"
            && let Some((w, h)) = self.asset_info(&m.id).and_then(|a| a.width.zip(a.height))
            && w > 0
            && h > 0
        {
            return (h as f32 / w as f32).clamp(0.45, 2.2);
        }
        if let Some((kind, asset)) = MediaKind::parse(&m.kind).zip(m.asset.as_deref())
            && let Some(pic) = previews::thumbnail(asset, kind, cx)
            && pic.width > 0
            && pic.height > 0
        {
            return (pic.height as f32 / pic.width as f32).clamp(0.45, 2.2);
        }
        if m.kind == "pdf" { 1.38 } else { 0.75 }
    }

    fn flash_strength(&self, asset_id: &str, window: &mut Window, cx: &mut App) -> f32 {
        UsageFlash::strength_for(&[format!("library-asset:{asset_id}")], window, cx)
    }

    fn drop_folder_for(&self, entry: &Entry) -> Option<String> {
        match entry {
            Entry::Folder { id, .. } => Some(id.clone()),
            Entry::Material { id, .. } => self
                .live_materials()
                .iter()
                .find(|m| &m.id == id)
                .and_then(|m| m.folder.clone())
                .filter(|f| self.live_folders().iter().any(|x| &x.id == f)),
        }
    }

    fn wrap_hover_card(
        &self,
        id_prefix: &str,
        key: &str,
        target: AnyElement,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if self.renaming.is_some() {
            return target;
        }
        let card_id = ElementId::Name(format!("library-card-{id_prefix}-{key}").into());
        let entity = cx.entity();
        let card_key = key.to_owned();
        HoverCard::new(card_id, target, move |window, cx| {
            entity.update(cx, |p, cx| p.card(&card_key, window, cx))
        })
        .beside()
        .force_open(self.card_open.as_deref() == Some(key))
        .into_any_element()
    }

    fn list_row(
        &self,
        entry: &Entry,
        active: Option<&str>,
        id_prefix: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let key = entry.key();
        let this = cx.entity();
        let selected = self.picker.is_selected(&key);
        let is_active = matches!(entry, Entry::Material { id, .. } if Some(id.as_str()) == active);
        let flash = match entry {
            Entry::Material { id, .. } => self.flash_strength(id, window, cx) > 0.0,
            Entry::Folder { .. } => false,
        };
        let rid = |part: &str| ElementId::Name(format!("library-{id_prefix}-{part}-{key}").into());

        let cell: AnyElement = if let Some(r) = self.renaming.as_ref().filter(|r| r.key == key) {
            div()
                .relative()
                .min_h(px(theme.scale.row_height))
                .px(px(10.0))
                .py(px(4.0))
                .flex()
                .items_center()
                .child(SandFrame::new(rid("rename-frame"), is_active || flash))
                .child(div().flex_1().child(r.field.clone()))
                .into_any_element()
        } else {
            let (k, click) = (key.clone(), this.clone());
            let on_click = move |e: &ClickEvent, window: &mut Window, cx: &mut App| {
                click.update(cx, |p, cx| p.click(&k, e, window, cx))
            };
            match entry {
                Entry::Folder {
                    name, open, count, ..
                } => {
                    let lead = div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(4.0))
                        .child(sand::icon(
                            if *open {
                                Icon::ChevronDown
                            } else {
                                Icon::ChevronRight
                            },
                            11.0,
                            p.ink(4).solid(),
                        ))
                        .child(sand::icon(
                            if *open {
                                Icon::FolderOpen
                            } else {
                                Icon::Folder
                            },
                            14.0,
                            p.ink(3).solid(),
                        ));
                    SandCell::new(rid("cell"), name.clone())
                        .font(Role::Structure)
                        .lead(lead)
                        .child(
                            div()
                                .flex_none()
                                .font_role(Role::Index)
                                .type_px(theme.scale.caption, theme.scale.line_caption)
                                .text_color(p.muted().solid())
                                .child(count.to_string()),
                        )
                        .on_click(on_click)
                        .into_any_element()
                }
                Entry::Material { id, .. } => {
                    let Some(m) = self.live_materials().iter().find(|m| &m.id == id) else {
                        return div().into_any_element();
                    };
                    let title: SharedString = if m.title.trim().is_empty() {
                        t(cx, keys::top_timeline::untitled::LIBRARY_ITEM)
                    } else {
                        m.title.clone().into()
                    };
                    let sub = self.subline_of(m, cx);
                    let lead = card::thumb(m, 40.0, window, cx);
                    SandCell::new(rid("cell"), title)
                        .lead(lead)
                        .subline(sub)
                        .selected(is_active || flash)
                        .on_click(on_click)
                        .into_any_element()
                }
            }
        };

        let target = self.picker.target(&key);
        let t_len = target.len();
        let label: SharedString = if t_len > 1 {
            tp(
                cx,
                keys::v5_files::ITEM_COUNT,
                t_len as u64,
                &[("count", &t_len)],
            )
        } else {
            self.name_of(&key).into()
        };
        let drag = MaterialDrag {
            selection: target,
            label,
        };
        let into = self.drop_folder_for(entry);
        let (into_a, into_b) = (into.clone(), into);
        let material_target = match entry {
            Entry::Material { id, .. } => Some(id.clone()),
            Entry::Folder { .. } => None,
        };
        let wash = p.accent.alpha(0.12);
        let with_card = self.wrap_hover_card(id_prefix, &key, cell, cx);
        div()
            .id(rid("row"))
            .pl(px(entry.depth() as f32 * 18.0))
            .rounded(px(radius::SM))
            .when(selected && !is_active, |d| d.bg(p.accent.alpha(0.08)))
            .on_drag(drag, |drag, _, _, cx| {
                cx.new(|_| DragGhost {
                    label: drag.label.clone(),
                })
            })
            .drag_over::<MaterialDrag>(move |st, _, _, _| st.bg(wash))
            .on_drop(cx.listener(move |p, drag: &MaterialDrag, _, cx| {
                if let Some(before_id) = &material_target
                    && drag.selection.folders.is_empty()
                    && drag.selection.materials.len() == 1
                {
                    p.reorder_material_before(&drag.selection.materials[0], before_id, cx);
                } else {
                    p.move_to(drag.selection.clone(), into_a.clone(), cx);
                }
            }))
            .drag_over::<ExternalPaths>(move |st, _, _, _| st.bg(wash))
            .on_drop(cx.listener(move |p, paths: &ExternalPaths, _, cx| {
                p.import_paths(paths.paths().to_vec(), into_b.clone(), cx)
            }))
            .child(with_card)
            .into_any_element()
    }

    fn current_list_row(
        &self,
        item: &CurrentItem,
        active: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(m) = self.live_materials().iter().find(|m| m.id == item.asset_id) else {
            return div().into_any_element();
        };
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let key = folders::material_key(&m.id);
        let is_active = active == Some(m.id.as_str());
        let flash = self.flash_strength(&m.id, window, cx) > 0.0;
        let selected = self.picker.is_selected(&key);
        let rid = |part: &str| ElementId::Name(format!("library-cur-{part}-{key}").into());
        let title: SharedString = if m.title.trim().is_empty() {
            t(cx, keys::top_timeline::untitled::LIBRARY_ITEM)
        } else {
            m.title.clone().into()
        };
        let click = cx.entity();
        let k = key.clone();
        let cell = if let Some(r) = self.renaming.as_ref().filter(|r| r.key == key) {
            div()
                .relative()
                .min_h(px(34.0))
                .px(px(8.0))
                .py(px(3.0))
                .flex()
                .items_center()
                .child(SandFrame::new(rid("rename-frame"), is_active || flash))
                .child(div().flex_1().child(r.field.clone()))
                .into_any_element()
        } else {
            SandCell::new(rid("cell"), title)
                .lead(card::thumb(m, 28.0, window, cx))
                .selected(is_active || flash)
                .child(
                    div()
                        .flex_none()
                        .font_role(Role::Ui)
                        .type_px(theme.scale.caption, theme.scale.line_caption)
                        .text_color(p.ink(4).solid())
                        .child(item.module_name.clone()),
                )
                .on_click(move |e: &ClickEvent, window: &mut Window, cx: &mut App| {
                    click.update(cx, |p, cx| p.click(&k, e, window, cx))
                })
                .into_any_element()
        };
        let drag = MaterialDrag {
            selection: self.picker.target(&key),
            label: self.name_of(&key).into(),
        };
        let with_card = self.wrap_hover_card("cur", &key, cell, cx);
        div()
            .id(rid("row"))
            .rounded(px(radius::SM))
            .when(selected && !is_active, |d| d.bg(p.accent.alpha(0.08)))
            .on_drag(drag, |drag, _, _, cx| {
                cx.new(|_| DragGhost {
                    label: drag.label.clone(),
                })
            })
            .child(with_card)
            .into_any_element()
    }

    fn masonry_grid<'a>(
        &self,
        items: Vec<MasonryEntry<'a>>,
        active: Option<&str>,
        id_prefix: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let col_gap = 6.0;
        let col_w = ((self.list_width - 24.0 - col_gap) / 2.0).max(96.0);
        let mut left: Vec<AnyElement> = Vec::new();
        let mut right: Vec<AnyElement> = Vec::new();
        let (mut left_h, mut right_h) = (0.0f32, 0.0f32);

        for item in items {
            let (norm_h, el) = match item {
                MasonryEntry::Folder(f, previews, count) => {
                    let el =
                        self.masonry_folder_card(f, &previews, count, col_w, id_prefix, window, cx);
                    (1.28, el)
                }
                MasonryEntry::File(m, module_tag) => {
                    let ratio = self.aspect_h_over_w(m, cx);
                    let el = self.masonry_file_card(
                        m, module_tag, col_w, ratio, active, id_prefix, window, cx,
                    );
                    (ratio + 0.34, el)
                }
            };
            if left_h <= right_h {
                left_h += norm_h;
                left.push(el);
            } else {
                right_h += norm_h;
                right.push(el);
            }
        }

        div()
            .w_full()
            .flex()
            .flex_row()
            .items_start()
            .gap(px(col_gap))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(col_gap))
                    .children(left),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(col_gap))
                    .children(right),
            )
            .into_any_element()
    }

    #[allow(clippy::too_many_arguments)]
    fn masonry_file_card(
        &self,
        m: &MaterialInfo,
        module_tag: Option<SharedString>,
        col_w: f32,
        h_over_w: f32,
        active: Option<&str>,
        id_prefix: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let key = folders::material_key(&m.id);
        let is_active = active == Some(m.id.as_str());
        let flash = self.flash_strength(&m.id, window, cx) > 0.0;
        let selected = self.picker.is_selected(&key);
        let pic_w = (col_w - 12.0).max(76.0);
        let pic_h = (pic_w * h_over_w).round().clamp(52.0, 280.0);
        let rid =
            |part: &str| ElementId::Name(format!("library-mc-{id_prefix}-{part}-{key}").into());

        let picture = MediaKind::parse(&m.kind)
            .zip(m.asset.as_deref())
            .and_then(|(kind, asset)| previews::thumbnail(asset, kind, cx));
        let pic_box = div()
            .w(px(pic_w))
            .h(px(pic_h))
            .overflow_hidden()
            .rounded(px(radius::SM))
            .border_1()
            .border_color(p.hairline())
            .bg(p.page.alpha(0.75));
        let pic_box = match picture {
            Some(pic) => pic_box.child(img(pic.image).size_full().object_fit(ObjectFit::Cover)),
            None => pic_box
                .flex()
                .items_center()
                .justify_center()
                .child(sand::icon(
                    if m.kind == "pdf" {
                        Icon::FileText
                    } else {
                        Icon::Image
                    },
                    20.0,
                    p.ink(4).solid(),
                )),
        };

        let title_el: AnyElement = if let Some(r) = self.renaming.as_ref().filter(|r| r.key == key)
        {
            div().w_full().child(r.field.clone()).into_any_element()
        } else {
            let title: SharedString = if m.title.trim().is_empty() {
                t(cx, keys::top_timeline::untitled::LIBRARY_ITEM)
            } else {
                m.title.clone().into()
            };
            div()
                .w_full()
                .overflow_hidden()
                .whitespace_nowrap()
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .weight(weight::MEDIUM)
                .text_color(p.ink(1).solid())
                .child(title)
                .into_any_element()
        };
        let sub = module_tag.unwrap_or_else(|| self.subline_of(m, cx));
        let click = cx.entity();
        let k = key.clone();

        let card_box = glass::glass_box(
            rid("box"),
            GlassKind::Hidden,
            Mode::default(),
            selected && !is_active,
            Spec::new(Tone::Clear, radius::SM),
            window,
            cx,
        )
        .relative()
        .w_full()
        .p(px(6.0))
        .flex()
        .flex_col()
        .gap(px(5.0))
        .rounded(px(radius::SM))
        .cursor_pointer()
        .child(SandFrame::new(rid("frame"), is_active || flash))
        .child(pic_box)
        .child(title_el)
        .child(
            div()
                .w_full()
                .overflow_hidden()
                .whitespace_nowrap()
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.muted().solid())
                .child(sub),
        )
        .on_click(move |e: &ClickEvent, window: &mut Window, cx: &mut App| {
            click.update(cx, |p, cx| p.click(&k, e, window, cx))
        })
        .into_any_element();

        let drag = MaterialDrag {
            selection: self.picker.target(&key),
            label: self.name_of(&key).into(),
        };
        let before_id = m.id.clone();
        let into = m
            .folder
            .clone()
            .filter(|fid| self.live_folders().iter().any(|f| &f.id == fid));
        let wash = p.accent.alpha(0.12);
        let with_card = self.wrap_hover_card(id_prefix, &key, card_box, cx);
        div()
            .id(rid("wrap"))
            .w_full()
            .on_drag(drag, |drag, _, _, cx| {
                cx.new(|_| DragGhost {
                    label: drag.label.clone(),
                })
            })
            .drag_over::<MaterialDrag>(move |st, _, _, _| st.bg(wash))
            .on_drop(cx.listener(move |p, drag: &MaterialDrag, _, cx| {
                if drag.selection.folders.is_empty() && drag.selection.materials.len() == 1 {
                    p.reorder_material_before(&drag.selection.materials[0], &before_id, cx);
                } else {
                    p.move_to(drag.selection.clone(), into.clone(), cx);
                }
            }))
            .child(with_card)
            .into_any_element()
    }

    #[allow(clippy::too_many_arguments)]
    fn masonry_folder_card(
        &self,
        folder: &GroupInfo,
        previews_in: &[&MaterialInfo],
        count: usize,
        col_w: f32,
        id_prefix: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let key = folders::folder_key(&folder.id);
        let selected = self.picker.is_selected(&key);
        let mos_side = (col_w - 12.0).max(76.0);
        let cell_side = ((mos_side - 2.0) / 2.0).floor().max(32.0);
        let rid =
            |part: &str| ElementId::Name(format!("library-mf-{id_prefix}-{part}-{key}").into());

        let mosaic_cell = |idx: usize, _window: &mut Window, cx: &mut App| -> AnyElement {
            let slot = div()
                .size(px(cell_side))
                .overflow_hidden()
                .bg(p.page.alpha(0.65))
                .border_1()
                .border_color(p.hairline());
            if let Some(m) = previews_in.get(idx) {
                if let Some((kind, asset)) = MediaKind::parse(&m.kind).zip(m.asset.as_deref())
                    && let Some(pic) = previews::thumbnail(asset, kind, cx)
                {
                    return slot
                        .child(img(pic.image).size_full().object_fit(ObjectFit::Cover))
                        .into_any_element();
                }
                return slot
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(sand::icon(
                        if m.kind == "pdf" {
                            Icon::FileText
                        } else {
                            Icon::Image
                        },
                        14.0,
                        p.ink(4).solid(),
                    ))
                    .into_any_element();
            }
            slot.into_any_element()
        };

        let c0 = mosaic_cell(0, window, cx);
        let c1 = mosaic_cell(1, window, cx);
        let c2 = mosaic_cell(2, window, cx);
        let c3 = mosaic_cell(3, window, cx);
        let mosaic = div()
            .w(px(mos_side))
            .h(px(mos_side))
            .overflow_hidden()
            .rounded(px(radius::SM))
            .flex()
            .flex_col()
            .gap(px(2.0))
            .child(div().flex().flex_row().gap(px(2.0)).child(c0).child(c1))
            .child(div().flex().flex_row().gap(px(2.0)).child(c2).child(c3));

        let name_row: AnyElement = if let Some(r) = self.renaming.as_ref().filter(|r| r.key == key)
        {
            div().w_full().child(r.field.clone()).into_any_element()
        } else {
            div()
                .w_full()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .child(sand::icon(Icon::Folder, 13.0, p.ink(3).solid()))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .font_role(Role::Structure)
                        .type_px(s.secondary, s.line_body)
                        .text_color(p.ink(1).solid())
                        .child(folder.name.clone()),
                )
                .child(
                    div()
                        .flex_none()
                        .font_role(Role::Index)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.muted().solid())
                        .child(count.to_string()),
                )
                .into_any_element()
        };

        let click = cx.entity();
        let fid = folder.id.clone();
        let card_box = glass::glass_box(
            rid("box"),
            GlassKind::Hidden,
            Mode::default(),
            selected,
            Spec::new(Tone::Clear, radius::SM),
            window,
            cx,
        )
        .w_full()
        .p(px(6.0))
        .flex()
        .flex_col()
        .gap(px(5.0))
        .rounded(px(radius::SM))
        .cursor_pointer()
        .child(mosaic)
        .child(name_row)
        .on_click(move |_, _, cx| {
            let fid = fid.clone();
            click.update(cx, |p, cx| p.set_masonry_folder(Some(fid), cx));
        })
        .into_any_element();

        let drag = MaterialDrag {
            selection: self.picker.target(&key),
            label: folder.name.clone().into(),
        };
        let into_a = Some(folder.id.clone());
        let into_b = Some(folder.id.clone());
        let wash = p.accent.alpha(0.12);
        let with_card = self.wrap_hover_card(id_prefix, &key, card_box, cx);
        div()
            .id(rid("wrap"))
            .w_full()
            .on_drag(drag, |drag, _, _, cx| {
                cx.new(|_| DragGhost {
                    label: drag.label.clone(),
                })
            })
            .drag_over::<MaterialDrag>(move |st, _, _, _| st.bg(wash))
            .on_drop(cx.listener(move |p, drag: &MaterialDrag, _, cx| {
                p.move_to(drag.selection.clone(), into_a.clone(), cx)
            }))
            .drag_over::<ExternalPaths>(move |st, _, _, _| st.bg(wash))
            .on_drop(cx.listener(move |p, paths: &ExternalPaths, _, cx| {
                p.import_paths(paths.paths().to_vec(), into_b.clone(), cx)
            }))
            .child(with_card)
            .into_any_element()
    }

    fn trashed_folder_row(
        &self,
        folder: &AssetFolderInfo,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let key = format!("tf:{}", folder.id);
        let rid = |part: &str| ElementId::Name(format!("library-trash-{part}-{key}").into());
        let cell = SandCell::new(rid("cell"), folder.name.clone())
            .font(Role::Structure)
            .lead(sand::icon(Icon::Folder, 14.0, p.ink(4).solid()))
            .into_any_element();
        let with_card = self.wrap_hover_card("trash", &key, cell, cx);
        div()
            .id(rid("row"))
            .opacity(0.55)
            .child(with_card)
            .into_any_element()
    }

    fn trashed_asset_row(
        &self,
        asset: &AssetInfo,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = format!("ti:{}", asset.id);
        let rid = |part: &str| ElementId::Name(format!("library-trash-{part}-{key}").into());
        let info = MaterialInfo {
            id: asset.id.clone(),
            title: asset.name.clone(),
            kind: asset.kind.clone(),
            asset: Some(asset.id.clone()),
            folder: asset.folder.clone(),
            pos: asset.pos.clone(),
            task_todos: false,
            description: String::new(),
            entry: None,
            module: None,
        };
        let title: SharedString = if info.title.trim().is_empty() {
            t(cx, keys::top_timeline::untitled::LIBRARY_ITEM)
        } else {
            info.title.clone().into()
        };
        let sub = card::kind_label(&info.kind, cx);
        let cell = SandCell::new(rid("cell"), title)
            .lead(card::thumb(&info, 40.0, window, cx))
            .subline(sub)
            .into_any_element();
        let with_card = self.wrap_hover_card("trash", &key, cell, cx);
        div()
            .id(rid("row"))
            .opacity(0.55)
            .child(with_card)
            .into_any_element()
    }

    fn section_header(
        id: &'static str,
        title: SharedString,
        count: Option<usize>,
        collapsed: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
        on_toggle: impl Fn(&mut Self, &mut Context<Self>) + 'static,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        div()
            .id(id)
            .h(px(24.0))
            .px(px(6.0))
            .rounded(px(radius::SM))
            .cursor_pointer()
            .hover(move |st| st.bg(p.ink(1).alpha(0.04)))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(5.0))
            .child(
                div()
                    .font_role(Role::Ui)
                    .type_px(s.caption, s.line_caption)
                    .weight(weight::MEDIUM)
                    .text_color(p.ink(3).solid())
                    .child(title),
            )
            .when_some(count, |d, n| {
                d.child(
                    div()
                        .font_role(Role::Index)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.ink(4).solid())
                        .child(n.to_string()),
                )
            })
            .child(div().flex_1())
            .child(sand::icon(
                if collapsed {
                    Icon::ChevronRight
                } else {
                    Icon::ChevronDown
                },
                11.0,
                p.ink(4).solid(),
            ))
            .on_click(cx.listener(move |p, _: &ClickEvent, _, cx| on_toggle(p, cx)))
            .into_any_element()
    }

    /// Hover card for a live file, live folder, multi-selection, or trashed item.
    pub(crate) fn card(
        &mut self,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let this = cx.entity();
        let id = |part: &str| ElementId::Name(format!("library-hc-{part}-{key}").into());
        let title: SharedString = {
            let name = self.name_of(key);
            if name.trim().is_empty() {
                t(cx, keys::top_timeline::untitled::LIBRARY_ITEM)
            } else {
                name.into()
            }
        };
        let action = |part: &str, icon: Icon, label: SharedString, run: RowAction| {
            let entity = this.clone();
            CardAction::new(id(part), icon, label)
                .on_click(move |_, window, cx| {
                    let run = run.clone();
                    entity.update(cx, |p, cx| {
                        p.card_open = None;
                        run(p, window, cx);
                    })
                })
                .into_any_element()
        };

        // Trashed folder in Recently Deleted (`恢复`, `永久删除`).
        if let Some(fid) = key.strip_prefix("tf:") {
            let fid_restore = fid.to_owned();
            let fid_purge = fid.to_owned();
            let restore = action(
                "restore",
                Icon::Rotate,
                t(cx, keys::v5_files::RESTORE),
                Rc::new(move |p, _, cx| p.restore_trashed_folder(fid_restore.clone(), cx)),
            );
            let purge = CardAction::new(id("purge"), Icon::Trash, t(cx, keys::v5_files::PURGE))
                .danger()
                .on_click({
                    let entity = this.clone();
                    move |_, _, cx| {
                        let fid = fid_purge.clone();
                        entity.update(cx, |p, cx| {
                            p.card_open = None;
                            p.purge_trashed_folder(fid, cx);
                        })
                    }
                })
                .into_any_element();
            return CardBody::new(id("body"), title)
                .section(vec![restore])
                .section(vec![purge])
                .into_any_element();
        }

        // Trashed file in Recently Deleted (`恢复`, `永久删除`).
        if let Some(aid) = key.strip_prefix("ti:") {
            let kind = self
                .trashed_assets()
                .iter()
                .find(|a| a.id == aid)
                .map(|a| card::kind_label(&a.kind, cx))
                .unwrap_or_default();
            let aid_restore = aid.to_owned();
            let aid_purge = aid.to_owned();
            let restore = action(
                "restore",
                Icon::Rotate,
                t(cx, keys::v5_files::RESTORE),
                Rc::new(move |p, _, cx| p.restore_trashed_asset(aid_restore.clone(), cx)),
            );
            let purge = CardAction::new(id("purge"), Icon::Trash, t(cx, keys::v5_files::PURGE))
                .danger()
                .on_click({
                    let entity = this.clone();
                    move |_, _, cx| {
                        let aid = aid_purge.clone();
                        entity.update(cx, |p, cx| {
                            p.card_open = None;
                            p.purge_trashed_asset(aid, cx);
                        })
                    }
                })
                .into_any_element();
            return CardBody::new(id("body"), title)
                .meta(kind)
                .section(vec![restore])
                .section(vec![purge])
                .into_any_element();
        }

        let sel = self.picker.target(key);
        let live_folders = self.live_folders().to_vec();
        let live_materials = self.live_materials().to_vec();
        let tree = Tree::new_ordered(&live_folders, &live_materials, None);

        let current_parent = if sel.len() > 1 {
            None
        } else if let Some(f) = sel.folders.first() {
            live_folders
                .iter()
                .find(|x| &x.id == f)
                .and_then(|x| x.parent.clone())
        } else {
            sel.materials.first().and_then(|m| {
                live_materials
                    .iter()
                    .find(|x| &x.id == m)
                    .and_then(|x| x.folder.clone())
            })
        };

        let move_expanded = self.move_open_for.as_deref() == Some(key);
        let toggle_entity = this.clone();
        let toggle_key = key.to_owned();
        let mut moves: Vec<AnyElement> = vec![
            div()
                .id(id("move-toggle"))
                .mx(px(m::HOVER_CARD_PAD - 8.0))
                .px(px(8.0))
                .py(px(4.0))
                .rounded(px(radius::MENU_ROW))
                .cursor_pointer()
                .role(gpui::Role::MenuItem)
                .aria_label(t(cx, keys::v5_files::MOVE_TO_FOLDER))
                .hover(move |st| st.bg(p.ink(1).alpha(0.05)))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .font_role(Role::Index)
                .type_px(s.secondary, s.line_body)
                .text_color(p.ink(2).solid())
                .child(sand::icon(Icon::Folder, 14.0, p.ink(3).solid()))
                .child(div().flex_1().child(t(cx, keys::v5_files::MOVE_TO_FOLDER)))
                .child(sand::icon(
                    if move_expanded {
                        Icon::ChevronDown
                    } else {
                        Icon::ChevronRight
                    },
                    11.0,
                    p.ink(4).solid(),
                ))
                .on_click(move |_, _, cx| {
                    let k = toggle_key.clone();
                    toggle_entity.update(cx, |p, cx| {
                        if p.move_open_for.as_deref() == Some(k.as_str()) {
                            p.move_open_for = None;
                        } else {
                            p.move_open_for = Some(k);
                        }
                        cx.notify();
                    });
                })
                .into_any_element(),
        ];
        if move_expanded {
            let root_label = t(cx, keys::v5_files::TOP_LEVEL).to_string();
            let single = sel.len() <= 1;
            for (i, choice) in tree
                .choices(&sel, current_parent.as_deref(), &root_label)
                .into_iter()
                .enumerate()
            {
                let (entity, s_move, to) = (this.clone(), sel.clone(), choice.folder.clone());
                let icon = if choice.folder.is_some() {
                    Icon::Folder
                } else {
                    Icon::FolderNone
                };
                let here = single && choice.current;
                let row = CardAction::new(id(&format!("move-{i}")), icon, choice.path.clone())
                    .current(here);
                moves.push(if here {
                    row.into_any_element()
                } else {
                    row.on_click(move |_, _, cx| {
                        entity.update(cx, |p, cx| {
                            p.card_open = None;
                            p.move_to(s_move.clone(), to.clone(), cx);
                        })
                    })
                    .into_any_element()
                });
            }
        }

        let delete = {
            let s_del = sel.clone();
            let entity = this.clone();
            CardAction::new(
                id("delete"),
                Icon::Trash,
                t(cx, keys::v5_files::MOVE_TO_TRASH),
            )
            .danger()
            .on_click(move |_, _, cx| {
                entity.update(cx, |p, cx| {
                    p.card_open = None;
                    p.delete(s_del.clone(), cx);
                })
            })
            .into_any_element()
        };

        if sel.len() > 1 {
            let n = sel.len();
            return CardBody::new(id("body"), title)
                .count(tp(
                    cx,
                    keys::v5_files::ITEM_COUNT,
                    n as u64,
                    &[("count", &n)],
                ))
                .section(moves)
                .section(vec![delete])
                .into_any_element();
        }

        let rename = {
            let k = key.to_owned();
            action(
                "rename",
                Icon::Edit,
                t(cx, keys::v5_files::RENAME),
                Rc::new(move |p, window, cx| p.start_rename(&k, window, cx)),
            )
        };

        // Live folder hover card (`v5-tracks.md` line 395).
        if let Some(folder_id) = key.strip_prefix("f:") {
            let total = tree.total(folder_id);
            let f_open = folder_id.to_owned();
            let f_sub = folder_id.to_owned();
            let open_action = action(
                "open",
                Icon::ArrowOut,
                t(cx, keys::v5_files::OPEN),
                Rc::new(move |p, _, cx| {
                    if p.view_mode == ViewMode::Masonry {
                        p.set_masonry_folder(Some(f_open.clone()), cx);
                    } else {
                        p.set_open(&f_open, true, cx);
                    }
                }),
            );
            let new_sub = action(
                "new-sub",
                Icon::FolderPlus,
                t(cx, keys::v5_files::NEW_SUBFOLDER),
                Rc::new(move |p, _, cx| p.new_folder(Some(f_sub.clone()), cx)),
            );
            return CardBody::new(id("body"), title)
                .meta(tp(
                    cx,
                    keys::v5_files::FILE_COUNT,
                    total as u64,
                    &[("count", &total)],
                ))
                .section(vec![open_action, rename, new_sub])
                .section(moves)
                .section(vec![delete])
                .into_any_element();
        }

        // Live file hover card (`v5-tracks.md` line 396).
        let material_id = key.trim_start_matches("i:").to_owned();
        let meta_line = live_materials
            .iter()
            .find(|m| m.id == material_id)
            .map(|m| self.file_meta_line(m, cx))
            .unwrap_or_default();
        let usages = self.usages_of(&material_id).to_vec();

        let mut body = CardBody::new(id("body"), title).meta(meta_line);

        if !usages.is_empty() {
            let mut usage_rows: Vec<AnyElement> = vec![
                div()
                    .px(px(m::HOVER_CARD_PAD))
                    .pb(px(2.0))
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.muted().solid())
                    .child(t(cx, keys::v5_files::USED_IN))
                    .into_any_element(),
            ];
            for (i, u) in usages.into_iter().enumerate() {
                let entity = this.clone();
                let (mark_kind, mark_color) = u
                    .entry_id
                    .parse()
                    .ok()
                    .map(|eid| {
                        self.book.mark(&NavTarget::Entry {
                            id: eid,
                            module: None,
                        })
                    })
                    .unwrap_or_else(|| {
                        let k = if u.is_chapter {
                            sand::Kind::Chapter(dr_shell::book::seal_of(&u.entry_id))
                        } else {
                            sand::Kind::Element
                        };
                        (
                            k,
                            u.entry_color.as_deref().and_then(dr_shell::book::color_of),
                        )
                    });
                let mark = match mark_color {
                    Some(c) => KindMark::new(id(&format!("use-mark-{i}")), mark_kind).color(c),
                    None => KindMark::new(id(&format!("use-mark-{i}")), mark_kind),
                };
                let entry_title = u.entry_title.clone();
                let mod_name = u.module_name.clone();
                usage_rows.push(
                    div()
                        .id(id(&format!("use-{i}")))
                        .mx(px(m::HOVER_CARD_PAD - 8.0))
                        .px(px(8.0))
                        .py(px(4.0))
                        .rounded(px(radius::MENU_ROW))
                        .cursor_pointer()
                        .role(gpui::Role::MenuItem)
                        .aria_label(format!("{entry_title} {mod_name}"))
                        .hover(move |st| st.bg(p.ink(1).alpha(0.05)))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(7.0))
                        .child(mark)
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .font_role(Role::Ui)
                                .type_px(s.secondary, s.line_body)
                                .text_color(p.ink(1).solid())
                                .child(entry_title),
                        )
                        .when(!mod_name.is_empty(), |d| {
                            d.child(
                                div()
                                    .flex_none()
                                    .font_role(Role::Index)
                                    .type_px(s.caption, s.line_caption)
                                    .text_color(p.muted().solid())
                                    .child(mod_name),
                            )
                        })
                        .on_click(move |_, _, cx| {
                            let u = u.clone();
                            entity.update(cx, |p, cx| {
                                p.card_open = None;
                                p.jump_to_usage(&u, cx);
                            });
                        })
                        .into_any_element(),
                );
            }
            body = body.section(usage_rows);
        }

        let m_open = material_id.clone();
        let m_sys = material_id;
        let actions = vec![
            action(
                "open",
                Icon::ArrowOut,
                t(cx, keys::v5_files::OPEN),
                Rc::new(move |p, _, cx| p.open(&m_open, Open::KEEP, cx)),
            ),
            action(
                "open-system",
                Icon::GateOut,
                t(cx, keys::v5_files::OPEN_IN_SYSTEM),
                Rc::new(move |p, _, cx| p.open_in_system(&m_sys, cx)),
            ),
            rename,
        ];

        body.section(actions)
            .section(moves)
            .section(vec![delete])
            .into_any_element()
    }
}

impl Render for LibraryPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(reveal_id) = self.pending_reveal.clone()
            && self.live_materials().iter().any(|m| m.id == reveal_id)
        {
            self.reveal_and_flash_asset(&reveal_id, cx);
        }
        if let Some((key, select_all)) = self.rename_when_shown.clone()
            && self.order().contains(&key)
        {
            self.rename_when_shown = None;
            self.start_rename_mode(&key, select_all, window, cx);
        }

        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let active = self.active(cx);

        let live_folders = self.live_folders().to_vec();
        let live_materials = self.live_materials().to_vec();
        let trashed_folders = self.trashed_folders().to_vec();
        let trashed_assets = self.trashed_assets().to_vec();

        let mut children: Vec<AnyElement> = Vec::new();

        if self.view_mode == ViewMode::Masonry
            && let Some(folder_id) = self.masonry_folder.clone()
        {
            let full_tree = Tree::new_ordered(&live_folders, &live_materials, None);
            let parent = live_folders
                .iter()
                .find(|f| f.id == folder_id)
                .and_then(|f| f.parent.clone())
                .filter(|pid| live_folders.iter().any(|x| &x.id == pid));
            let path = full_tree.path(&folder_id);
            children.push(
                div()
                    .id("library-masonry-back")
                    .min_h(px(30.0))
                    .px(px(8.0))
                    .py(px(4.0))
                    .mb(px(4.0))
                    .self_start()
                    .rounded(px(radius::SM))
                    .cursor_pointer()
                    .hover(move |st| st.bg(p.ink(1).alpha(0.05)))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(5.0))
                    .font_role(Role::Structure)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.ink(3).solid())
                    .child(sand::icon(Icon::ChevronLeft, 11.0, p.ink(4).solid()))
                    .child(t(cx, keys::v5_files::LIBRARY_ROOT))
                    .child(div().text_color(p.ink(4).solid()).child("/"))
                    .child(div().text_color(p.ink(1).solid()).child(path))
                    .on_click(cx.listener(move |p, _: &ClickEvent, _, cx| {
                        p.set_masonry_folder(parent.clone(), cx);
                    }))
                    .into_any_element(),
            );
            let mut items: Vec<MasonryEntry<'_>> = Vec::new();
            for sub in full_tree.children_of(Some(&folder_id)) {
                let previews_in = full_tree.preview_materials(&sub.id, 4);
                let cnt = full_tree.total(&sub.id);
                items.push(MasonryEntry::Folder(sub, previews_in, cnt));
            }
            for m in full_tree.materials_of(Some(&folder_id)) {
                items.push(MasonryEntry::File(m, None));
            }
            if items.is_empty() {
                children.push(
                    EmptyState::new("library-folder-empty", t(cx, keys::v5_files::EMPTY))
                        .icon(Icon::Folder)
                        .into_any_element(),
                );
            } else {
                children.push(self.masonry_grid(items, active.as_deref(), "dir", window, cx));
            }
        } else {
            let current = self.current_section(cx);
            if !current.is_empty() {
                children.push(Self::section_header(
                    "library-section-current",
                    t(cx, keys::v5_files::CURRENT_SECTION),
                    Some(current.len()),
                    self.current_collapsed,
                    window,
                    cx,
                    |p, cx| {
                        p.current_collapsed = !p.current_collapsed;
                        cx.notify();
                    },
                ));
                if !self.current_collapsed {
                    match self.view_mode {
                        ViewMode::List => {
                            for item in &current {
                                children.push(self.current_list_row(
                                    item,
                                    active.as_deref(),
                                    window,
                                    cx,
                                ));
                            }
                        }
                        ViewMode::Masonry => {
                            let mut cur_cards: Vec<MasonryEntry<'_>> = Vec::new();
                            for item in &current {
                                if let Some(m) =
                                    live_materials.iter().find(|m| m.id == item.asset_id)
                                {
                                    cur_cards.push(MasonryEntry::File(
                                        m,
                                        Some(item.module_name.clone().into()),
                                    ));
                                }
                            }
                            children.push(self.masonry_grid(
                                cur_cards,
                                active.as_deref(),
                                "cur",
                                window,
                                cx,
                            ));
                        }
                    }
                }

                children.push(div().h(px(8.0)).into_any_element());
                children.push(Self::section_header(
                    "library-section-other",
                    t(cx, keys::v5_files::OTHER_SECTION),
                    None,
                    self.other_collapsed,
                    window,
                    cx,
                    |p, cx| {
                        p.other_collapsed = !p.other_collapsed;
                        cx.notify();
                    },
                ));
                if !self.other_collapsed {
                    let pinned: HashSet<&str> =
                        current.iter().map(|c| c.asset_id.as_str()).collect();
                    let rest: HashSet<String> = live_materials
                        .iter()
                        .filter(|m| !pinned.contains(m.id.as_str()))
                        .map(|m| m.id.clone())
                        .collect();
                    let other_tree = Tree::new_ordered(&live_folders, &live_materials, Some(&rest));
                    match self.view_mode {
                        ViewMode::List => {
                            for entry in other_tree.entries(&self.expanded, false) {
                                children.push(self.list_row(
                                    &entry,
                                    active.as_deref(),
                                    "other",
                                    window,
                                    cx,
                                ));
                            }
                        }
                        ViewMode::Masonry => {
                            let mut items: Vec<MasonryEntry<'_>> = Vec::new();
                            for f in other_tree.children_of(None) {
                                let prev = other_tree.preview_materials(&f.id, 4);
                                let cnt = other_tree.total(&f.id);
                                items.push(MasonryEntry::Folder(f, prev, cnt));
                            }
                            for m in other_tree.materials_of(None) {
                                items.push(MasonryEntry::File(m, None));
                            }
                            children.push(self.masonry_grid(
                                items,
                                active.as_deref(),
                                "other",
                                window,
                                cx,
                            ));
                        }
                    }
                }
            } else {
                let full_tree = Tree::new_ordered(&live_folders, &live_materials, None);
                match self.view_mode {
                    ViewMode::List => {
                        let entries = full_tree.entries(&self.expanded, false);
                        if entries.is_empty()
                            && trashed_folders.is_empty()
                            && trashed_assets.is_empty()
                        {
                            children.push(
                                EmptyState::new("library-empty", t(cx, keys::v5_files::EMPTY))
                                    .icon(Icon::LibCurio)
                                    .into_any_element(),
                            );
                        } else {
                            for entry in entries {
                                children.push(self.list_row(
                                    &entry,
                                    active.as_deref(),
                                    "main",
                                    window,
                                    cx,
                                ));
                            }
                        }
                    }
                    ViewMode::Masonry => {
                        let mut items: Vec<MasonryEntry<'_>> = Vec::new();
                        for f in full_tree.children_of(None) {
                            let prev = full_tree.preview_materials(&f.id, 4);
                            let cnt = full_tree.total(&f.id);
                            items.push(MasonryEntry::Folder(f, prev, cnt));
                        }
                        for m in full_tree.materials_of(None) {
                            items.push(MasonryEntry::File(m, None));
                        }
                        if items.is_empty()
                            && trashed_folders.is_empty()
                            && trashed_assets.is_empty()
                        {
                            children.push(
                                EmptyState::new("library-empty", t(cx, keys::v5_files::EMPTY))
                                    .icon(Icon::LibCurio)
                                    .into_any_element(),
                            );
                        } else if !items.is_empty() {
                            children.push(self.masonry_grid(
                                items,
                                active.as_deref(),
                                "main",
                                window,
                                cx,
                            ));
                        }
                    }
                }
            }

            let trash_total = trashed_folders.len() + trashed_assets.len();
            if trash_total > 0 {
                children.push(div().h(px(10.0)).into_any_element());
                children.push(Self::section_header(
                    "library-section-trash",
                    t(cx, keys::v5_files::TRASH_SECTION),
                    Some(trash_total),
                    self.trash_collapsed,
                    window,
                    cx,
                    |p, cx| {
                        p.trash_collapsed = !p.trash_collapsed;
                        cx.notify();
                    },
                ));
                if !self.trash_collapsed {
                    for tf in &trashed_folders {
                        children.push(self.trashed_folder_row(tf, window, cx));
                    }
                    for ta in &trashed_assets {
                        children.push(self.trashed_asset_row(ta, window, cx));
                    }
                }
            }
        }

        let importing = (self.importing > 0).then(|| {
            div()
                .px(px(12.0))
                .py(px(4.0))
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.muted().solid())
                .child(t(cx, keys::material_editor::embed::IMPORTING))
        });

        let width_entity = cx.entity();
        let width_probe = canvas(
            move |bounds, _, cx| {
                let w = f32::from(bounds.size.width);
                if w > 40.0 {
                    width_entity.update(cx, |p, cx| {
                        if (p.list_width - w).abs() > 1.0 {
                            p.list_width = w;
                            cx.notify();
                        }
                    });
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();

        let wash = p.accent.alpha(0.06);
        let ring = p.accent.alpha(0.55);

        div()
            .id("material-library")
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(|p, _: &SelectAll, _, cx| p.select_all(cx)))
            .on_action(cx.listener(|p, _: &ClearSelection, _, cx| p.clear_selection(cx)))
            .on_action(cx.listener(|p, _: &PasteFiles, _, cx| p.paste(cx)))
            .size_full()
            .flex()
            .flex_col()
            .children(importing)
            .child(
                div()
                    .id("material-library-rows")
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .px(px(12.0))
                    .pt(px(6.0))
                    .pb(px(12.0))
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .rounded(px(radius::SM))
                    .border_1()
                    .border_color(gpui::transparent_black())
                    .drag_over::<MaterialDrag>(move |st, _, _, _| st.bg(wash))
                    .on_drop(cx.listener(|p, drag: &MaterialDrag, _, cx| {
                        let dest = p.masonry_folder.clone();
                        p.move_to(drag.selection.clone(), dest, cx)
                    }))
                    .drag_over::<ExternalPaths>(move |st, _, _, _| st.bg(wash).border_color(ring))
                    .on_drop(cx.listener(|p, paths: &ExternalPaths, _, cx| {
                        let folder = p.target_folder();
                        p.import_paths(paths.paths().to_vec(), folder, cx)
                    }))
                    .child(width_probe)
                    .children(children)
                    .child(
                        div()
                            .id("material-library-rest")
                            .flex_1()
                            .min_h(px(40.0))
                            .on_click(cx.listener(|p, _: &ClickEvent, window, cx| {
                                window.focus(&p.focus, cx);
                                if p.masonry_folder.is_none() {
                                    p.current_folder = None;
                                }
                                p.clear_selection(cx);
                            })),
                    ),
            )
    }
}

/// The 素材库 tab's head row: `[列表 | 瀑布流]`, count, 审阅与素材, 新建素材夹, `+`.
pub struct LibraryHead {
    panel: Entity<LibraryPanel>,
    _sub: Subscription,
}

impl LibraryHead {
    pub fn new(panel: Entity<LibraryPanel>, cx: &mut Context<Self>) -> LibraryHead {
        let sub = cx.observe(&panel, |_, _, cx| cx.notify());
        LibraryHead { panel, _sub: sub }
    }
}

impl Render for LibraryHead {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let panel = self.panel.read(cx);
        let count = panel.live_count();
        let mode = panel.view_mode();
        let (to_list, to_masonry, folder, plus, sv) = (
            self.panel.clone(),
            self.panel.clone(),
            self.panel.clone(),
            self.panel.clone(),
            panel.shell.clone(),
        );

        let view_btn = |id: &'static str,
                        icon: Icon,
                        label: SharedString,
                        active: bool,
                        target: ViewMode,
                        entity: Entity<LibraryPanel>| {
            div()
                .id(id)
                .w(px(28.0))
                .h(px(24.0))
                .rounded(px(radius::SM))
                .cursor_pointer()
                .role(gpui::Role::Button)
                .aria_label(label)
                .when(active, |d| d.bg(p.page.solid()))
                .when(!active, |d| d.hover(move |st| st.bg(p.page.alpha(0.45))))
                .flex()
                .items_center()
                .justify_center()
                .child(sand::icon(
                    icon,
                    14.0,
                    if active {
                        p.ink(1).solid()
                    } else {
                        p.ink(3).solid()
                    },
                ))
                .on_click(move |_, _, cx| {
                    entity.update(cx, |p, cx| p.set_view_mode(target, cx));
                })
        };

        div()
            .size_full()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .child(
                div()
                    .p(px(2.0))
                    .rounded(px(radius::SM + 2.0))
                    .bg(p.desk.alpha(0.65))
                    .border_1()
                    .border_color(p.hairline())
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(2.0))
                    .child(view_btn(
                        "library-view-list",
                        Icon::ViewList,
                        t(cx, keys::v5_files::VIEW_LIST),
                        mode == ViewMode::List,
                        ViewMode::List,
                        to_list,
                    ))
                    .child(view_btn(
                        "library-view-masonry",
                        Icon::ViewGrid,
                        t(cx, keys::v5_files::VIEW_MASONRY),
                        mode == ViewMode::Masonry,
                        ViewMode::Masonry,
                        to_masonry,
                    )),
            )
            .child(div().flex_1())
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.ink(4).solid())
                    .child(tp(
                        cx,
                        keys::v5_files::ITEM_COUNT,
                        count as u64,
                        &[("count", &count)],
                    )),
            )
            .child(
                IconButton::new("library-super-view", Icon::LibCurio)
                    .label(t(cx, keys::bottom_status_bar::TODO_LIBRARY))
                    .on_click(move |_, _, cx| {
                        if let Some(ws) = sv.upgrade() {
                            ws.update(cx, |ws, cx| {
                                ws.toggle_super_view(SuperView::ReviewMaterials, cx)
                            });
                        }
                    }),
            )
            .child(
                IconButton::new("library-new-folder", Icon::FolderPlus)
                    .label(t(cx, keys::v5_files::NEW_FOLDER))
                    .on_click(move |_, _, cx| {
                        folder.update(cx, |p, cx| {
                            let parent = p.target_folder();
                            p.new_folder(parent, cx)
                        })
                    }),
            )
            .child(
                IconButton::new("library-new", Icon::Plus)
                    .label(t(cx, keys::v5_files::ADD_FILES))
                    .on_click(move |_, _, cx| plus.update(cx, |p, cx| p.pick_files(cx))),
            )
    }
}
