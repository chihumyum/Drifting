//! What the timeline keeps for each book on this device (the 0.1 client
//! kept it in localStorage and its ui-store): 书序 or 叙事时, whether 未归属
//! shows, the zoom and the sideways scroll. The shell keeps it for the book
//! on this device (`Workspace::book_memory`, under [`KEY`]; F2's
//! `local_state`, gone with the book); it never goes into the book. It is
//! applied once the workspace has read it (`book_memory_ready`).

use serde::{Deserialize, Serialize};

use crate::model::{Axis, MAX_ZOOM, MIN_ZOOM};

/// The key in the shell's per-book memory.
pub const KEY: &str = "timeline";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Kept {
    pub axis: Axis,
    pub unaffiliated: bool,
    pub zoom: f32,
    /// px from the axis's start.
    pub scroll_x: f32,
}

impl Default for Kept {
    fn default() -> Self {
        Kept {
            axis: Axis::Book,
            unaffiliated: false,
            zoom: 1.0,
            scroll_x: 0.0,
        }
    }
}

impl Kept {
    /// What `value` says, out-of-range numbers brought back in.
    pub fn read(value: Option<&serde_json::Value>) -> Kept {
        let mut kept: Kept = value
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        kept.zoom = if kept.zoom.is_finite() {
            kept.zoom.clamp(MIN_ZOOM, MAX_ZOOM)
        } else {
            1.0
        };
        kept.scroll_x = if kept.scroll_x.is_finite() {
            kept.scroll_x.max(0.0)
        } else {
            0.0
        };
        kept
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_it_wrote_and_mends_the_rest() {
        let kept = Kept {
            axis: Axis::Narrative,
            unaffiliated: true,
            zoom: 2.0,
            scroll_x: 120.0,
        };
        let value = serde_json::to_value(&kept).unwrap();
        assert_eq!(value["axis"], "narrative");
        assert_eq!(Kept::read(Some(&value)), kept);
        assert_eq!(Kept::read(None), Kept::default());
        let odd = serde_json::json!({"zoom": 40.0, "scroll_x": -3.0, "axis": "sideways"});
        assert_eq!(Kept::read(Some(&odd)), Kept::default());
        let far = serde_json::json!({"zoom": 40.0, "scroll_x": -3.0});
        let mended = Kept::read(Some(&far));
        assert_eq!((mended.zoom, mended.scroll_x), (MAX_ZOOM, 0.0));
    }
}
