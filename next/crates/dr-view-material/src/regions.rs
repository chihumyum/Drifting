//! Region comments (the 0.1 client's `MaterialRegionLayer`): a rectangle
//! dragged out on an image or one PDF page, kept as fractions (0–1) of the
//! picture or the page, so it stays on the same spot at any size and zoom.
//!
//! - A drag smaller than 1% of the picture either way is no region.
//! - The column lists a material's comments in reading order: those with a
//!   region by page, then from the top; then those on the whole material;
//!   ties by when they were written. Each gets the number its seal shows on
//!   the picture.

use dr_workspace::dto::{CommentInfo, Region};

/// A drag smaller than this (of the picture's width or height) is no region.
pub const MIN_REGION: f32 = 0.01;

/// A rectangle as fractions of the picture.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct UnitRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl UnitRect {
    /// The rectangle between two points of a drag, held inside the picture.
    pub fn between(a: (f32, f32), b: (f32, f32)) -> UnitRect {
        let c = |v: f32| v.clamp(0.0, 1.0);
        let (ax, ay, bx, by) = (c(a.0), c(a.1), c(b.0), c(b.1));
        UnitRect {
            x: ax.min(bx),
            y: ay.min(by),
            w: (ax - bx).abs(),
            h: (ay - by).abs(),
        }
    }

    pub fn of(region: &Region) -> UnitRect {
        UnitRect {
            x: region.x as f32,
            y: region.y as f32,
            w: region.w as f32,
            h: region.h as f32,
        }
    }

    /// Large enough to be a region.
    pub fn big_enough(&self) -> bool {
        self.w >= MIN_REGION && self.h >= MIN_REGION
    }

    /// The region to store, on `page` of a PDF (`None` on an image).
    pub fn region(&self, page: Option<u32>) -> Option<Region> {
        if !self.big_enough() {
            return None;
        }
        let r = Region {
            page,
            x: f64::from(self.x),
            y: f64::from(self.y),
            w: f64::from(self.w),
            h: f64::from(self.h),
        };
        r.to_model().map(|_| r)
    }

    pub fn contains(&self, (x, y): (f32, f32)) -> bool {
        x >= self.x && x <= self.x + self.w && y >= self.y && y <= self.y + self.h
    }

    fn area(&self) -> f32 {
        self.w * self.h
    }
}

/// One comment of the material, as the column lists it.
#[derive(Clone, Debug)]
pub struct Listed {
    /// From 1: the seal on the picture and in the column.
    pub number: usize,
    pub item: CommentInfo,
}

/// Where on an asset a listed comment originated (for grouping the 3 places in
/// the asset library viewer, `kernel-v5.md` §15 #9).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AssetPlace {
    Direct,
    Media {
        entry: String,
        module: String,
    },
    Embed {
        entry: String,
        module: String,
        embed: String,
    },
}

impl Listed {
    pub fn region(&self) -> Option<&Region> {
        self.item.region()
    }

    /// The PDF page its region is on (`None`: an image, or no region).
    pub fn page(&self) -> Option<u32> {
        self.region().and_then(|r| r.page)
    }

    pub fn todo(&self) -> bool {
        matches!(self.item.origin.as_str(), "marker" | "task")
    }

    pub fn resolved(&self) -> bool {
        self.item.status == "resolved"
    }

    pub fn asset_place(&self) -> AssetPlace {
        match (&self.item.target, &self.item.module, &self.item.part) {
            (Some(t), Some(module), Some(dr_workspace::dto::CommentPartDto::Media { .. }))
                if t.kind == "entry" =>
            {
                AssetPlace::Media {
                    entry: t.id.clone(),
                    module: module.clone(),
                }
            }
            (
                Some(t),
                Some(module),
                Some(dr_workspace::dto::CommentPartDto::Embed { embed, .. }),
            ) if t.kind == "entry" => AssetPlace::Embed {
                entry: t.id.clone(),
                module: module.clone(),
                embed: embed.clone(),
            },
            _ => AssetPlace::Direct,
        }
    }
}

/// All comments on asset `id` across all three places (`Asset`, `Media`
/// modules, and prose `Embed`s whose `(entry, module, embed)` is in
/// `embed_assets`), numbered in reading order for the asset-library viewer.
pub fn listed_for_asset_library(
    items: &[CommentInfo],
    id: &str,
    embed_assets: &std::collections::HashSet<(String, String, String)>,
) -> Vec<Listed> {
    let mut mine: Vec<&CommentInfo> = items
        .iter()
        .filter(|c| {
            let direct = c
                .target
                .as_ref()
                .is_some_and(|t| t.kind == "asset" && t.id == id);
            let on_media = !c.unlocated
                && matches!(
                    &c.part,
                    Some(dr_workspace::dto::CommentPartDto::Media { asset, .. }) if asset == id
                );
            let on_embed = !c.unlocated
                && match (&c.target, &c.module, &c.part) {
                    (
                        Some(t),
                        Some(module),
                        Some(dr_workspace::dto::CommentPartDto::Embed { embed, .. }),
                    ) if t.kind == "entry" => {
                        embed_assets.contains(&(t.id.clone(), module.clone(), embed.clone()))
                    }
                    _ => false,
                };
            direct || on_media || on_embed
        })
        .collect();
    let order = |c: &CommentInfo| match c.region() {
        Some(r) => f64::from(r.page.unwrap_or(1)) * 10.0 + r.y,
        None => f64::INFINITY,
    };
    mine.sort_by(|a, b| {
        order(a)
            .total_cmp(&order(b))
            .then(a.created_at.cmp(&b.created_at))
    });
    mine.into_iter()
        .enumerate()
        .map(|(i, c)| Listed {
            number: i + 1,
            item: c.clone(),
        })
        .collect()
}

/// The comments a page of file `id` (an asset id) lists among `items`, in
/// reading order and numbered: those straight on the file, and, on the page
/// of an item of a media module (`place` = its entry and module), those on
/// this file in that entry's module, not another entry's.
pub fn listed(items: &[CommentInfo], id: &str, place: Option<(&str, &str)>) -> Vec<Listed> {
    let mut mine: Vec<&CommentInfo> = items
        .iter()
        .filter(|c| {
            let on_item = matches!(
                &c.part,
                Some(dr_workspace::dto::CommentPartDto::Media { asset, .. }) if asset == id
            ) && place.is_some_and(|(entry, module)| {
                c.module.as_deref() == Some(module)
                    && c.target
                        .as_ref()
                        .is_some_and(|t| t.kind == "entry" && t.id == entry)
            });
            on_item
                || c.target
                    .as_ref()
                    .is_some_and(|t| t.kind == "asset" && t.id == id)
        })
        .collect();
    let order = |c: &CommentInfo| match c.region() {
        Some(r) => f64::from(r.page.unwrap_or(1)) * 10.0 + r.y,
        None => f64::INFINITY,
    };
    mine.sort_by(|a, b| {
        order(a)
            .total_cmp(&order(b))
            .then(a.created_at.cmp(&b.created_at))
    });
    mine.into_iter()
        .enumerate()
        .map(|(i, c)| Listed {
            number: i + 1,
            item: c.clone(),
        })
        .collect()
}

/// The region under `point` (fractions of the picture) on `page`: the
/// smallest one there, so a region inside another can be pointed at.
pub fn hit(listed: &[Listed], page: Option<u32>, point: (f32, f32)) -> Option<&Listed> {
    listed
        .iter()
        .filter(|l| l.region().is_some_and(|r| r.page == page))
        .filter(|l| UnitRect::of(l.region().expect("filtered")).contains(point))
        .min_by(|a, b| {
            let (a, b) = (
                UnitRect::of(a.region().expect("filtered")).area(),
                UnitRect::of(b.region().expect("filtered")).area(),
            );
            a.total_cmp(&b)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_workspace::dto::Target;

    fn comment(id: &str, on: &str, region: Option<Region>, at: i64) -> CommentInfo {
        CommentInfo {
            id: id.into(),
            target: Some(Target {
                kind: "entry".into(),
                id: "entry-1".into(),
            }),
            module: Some("mod-media".into()),
            part: Some(dr_workspace::dto::CommentPartDto::Media {
                asset: on.into(),
                region,
            }),
            unlocated: false,
            target_block: None,
            anchored: false,
            quote: None,
            body: dr_model::v3::LinkedText::plain(id),
            status: "open".into(),
            author_kind: "user".into(),
            author_name: None,
            source: "manual".into(),
            origin: "manual".into(),
            agent_conversation: None,
            projection: None,
            created_at: Some(at),
            updated_at: None,
        }
    }

    fn region(page: Option<u32>, x: f64, y: f64, w: f64, h: f64) -> Option<Region> {
        Some(Region { page, x, y, w, h })
    }

    /// A page lists the comments on its own entry's item and those straight
    /// on the file; a file only in the library lists the latter alone.
    #[test]
    fn a_page_lists_its_own_items_comments_and_the_files() {
        let mut other = comment("other-entry", "f", region(None, 0.1, 0.1, 0.2, 0.2), 2);
        other.target.as_mut().unwrap().id = "entry-2".into();
        let mut direct = comment("on-file", "f", None, 3);
        direct.target = Some(Target {
            kind: "asset".into(),
            id: "f".into(),
        });
        direct.module = None;
        direct.part = Some(dr_workspace::dto::CommentPartDto::Region {
            region: Region {
                page: None,
                x: 0.5,
                y: 0.5,
                w: 0.1,
                h: 0.1,
            },
        });
        let items = vec![
            comment("own", "f", region(None, 0.1, 0.1, 0.2, 0.2), 1),
            other,
            direct,
        ];
        let ids = |listed: Vec<Listed>| -> Vec<String> {
            let mut ids: Vec<String> = listed.into_iter().map(|l| l.item.id).collect();
            ids.sort();
            ids
        };
        assert_eq!(
            ids(listed(&items, "f", Some(("entry-1", "mod-media")))),
            ["on-file", "own"]
        );
        assert_eq!(
            ids(listed(&items, "f", Some(("entry-2", "mod-media")))),
            ["on-file", "other-entry"]
        );
        assert_eq!(ids(listed(&items, "f", None)), ["on-file"]);
    }

    #[test]
    fn a_drag_is_a_rectangle_inside_the_picture() {
        let r = UnitRect::between((0.8, 0.9), (0.2, -0.5));
        assert_eq!(
            r,
            UnitRect {
                x: 0.2,
                y: 0.0,
                w: 0.6,
                h: 0.9
            }
        );
        assert!(r.big_enough());
        let tiny = UnitRect::between((0.5, 0.5), (0.505, 0.6));
        assert!(!tiny.big_enough());
        assert_eq!(tiny.region(None), None);
        let stored = r.region(Some(2)).unwrap();
        assert_eq!(stored.page, Some(2));
        assert!((stored.x - 0.2).abs() < 1e-6 && (stored.h - 0.9).abs() < 1e-6);
    }

    #[test]
    fn comments_list_by_page_then_from_the_top() {
        let items = vec![
            comment("whole", "m1", None, 1),
            comment("p2-top", "m1", region(Some(2), 0.1, 0.1, 0.2, 0.2), 2),
            comment("p1-low", "m1", region(Some(1), 0.1, 0.7, 0.2, 0.2), 3),
            comment("p1-high", "m1", region(Some(1), 0.5, 0.2, 0.2, 0.2), 4),
            comment("elsewhere", "m2", region(None, 0.1, 0.1, 0.2, 0.2), 0),
        ];
        let listed = listed(&items, "m1", Some(("entry-1", "mod-media")));
        let ids: Vec<&str> = listed.iter().map(|l| l.item.id.as_str()).collect();
        assert_eq!(ids, ["p1-high", "p1-low", "p2-top", "whole"]);
        assert_eq!(
            listed.iter().map(|l| l.number).collect::<Vec<_>>(),
            [1, 2, 3, 4]
        );
        assert_eq!(listed[2].page(), Some(2));
        assert_eq!(listed[3].page(), None);
    }

    #[test]
    fn the_smallest_region_under_the_pointer_wins() {
        let items = vec![
            comment("big", "m", region(None, 0.0, 0.0, 1.0, 1.0), 1),
            comment("small", "m", region(None, 0.4, 0.4, 0.2, 0.2), 2),
            comment("paged", "m", region(Some(1), 0.4, 0.4, 0.1, 0.1), 3),
        ];
        let listed = listed(&items, "m", Some(("entry-1", "mod-media")));
        assert_eq!(hit(&listed, None, (0.5, 0.5)).unwrap().item.id, "small");
        assert_eq!(hit(&listed, None, (0.1, 0.1)).unwrap().item.id, "big");
        assert_eq!(
            hit(&listed, Some(1), (0.45, 0.45)).unwrap().item.id,
            "paged"
        );
        assert!(hit(&listed, Some(2), (0.45, 0.45)).is_none());
    }

    #[test]
    fn asset_library_viewer_lists_all_three_places_in_reading_order() {
        let mut direct = comment("direct", "asset-1", region(None, 0.1, 0.4, 0.2, 0.2), 1);
        direct.target = Some(Target {
            kind: "asset".into(),
            id: "asset-1".into(),
        });
        direct.module = None;
        direct.part = direct
            .region()
            .cloned()
            .map(|r| dr_workspace::dto::CommentPartDto::Region { region: r });

        let media = comment("media", "asset-1", region(None, 0.1, 0.1, 0.2, 0.2), 2);

        let mut embed = comment("embed", "asset-1", None, 3);
        embed.target = Some(Target {
            kind: "entry".into(),
            id: "entry-2".into(),
        });
        embed.module = Some("mod-prose".into());
        embed.part = Some(dr_workspace::dto::CommentPartDto::Embed {
            embed: "em-1".into(),
            region: region(None, 0.1, 0.25, 0.2, 0.2),
        });

        let mut unlocated_embed = embed.clone();
        unlocated_embed.id = "gone".into();
        unlocated_embed.unlocated = true;

        let mut embed_assets = std::collections::HashSet::new();
        embed_assets.insert(("entry-2".into(), "mod-prose".into(), "em-1".into()));

        let all = listed_for_asset_library(
            &[direct, media, embed, unlocated_embed],
            "asset-1",
            &embed_assets,
        );
        let ids: Vec<&str> = all.iter().map(|l| l.item.id.as_str()).collect();
        assert_eq!(ids, ["media", "embed", "direct"]);
        assert_eq!(
            all.iter().map(Listed::asset_place).collect::<Vec<_>>(),
            vec![
                AssetPlace::Media {
                    entry: "entry-1".into(),
                    module: "mod-media".into(),
                },
                AssetPlace::Embed {
                    entry: "entry-2".into(),
                    module: "mod-prose".into(),
                    embed: "em-1".into(),
                },
                AssetPlace::Direct,
            ]
        );
    }
}
