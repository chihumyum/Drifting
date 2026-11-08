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

impl Listed {
    pub fn region(&self) -> Option<&Region> {
        self.item.region.as_ref()
    }

    /// The PDF page its region is on (`None`: an image, or no region).
    pub fn page(&self) -> Option<u32> {
        self.region().and_then(|r| r.page)
    }

    pub fn todo(&self) -> bool {
        self.item.kind == "todo"
    }

    pub fn resolved(&self) -> bool {
        self.item.status == "resolved"
    }
}

/// The comments on material `id` among `items`, in reading order and
/// numbered.
pub fn listed(items: &[CommentInfo], id: &str) -> Vec<Listed> {
    let mut mine: Vec<&CommentInfo> = items
        .iter()
        .filter(|c| {
            c.target
                .as_ref()
                .is_some_and(|t| t.kind == "material" && t.id == id)
        })
        .collect();
    let order = |c: &CommentInfo| match &c.region {
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
            kind: "note".into(),
            target: Some(Target {
                kind: "material".into(),
                id: on.into(),
            }),
            unlocated: false,
            target_block: None,
            anchored: false,
            quote: None,
            body: id.into(),
            status: "open".into(),
            priority: None,
            author_kind: "user".into(),
            author_name: None,
            source: "manual".into(),
            agent_conversation: None,
            projection: None,
            region,
            created_at: Some(at),
            updated_at: None,
        }
    }

    fn region(page: Option<u32>, x: f64, y: f64, w: f64, h: f64) -> Option<Region> {
        Some(Region { page, x, y, w, h })
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
        let listed = listed(&items, "m1");
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
        let listed = listed(&items, "m");
        assert_eq!(hit(&listed, None, (0.5, 0.5)).unwrap().item.id, "small");
        assert_eq!(hit(&listed, None, (0.1, 0.1)).unwrap().item.id, "big");
        assert_eq!(
            hit(&listed, Some(1), (0.45, 0.45)).unwrap().item.id,
            "paged"
        );
        assert!(hit(&listed, Some(2), (0.45, 0.45)).is_none());
    }
}
