//! Canonical v3 element islands extraction and skyline layout solver (`群岛`).
//!
//! Discovers island levels on `BookV3` (the organising levels under a
//! `display == "island"` level as well as standalone organising
//! `auto_link && !is_manuscript` non-lane levels), shows every content entry
//! as a card whatever its switch, keeps resident entries and accepted
//! memberships distinct per G2, and solves balanced top/bottom skyline
//! placements without any book-order or chapter appearance band.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use dr_shell::book::v3::BookV3;
use dr_ui::sand;
use dr_workspace::commands::v3::types::FieldValue;

use crate::relate::RelatePoint;

pub const CELL_W: f32 = 96.0;
pub const CELL_H: f32 = 56.0;
pub const GROUP_HEADER_PX: f32 = 16.0;
pub const DESKTOP_ISLAND_INNER_PAD_Y_TOP: f32 = 30.0;
pub const ISLAND_INNER_PAD_Y_BOTTOM: f32 = 4.0;
pub const ISLAND_GAP_X: f32 = CELL_W / 8.0;
pub const ZOOM_MIN: f32 = 0.4;
pub const ZOOM_MAX: f32 = 2.0;
pub const UNCATEGORIZED_KEY: &str = "__uncategorized__";

pub fn card_col_step(width_cells: usize) -> f32 {
    let w = width_cells.max(1) as f32;
    (w * CELL_W - ISLAND_GAP_X) / w
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IslesLod {
    Far,
    Mid,
    Near,
}

impl IslesLod {
    pub fn zoom(self) -> f32 {
        match self {
            Self::Far => 0.5,
            Self::Mid => 0.9,
            Self::Near => 1.5,
        }
    }
}

pub fn isles_lod(zoom: f32) -> IslesLod {
    if zoom < 0.65 {
        IslesLod::Far
    } else if zoom < 1.25 {
        IslesLod::Mid
    } else {
        IslesLod::Near
    }
}

/// A content entry displayed on the Element Overview canvas.
#[derive(Clone, Debug, PartialEq)]
pub struct IslandItem {
    pub id: String,
    pub name: String,
    pub aliases: Vec<String>,
    pub summary: String,
    pub home_island_id: String,
    pub color: Option<String>,
    pub sand_kind: sand::Kind,
    pub relation_pin: Option<RelatePoint>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IslandGroupLayout {
    pub group_name: Option<String>,
    pub is_members: bool,
    pub items: Vec<IslandItem>,
    pub card_rows_top_px: f32,
    pub card_rows: usize,
    pub header_top_px: Option<f32>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IslandModel {
    pub island_id: String,
    /// Canonical v3 level ID accepting drops and new-entry creation for this island.
    pub creation_level_id: Option<String>,
    pub is_uncategorized: bool,
    pub title: String,
    pub color: Option<String>,
    pub sand_kind: sand::Kind,
    pub groups: Vec<IslandGroupLayout>,
    pub width_cells: usize,
    pub height_cells: usize,
    pub content_height_px: f32,
    pub total_elements: usize,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExtractedIslands {
    pub islands: Vec<IslandModel>,
    /// Deduplicated content entries across all discovered islands, in `BookV3.entries` order.
    pub elements: Vec<IslandItem>,
}

fn extract_fields(v3: &BookV3, entry_id: &str) -> (String, Vec<String>) {
    let Some(entry) = v3.entry(entry_id) else {
        return (String::new(), Vec::new());
    };
    let Some(tpl) = v3.template_of(entry_id) else {
        return (String::new(), Vec::new());
    };
    let mut summary = String::new();
    let mut aliases: Vec<String> = Vec::new();
    for m in &tpl.modules {
        if m.kind != "fields" {
            continue;
        }
        let Some(fmap) = entry.fields.get(&m.id) else {
            continue;
        };
        if summary.is_empty()
            && let Some(sf) = m.config.summary_field.as_ref()
            && let Some(FieldValue::Text(s)) = fmap.get(sf)
            && !s.trim().is_empty()
        {
            summary = s.trim().to_owned();
        }
        if let Some(af) = m.config.aliases_field.as_ref()
            && let Some(val) = fmap.get(af)
        {
            match val {
                FieldValue::List(xs) => {
                    for x in xs {
                        let trimmed = x.trim();
                        if !trimmed.is_empty() && !aliases.iter().any(|a| a == trimmed) {
                            aliases.push(trimmed.to_owned());
                        }
                    }
                }
                FieldValue::Text(s) => {
                    for part in s.split([',', '，', '、', ';', '；']) {
                        let trimmed = part.trim();
                        if !trimmed.is_empty() && !aliases.iter().any(|a| a == trimmed) {
                            aliases.push(trimmed.to_owned());
                        }
                    }
                }
                _ => {}
            }
        }
    }
    (summary, aliases)
}

fn title_of(v3: &BookV3, id: &str) -> String {
    v3.entry(id).map(|e| e.title.clone()).unwrap_or_default()
}

/// Collects the content entries living in `container` into `items`, those
/// of the organising levels below it as well. A content entry whose switch
/// is on is a card too; it is queued in `named` so that what lives under it
/// becomes a group under its name.
fn collect_content(
    v3: &BookV3,
    container: &str,
    items: &mut Vec<String>,
    named: &mut Vec<String>,
    seen: &mut HashSet<String>,
) {
    let Some(level) = v3.levels.get(container) else {
        return;
    };
    for cid in &level.children {
        if !seen.insert(cid.clone()) {
            continue;
        }
        if v3.is_content(cid) {
            items.push(cid.clone());
            if v3.levels.contains_key(cid) {
                named.push(cid.clone());
            }
        } else {
            collect_content(v3, cid, items, named, seen);
        }
    }
}

/// One group per content entry in `named`, titled with its name and holding
/// what lives under it; nested ones follow their parent's group.
fn named_groups(
    v3: &BookV3,
    mut named: Vec<String>,
    seen: &mut HashSet<String>,
) -> Vec<(Option<String>, bool, Vec<String>)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < named.len() {
        let id = named[i].clone();
        let mut items = Vec::new();
        let mut below = Vec::new();
        collect_content(v3, &id, &mut items, &mut below, seen);
        out.push((Some(title_of(v3, &id)), false, items));
        named.splice(i + 1..i + 1, below);
        i += 1;
    }
    out
}

fn subtree_level_ids(v3: &BookV3, root_id: &str, seen: &mut HashSet<String>) {
    if !seen.insert(root_id.to_owned()) {
        return;
    }
    if let Some(level) = v3.levels.get(root_id) {
        for cid in &level.children {
            if v3.levels.contains_key(cid) {
                subtree_level_ids(v3, cid, seen);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn build_island_model(
    island_id: String,
    creation_level_id: Option<String>,
    is_uncategorized: bool,
    title: String,
    color: Option<String>,
    sand_kind: sand::Kind,
    ordered_groups: Vec<(Option<String>, bool, Vec<IslandItem>)>,
    padding_top: f32,
) -> IslandModel {
    let total_elements: usize = ordered_groups.iter().map(|(_, _, items)| items.len()).sum();
    let non_empty_groups: Vec<(Option<String>, bool, Vec<IslandItem>)> = ordered_groups
        .into_iter()
        .filter(|(_, _, items)| !items.is_empty())
        .collect();

    if total_elements == 0 {
        return IslandModel {
            island_id,
            creation_level_id,
            is_uncategorized,
            title,
            color,
            sand_kind,
            groups: Vec::new(),
            width_cells: 2,
            height_cells: 1,
            content_height_px: CELL_H,
            total_elements: 0,
        };
    }

    let minimum_width = if non_empty_groups.len() > 1 { 2 } else { 1 };
    let sqrt_n = (total_elements as f32).sqrt().ceil() as usize;
    let width_cells = sqrt_n.clamp(minimum_width, 6);
    let show_group_headers =
        non_empty_groups.len() > 1 || non_empty_groups.iter().any(|(_, is_m, _)| *is_m);
    let mut cursor = padding_top;
    let mut groups = Vec::with_capacity(non_empty_groups.len());

    for (index, (group_name, is_members, items)) in non_empty_groups.into_iter().enumerate() {
        let mut header_top_px = None;
        if show_group_headers && group_name.is_some() {
            header_top_px = Some(cursor);
            cursor += GROUP_HEADER_PX;
        } else if show_group_headers && index > 0 {
            cursor += 6.0;
        }
        let card_rows = items.len().div_ceil(width_cells).max(1);
        let card_rows_top_px = cursor;
        cursor += card_rows as f32 * CELL_H;
        groups.push(IslandGroupLayout {
            group_name,
            is_members,
            items,
            card_rows_top_px,
            card_rows,
            header_top_px,
        });
    }

    let content_height_px = cursor + ISLAND_INNER_PAD_Y_BOTTOM;
    let height_cells = ((content_height_px / CELL_H).ceil() as usize).max(1);

    IslandModel {
        island_id,
        creation_level_id,
        is_uncategorized,
        title,
        color,
        sand_kind,
        groups,
        width_cells,
        height_cells,
        content_height_px,
        total_elements,
    }
}

struct RawIsland {
    island_id: String,
    creation_level_id: Option<String>,
    is_uncategorized: bool,
    title: String,
    color: Option<String>,
    sand_kind: sand::Kind,
    groups: Vec<(Option<String>, bool, Vec<String>)>,
}

/// Extract canonical v3 islands and the unique content entries on them from
/// `BookV3`. Whether an entry is a card or a group follows its template
/// ([`BookV3::is_content`]), never its switch.
pub fn extract_v3_islands(
    v3: &BookV3,
    residents_label: &str,
    members_label: &str,
    uncategorized_label: &str,
) -> ExtractedIslands {
    let mut claimed_levels: HashSet<String> = HashSet::new();
    let mut raw_islands: Vec<RawIsland> = Vec::new();

    // 1. Levels configured with `display == "island"` (e.g. novel `要素` root):
    //    the organising levels under them are the islands, and the content
    //    entries living or belonging directly on the wrapper form an
    //    uncategorized island.
    let mut uncat_counter = 0usize;
    for entry in &v3.entries {
        let Some(root_level) = v3.levels.get(&entry.id) else {
            continue;
        };
        if root_level.settings.display != "island" || claimed_levels.contains(&entry.id) {
            continue;
        }
        subtree_level_ids(v3, &entry.id, &mut claimed_levels);

        let mut seen = HashSet::from([entry.id.clone()]);
        let mut wrapper_direct = Vec::new();
        let mut named = Vec::new();
        for cid in &root_level.children {
            if !seen.insert(cid.clone()) {
                continue;
            }
            if v3.is_content(cid) {
                wrapper_direct.push(cid.clone());
                if v3.levels.contains_key(cid) {
                    named.push(cid.clone());
                }
            } else if v3.levels.contains_key(cid) {
                raw_islands.push(extract_one_level_island(
                    v3,
                    cid,
                    residents_label,
                    members_label,
                ));
            }
        }
        let named = named_groups(v3, named, &mut seen);
        let resident_set: HashSet<&str> = wrapper_direct
            .iter()
            .chain(named.iter().flat_map(|(_, _, ids)| ids))
            .map(String::as_str)
            .collect();
        let wrapper_members: Vec<String> = root_level
            .members
            .iter()
            .filter(|mid| v3.is_content(mid) && !resident_set.contains(mid.as_str()))
            .cloned()
            .collect();

        if !wrapper_direct.is_empty() || !wrapper_members.is_empty() {
            uncat_counter += 1;
            let island_id = if uncat_counter == 1 {
                UNCATEGORIZED_KEY.to_owned()
            } else {
                format!("{UNCATEGORIZED_KEY}:{uncat_counter}")
            };
            let mut groups = Vec::new();
            let res_label = (!wrapper_direct.is_empty() && !wrapper_members.is_empty())
                .then(|| residents_label.to_owned());
            if !wrapper_direct.is_empty() {
                groups.push((res_label, false, wrapper_direct));
            }
            groups.extend(named);
            if !wrapper_members.is_empty() {
                groups.push((Some(members_label.to_owned()), true, wrapper_members));
            }
            raw_islands.push(RawIsland {
                island_id,
                creation_level_id: Some(entry.id.clone()),
                is_uncategorized: true,
                title: uncategorized_label.to_owned(),
                color: v3.appearance(&entry.id).and_then(|a| a.color),
                sand_kind: sand::Kind::Category,
                groups,
            });
        }
    }

    // 2. Any standalone organising `auto_link && !is_manuscript` non-lane
    //    level not already inside an `"island"` tree.
    for entry in &v3.entries {
        if claimed_levels.contains(&entry.id) || v3.is_content(&entry.id) {
            continue;
        }
        let Some(level) = v3.levels.get(&entry.id) else {
            continue;
        };
        let is_lane = v3.is_lane(&entry.id);
        if !level.settings.auto_link || level.settings.is_manuscript || is_lane {
            continue;
        }
        subtree_level_ids(v3, &entry.id, &mut claimed_levels);
        raw_islands.push(extract_one_level_island(
            v3,
            &entry.id,
            residents_label,
            members_label,
        ));
    }

    // Track each entry's resident island and membership islands so we can resolve its home island & color.
    let mut island_colors: HashMap<String, Option<String>> = HashMap::new();
    let mut resident_island_of: HashMap<String, String> = HashMap::new();
    let mut member_islands_of: HashMap<String, Vec<String>> = HashMap::new();

    for raw in &raw_islands {
        island_colors.insert(raw.island_id.clone(), raw.color.clone());
        for (_, is_members, ids) in &raw.groups {
            for id in ids {
                if *is_members {
                    member_islands_of
                        .entry(id.clone())
                        .or_default()
                        .push(raw.island_id.clone());
                } else {
                    resident_island_of
                        .entry(id.clone())
                        .or_insert_with(|| raw.island_id.clone());
                }
            }
        }
    }

    let mut items_by_id: HashMap<String, IslandItem> = HashMap::new();
    for raw in &raw_islands {
        for (_, _, ids) in &raw.groups {
            for id in ids {
                if items_by_id.contains_key(id) {
                    continue;
                }
                let Some(entry) = v3.entry(id) else {
                    continue;
                };
                let primary_match = entry.primary.as_deref().filter(|p| {
                    resident_island_of.get(id).map(String::as_str) == Some(*p)
                        || member_islands_of
                            .get(id)
                            .is_some_and(|ms| ms.iter().any(|m| m == *p))
                });
                let home_island_id = primary_match
                    .map(str::to_owned)
                    .or_else(|| resident_island_of.get(id).cloned())
                    .or_else(|| member_islands_of.get(id).and_then(|ms| ms.first().cloned()))
                    .unwrap_or_else(|| UNCATEGORIZED_KEY.to_owned());

                let app = v3.appearance(id);
                let color = app
                    .as_ref()
                    .and_then(|a| a.color.clone())
                    .or_else(|| island_colors.get(&home_island_id).cloned().flatten());
                let sand_kind = app.map_or(sand::Kind::Element, |a| a.sand);
                let (summary, aliases) = extract_fields(v3, id);
                let relation_pin = entry
                    .layout
                    .relation_graph
                    .filter(|(x, y)| x.is_finite() && y.is_finite())
                    .map(|(x, y)| RelatePoint::new(x, y));

                items_by_id.insert(
                    id.clone(),
                    IslandItem {
                        id: id.clone(),
                        name: entry.title.clone(),
                        aliases,
                        summary,
                        home_island_id,
                        color,
                        sand_kind,
                        relation_pin,
                    },
                );
            }
        }
    }

    let mut islands = Vec::with_capacity(raw_islands.len());
    for raw in raw_islands {
        let hydrated_groups: Vec<(Option<String>, bool, Vec<IslandItem>)> = raw
            .groups
            .into_iter()
            .map(|(gname, is_m, ids)| {
                let items = ids
                    .into_iter()
                    .filter_map(|id| items_by_id.get(&id).cloned())
                    .collect();
                (gname, is_m, items)
            })
            .collect();
        islands.push(build_island_model(
            raw.island_id,
            raw.creation_level_id,
            raw.is_uncategorized,
            raw.title,
            raw.color,
            raw.sand_kind,
            hydrated_groups,
            DESKTOP_ISLAND_INNER_PAD_Y_TOP,
        ));
    }

    // Preserve canonical `BookV3.entries` traversal order for deduplicated canvas elements.
    let mut elements = Vec::with_capacity(items_by_id.len());
    for entry in &v3.entries {
        if let Some(item) = items_by_id.remove(&entry.id) {
            elements.push(item);
        }
    }

    ExtractedIslands { islands, elements }
}

/// The island of the organising level `island_id`: one group per organising
/// level directly under it, then the content entries living in it, then
/// one group per content entry with entries under it, then the entries
/// that belong to it.
fn extract_one_level_island(
    v3: &BookV3,
    island_id: &str,
    residents_label: &str,
    members_label: &str,
) -> RawIsland {
    let title = title_of(v3, island_id);
    let app = v3.appearance(island_id);
    let color = app.as_ref().and_then(|a| a.color.clone());
    let sand_kind = app.map_or(sand::Kind::Category, |a| a.sand);

    let mut sub_groups: Vec<(Option<String>, bool, Vec<String>)> = Vec::new();

    if let Some(level) = v3.levels.get(island_id) {
        let mut seen = HashSet::from([island_id.to_owned()]);
        let mut direct: Vec<String> = Vec::new();
        let mut named: Vec<String> = Vec::new();
        for cid in &level.children {
            if !seen.insert(cid.clone()) {
                continue;
            }
            if v3.is_content(cid) {
                direct.push(cid.clone());
                if v3.levels.contains_key(cid) {
                    named.push(cid.clone());
                }
            } else if v3.levels.contains_key(cid) {
                let mut items = Vec::new();
                collect_content(v3, cid, &mut items, &mut named, &mut seen);
                if !items.is_empty() {
                    sub_groups.push((Some(title_of(v3, cid)), false, items));
                }
            }
        }
        let named = named_groups(v3, named, &mut seen);
        let resident_ids: HashSet<&str> = sub_groups
            .iter()
            .chain(&named)
            .flat_map(|(_, _, ids)| ids)
            .chain(&direct)
            .map(String::as_str)
            .collect();
        let members: Vec<String> = level
            .members
            .iter()
            .filter(|mid| v3.is_content(mid) && !resident_ids.contains(mid.as_str()))
            .cloned()
            .collect();

        if !direct.is_empty() {
            let direct_header = (!members.is_empty() && sub_groups.is_empty() && named.is_empty())
                .then(|| residents_label.to_owned());
            sub_groups.push((direct_header, false, direct));
        }
        sub_groups.extend(named);
        if !members.is_empty() {
            sub_groups.push((Some(members_label.to_owned()), true, members));
        }
    }

    RawIsland {
        island_id: island_id.to_owned(),
        creation_level_id: Some(island_id.to_owned()),
        is_uncategorized: false,
        title,
        color,
        sand_kind,
        groups: sub_groups,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LayoutSide {
    Top,
    Bottom,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PinnedGrid {
    pub grid_x: i32,
    pub grid_y: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LayoutInput {
    pub id: String,
    pub width_cells: usize,
    pub height_cells: usize,
    pub pinned: Option<PinnedGrid>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LayoutPlacement {
    pub id: String,
    pub grid_x: i32,
    pub grid_y: i32,
    pub side: LayoutSide,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LayoutBounds {
    pub min_x: i32,
    pub max_x: i32,
    pub min_y: i32,
    pub max_y: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LayoutResult {
    pub placements: Vec<LayoutPlacement>,
    pub bounds: LayoutBounds,
}

#[derive(Default)]
struct Skyline {
    heights: HashMap<i32, i32>,
}

impl Skyline {
    fn peak(&self, x: i32, w: i32) -> i32 {
        let mut p = 0;
        for dx in 0..w {
            let h = self.heights.get(&(x + dx)).copied().unwrap_or(0);
            if h > p {
                p = h;
            }
        }
        p
    }

    fn occupy(&mut self, x: i32, w: i32, new_height: i32) {
        for dx in 0..w {
            let entry = self.heights.entry(x + dx).or_insert(0);
            if new_height > *entry {
                *entry = new_height;
            }
        }
    }
}

struct BestSlot {
    grid_x: i32,
    lift_cells: i32,
    distance: i32,
}

fn find_best_slot(skyline: &Skyline, width: i32, anchor_x: i32, search_extent: i32) -> BestSlot {
    let center_bias = anchor_x - width / 2;
    let mut best = BestSlot {
        grid_x: center_bias,
        lift_cells: i32::MAX,
        distance: i32::MAX,
    };
    for x in (center_bias - search_extent)..=(center_bias + search_extent) {
        let lift = skyline.peak(x, width);
        let distance = (x - center_bias).abs();
        if lift < best.lift_cells || (lift == best.lift_cells && distance < best.distance) {
            best = BestSlot {
                grid_x: x,
                lift_cells: lift,
                distance,
            };
        }
    }
    best
}

/// Solves island placements around a reserved horizontal gap (`gap_cells = 1` on desktop).
pub fn solve_super_element_layout(inputs: &[LayoutInput], gap_cells: i32) -> LayoutResult {
    let anchor_x = 0i32;
    let search_extent = 96i32;
    let balance_alpha = 1.0f64;

    let mut top_sky = Skyline::default();
    let mut bottom_sky = Skyline::default();

    let mut pinned = Vec::new();
    let mut auto = Vec::new();
    for cat in inputs {
        if cat.pinned.is_some() {
            pinned.push(cat.clone());
        } else {
            auto.push(cat.clone());
        }
    }

    let mut by_id: HashMap<String, LayoutPlacement> = HashMap::with_capacity(inputs.len());
    let mut top_area = 0i64;
    let mut bottom_area = 0i64;

    for cat in pinned {
        let p = cat.pinned.unwrap();
        let px = p.grid_x;
        let mut py = p.grid_y;
        let w = cat.width_cells.max(1) as i32;
        let h = cat.height_cells.max(1) as i32;
        let side = if py + h > 0 && py < gap_cells {
            if py * 2 < gap_cells {
                py = -h;
                LayoutSide::Top
            } else {
                py = gap_cells;
                LayoutSide::Bottom
            }
        } else if py < 0 {
            LayoutSide::Top
        } else {
            LayoutSide::Bottom
        };

        by_id.insert(
            cat.id.clone(),
            LayoutPlacement {
                id: cat.id,
                grid_x: px,
                grid_y: py,
                side,
            },
        );
        let area = i64::from(w) * i64::from(h);
        match side {
            LayoutSide::Top => {
                top_sky.occupy(px, w, py.abs());
                top_area += area;
            }
            LayoutSide::Bottom => {
                bottom_sky.occupy(px, w, py + h - gap_cells);
                bottom_area += area;
            }
        }
    }

    auto.sort_by(|a, b| {
        let area_a = a.width_cells * a.height_cells;
        let area_b = b.width_cells * b.height_cells;
        area_b.cmp(&area_a).then_with(|| a.id.cmp(&b.id))
    });

    for cat in auto {
        let w = cat.width_cells.max(1) as i32;
        let h = cat.height_cells.max(1) as i32;
        let area = i64::from(w) * i64::from(h);

        let top_slot = find_best_slot(&top_sky, w, anchor_x, search_extent);
        let bot_slot = find_best_slot(&bottom_sky, w, anchor_x, search_extent);

        let top_extent_after = f64::from(top_slot.lift_cells + h);
        let bot_extent_after = f64::from(bot_slot.lift_cells + h);
        let top_imbalance = ((top_area + area - bottom_area).max(0)) as f64;
        let bot_imbalance = ((bottom_area + area - top_area).max(0)) as f64;
        let top_score = top_extent_after + balance_alpha * top_imbalance.sqrt();
        let bot_score = bot_extent_after + balance_alpha * bot_imbalance.sqrt();

        let use_top = top_score < bot_score
            || ((top_score - bot_score).abs() < 1e-9 && top_area <= bottom_area);

        if use_top {
            let top_row = -(top_slot.lift_cells + h);
            by_id.insert(
                cat.id.clone(),
                LayoutPlacement {
                    id: cat.id,
                    grid_x: top_slot.grid_x,
                    grid_y: top_row,
                    side: LayoutSide::Top,
                },
            );
            top_sky.occupy(top_slot.grid_x, w, top_slot.lift_cells + h);
            top_area += area;
        } else {
            let top_row = gap_cells + bot_slot.lift_cells;
            by_id.insert(
                cat.id.clone(),
                LayoutPlacement {
                    id: cat.id,
                    grid_x: bot_slot.grid_x,
                    grid_y: top_row,
                    side: LayoutSide::Bottom,
                },
            );
            bottom_sky.occupy(bot_slot.grid_x, w, bot_slot.lift_cells + h);
            bottom_area += area;
        }
    }

    let mut ordered_placements = Vec::with_capacity(inputs.len());
    let mut min_x = i32::MAX;
    let mut max_x = i32::MIN;
    let mut min_y = 0i32;
    let mut max_y = gap_cells;

    for cat in inputs {
        if let Some(p) = by_id.remove(&cat.id) {
            min_x = min_x.min(p.grid_x);
            max_x = max_x.max(p.grid_x + cat.width_cells.max(1) as i32);
            min_y = min_y.min(p.grid_y);
            max_y = max_y.max(p.grid_y + cat.height_cells.max(1) as i32);
            ordered_placements.push(p);
        }
    }

    if min_x == i32::MAX {
        min_x = 0;
        max_x = 0;
    }

    LayoutResult {
        placements: ordered_placements,
        bounds: LayoutBounds {
            min_x,
            max_x,
            min_y,
            max_y,
        },
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ElementCenter {
    pub x: f32,
    pub y: f32,
    pub island_id: String,
}

/// Computes world-space card centers per element, preferring each element's `home_island_id`.
pub fn compute_element_centers(
    models: &[IslandModel],
    placements: &[LayoutPlacement],
) -> HashMap<String, ElementCenter> {
    let by_id: HashMap<&str, &LayoutPlacement> =
        placements.iter().map(|p| (p.id.as_str(), p)).collect();
    let mut out: HashMap<String, ElementCenter> = HashMap::new();
    for model in models {
        let Some(placement) = by_id.get(model.island_id.as_str()) else {
            continue;
        };
        let box_x = placement.grid_x as f32 * CELL_W + ISLAND_GAP_X / 2.0;
        let box_y = placement.grid_y as f32 * CELL_H;
        let col_step = card_col_step(model.width_cells);
        for g in &model.groups {
            for (idx, el) in g.items.iter().enumerate() {
                let col = idx % model.width_cells;
                let row_offset = idx / model.width_cells;
                let x = box_x + col as f32 * col_step + col_step / 2.0;
                let y = box_y + g.card_rows_top_px + row_offset as f32 * CELL_H + CELL_H / 2.0;
                let is_home = el.home_island_id == model.island_id;
                if is_home || !out.contains_key(&el.id) {
                    out.insert(
                        el.id.clone(),
                        ElementCenter {
                            x,
                            y,
                            island_id: model.island_id.clone(),
                        },
                    );
                }
            }
        }
    }
    out
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IslePair {
    pub a: String,
    pub b: String,
    pub count: u32,
}

pub fn isle_pairs(
    pairs: &BTreeMap<(String, String), u32>,
    threshold: u32,
    present: &HashSet<String>,
) -> Vec<IslePair> {
    let mut out = Vec::new();
    for ((a, b), &count) in pairs {
        if count < threshold || a == b || !present.contains(a) || !present.contains(b) {
            continue;
        }
        out.push(IslePair {
            a: a.clone(),
            b: b.clone(),
            count,
        });
    }
    out
}

pub fn isle_neighbours(
    id: &str,
    pairs: &[IslePair],
    relations: &[(String, String)],
) -> HashSet<String> {
    let mut set = HashSet::new();
    set.insert(id.to_owned());
    for pair in pairs {
        if pair.a == id {
            set.insert(pair.b.clone());
        } else if pair.b == id {
            set.insert(pair.a.clone());
        }
    }
    for (a, b) in relations {
        if a == id {
            set.insert(b.clone());
        } else if b == id {
            set.insert(a.clone());
        }
    }
    set
}

pub fn isle_companions(
    id: &str,
    pairs: &BTreeMap<(String, String), u32>,
    present: &HashSet<String>,
    limit: usize,
) -> Vec<(String, u32)> {
    let mut out = Vec::new();
    for ((a, b), &count) in pairs {
        if a == id && present.contains(b) {
            out.push((b.clone(), count));
        } else if b == id && present.contains(a) {
            out.push((a.clone(), count));
        }
    }
    out.sort_by(|x, y| y.1.cmp(&x.1).then_with(|| x.0.cmp(&y.0)));
    out.truncate(limit);
    out
}

pub fn isle_mark_weight(mentions: u32, most: u32) -> f32 {
    if mentions == 0 || most == 0 {
        return 0.0;
    }
    ((mentions as f32) / (most as f32)).sqrt().min(1.0)
}

/// Top `limit` most-mentioned live elements for far-zoom label retention.
pub fn major_element_ids(
    mentions: &BTreeMap<String, u32>,
    present: &HashSet<String>,
    limit: usize,
) -> BTreeSet<String> {
    let mut entries: Vec<(&str, u32)> = mentions
        .iter()
        .filter(|(id, count)| **count > 0 && present.contains(*id))
        .map(|(id, count)| (id.as_str(), *count))
        .collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    entries
        .into_iter()
        .take(limit)
        .map(|(id, _)| id.to_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solver_balances_top_and_bottom_and_respects_pins() {
        let inputs = vec![
            LayoutInput {
                id: "isl-a".into(),
                width_cells: 4,
                height_cells: 3,
                pinned: None,
            },
            LayoutInput {
                id: "isl-b".into(),
                width_cells: 3,
                height_cells: 3,
                pinned: None,
            },
            LayoutInput {
                id: "isl-pinned".into(),
                width_cells: 2,
                height_cells: 2,
                pinned: Some(PinnedGrid {
                    grid_x: 5,
                    grid_y: -3,
                }),
            },
        ];
        let r1 = solve_super_element_layout(&inputs, 1);
        let r2 = solve_super_element_layout(&inputs, 1);
        assert_eq!(r1, r2);
        assert_eq!(r1.placements.len(), 3);
        let p_pin = r1
            .placements
            .iter()
            .find(|p| p.id == "isl-pinned")
            .expect("pinned island placed");
        assert_eq!(p_pin.grid_x, 5);
        assert_eq!(p_pin.grid_y, -3);
        assert_eq!(p_pin.side, LayoutSide::Top);
        let sides: HashSet<_> = r1.placements.iter().map(|p| p.side).collect();
        assert!(sides.contains(&LayoutSide::Top));
        assert!(sides.contains(&LayoutSide::Bottom));
    }

    #[test]
    fn lod_mark_weights_and_companions_follow_spec() {
        assert_eq!(isles_lod(0.5), IslesLod::Far);
        assert_eq!(isles_lod(0.9), IslesLod::Mid);
        assert_eq!(isles_lod(1.4), IslesLod::Near);

        assert!((isle_mark_weight(0, 10) - 0.0).abs() < 1e-6);
        assert!((isle_mark_weight(25, 100) - 0.5).abs() < 1e-6);
        assert!((isle_mark_weight(100, 100) - 1.0).abs() < 1e-6);

        let mut pairs = BTreeMap::new();
        pairs.insert(("a".to_owned(), "b".to_owned()), 4);
        pairs.insert(("a".to_owned(), "c".to_owned()), 2);
        let present: HashSet<String> = ["a", "b", "c"].into_iter().map(str::to_owned).collect();
        assert_eq!(isle_pairs(&pairs, 3, &present).len(), 1);
        assert_eq!(
            isle_companions("a", &pairs, &present, 5),
            vec![("b".to_owned(), 4), ("c".to_owned(), 2)]
        );
    }
}
