//! `tauri.conf.json` sizes the main window to `1440×900` logical pixels with a
//! `1000×700` logical minimum. Under high-DPI Windows display scaling (for
//! example 175% on a 1080p, 1440p, or 1600p laptop panel), `1440×900` logical
//! expands to `2520×1575` physical pixels — taller than the monitor's usable
//! `work_area` above the taskbar — so the bottom of the interface opens off-
//! screen until the author drags, resizes, or maximizes the window.
//!
//! Before showing the main desktop window (and after Windows strips native
//! decorations), fit `min_size`, `size`, and `position` inside the active
//! monitor's `work_area`. `min_size` is lowered first whenever `1000×700`
//! logical would exceed or lock the clamped window, so Win32 `WM_GETMINMAXINFO`
//! never clamps `SetWindowPos` back above `work_area`.

use tauri::{PhysicalPosition, PhysicalRect, PhysicalSize};

const DEFAULT_MIN_WIDTH_LOGICAL: f64 = 1000.0;
const DEFAULT_MIN_HEIGHT_LOGICAL: f64 = 700.0;
const FLOOR_MIN_WIDTH_LOGICAL: f64 = 640.0;
const FLOOR_MIN_HEIGHT_LOGICAL: f64 = 440.0;
const RESIZE_SLACK_LOGICAL: f64 = 120.0;
const CLAMP_MARGIN_LOGICAL: f64 = 24.0;

#[cfg_attr(not(desktop), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowFitPlan {
    pub min_inner_size: Option<PhysicalSize<u32>>,
    pub inner_size: Option<PhysicalSize<u32>>,
    pub outer_position: Option<PhysicalPosition<i32>>,
}

#[cfg_attr(not(desktop), allow(dead_code))]
fn fit_min_axis(default_min: u32, floor_min: u32, max_inner: u32, slack: u32) -> u32 {
    let comfortable_max = max_inner
        .saturating_sub(slack)
        .max(floor_min)
        .min(max_inner);
    default_min.min(comfortable_max)
}

#[cfg_attr(not(desktop), allow(dead_code))]
pub(crate) fn plan_window_fit(
    work_area: PhysicalRect<i32, u32>,
    scale_factor: f64,
    inner_size: PhysicalSize<u32>,
    outer_size: PhysicalSize<u32>,
    outer_position: PhysicalPosition<i32>,
) -> WindowFitPlan {
    if work_area.size.width == 0 || work_area.size.height == 0 {
        return WindowFitPlan {
            min_inner_size: None,
            inner_size: None,
            outer_position: None,
        };
    }

    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let frame_w = outer_size.width.saturating_sub(inner_size.width);
    let frame_h = outer_size.height.saturating_sub(inner_size.height);

    let margin = (CLAMP_MARGIN_LOGICAL * scale).round().max(0.0) as u32;
    let max_outer_w = if work_area.size.width > margin.saturating_mul(2) {
        work_area.size.width - margin
    } else {
        work_area.size.width
    };
    let max_outer_h = if work_area.size.height > margin.saturating_mul(2) {
        work_area.size.height - margin
    } else {
        work_area.size.height
    };
    let max_inner_w = max_outer_w.saturating_sub(frame_w).max(1);
    let max_inner_h = max_outer_h.saturating_sub(frame_h).max(1);

    let default_min_w = (DEFAULT_MIN_WIDTH_LOGICAL * scale).round() as u32;
    let default_min_h = (DEFAULT_MIN_HEIGHT_LOGICAL * scale).round() as u32;
    let floor_min_w = (FLOOR_MIN_WIDTH_LOGICAL * scale).round() as u32;
    let floor_min_h = (FLOOR_MIN_HEIGHT_LOGICAL * scale).round() as u32;
    let slack = (RESIZE_SLACK_LOGICAL * scale).round() as u32;

    let min_w = fit_min_axis(default_min_w, floor_min_w, max_inner_w, slack);
    let min_h = fit_min_axis(default_min_h, floor_min_h, max_inner_h, slack);
    let min_inner_size = (min_w != default_min_w || min_h != default_min_h)
        .then_some(PhysicalSize::new(min_w, min_h));

    let needs_resize =
        outer_size.width > work_area.size.width || outer_size.height > work_area.size.height;
    let new_inner_size = if needs_resize {
        let target_w = inner_size.width.min(max_inner_w);
        let target_h = inner_size.height.min(max_inner_h);
        (target_w != inner_size.width || target_h != inner_size.height)
            .then_some(PhysicalSize::new(target_w, target_h))
    } else {
        None
    };

    let final_outer_w =
        new_inner_size.map_or(outer_size.width, |size| size.width.saturating_add(frame_w));
    let final_outer_h = new_inner_size.map_or(outer_size.height, |size| {
        size.height.saturating_add(frame_h)
    });

    let work_left = i64::from(work_area.position.x);
    let work_top = i64::from(work_area.position.y);
    let work_w = i64::from(work_area.size.width);
    let work_h = i64::from(work_area.size.height);
    let outer_w = i64::from(final_outer_w);
    let outer_h = i64::from(final_outer_h);

    let (target_x, target_y) = if new_inner_size.is_some() {
        (
            (work_left + (work_w - outer_w).max(0) / 2) as i32,
            (work_top + (work_h - outer_h).max(0) / 2) as i32,
        )
    } else {
        let max_x = work_left + (work_w - outer_w).max(0);
        let max_y = work_top + (work_h - outer_h).max(0);
        (
            i64::from(outer_position.x).clamp(work_left, max_x) as i32,
            i64::from(outer_position.y).clamp(work_top, max_y) as i32,
        )
    };
    let outer_position = (target_x != outer_position.x || target_y != outer_position.y)
        .then_some(PhysicalPosition::new(target_x, target_y));

    WindowFitPlan {
        min_inner_size,
        inner_size: new_inner_size,
        outer_position,
    }
}

#[cfg(desktop)]
pub(crate) fn fit_main_window(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let monitor = match window.current_monitor()? {
        Some(monitor) => Some(monitor),
        None => window.primary_monitor()?,
    };
    let Some(monitor) = monitor else {
        return Ok(());
    };

    let plan = plan_window_fit(
        *monitor.work_area(),
        monitor.scale_factor(),
        window.inner_size()?,
        window.outer_size()?,
        window.outer_position()?,
    );
    if let Some(min_size) = plan.min_inner_size {
        window.set_min_size(Some(tauri::Size::Physical(min_size)))?;
    }
    if let Some(size) = plan.inner_size {
        window.set_size(tauri::Size::Physical(size))?;
    }
    if let Some(position) = plan.outer_position {
        window.set_position(tauri::Position::Physical(position))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_roomy_display_untouched() {
        let work_area = PhysicalRect {
            position: PhysicalPosition::new(0, 50),
            size: PhysicalSize::new(3456, 2100),
        };
        let plan = plan_window_fit(
            work_area,
            2.0,
            PhysicalSize::new(2880, 1800),
            PhysicalSize::new(2880, 1800),
            PhysicalPosition::new(288, 200),
        );
        assert_eq!(
            plan,
            WindowFitPlan {
                min_inner_size: None,
                inner_size: None,
                outer_position: None,
            }
        );
    }

    #[test]
    fn clamps_height_and_centers_on_1440p_at_175_percent_scale() {
        // 2560x1440 with 48pt taskbar at 175% -> 2560x1356 physical work_area.
        // Default 1440x900 logical = 2520x1575 physical, plus Win32 borderless shadow insets (14x7).
        let work_area = PhysicalRect {
            position: PhysicalPosition::new(0, 0),
            size: PhysicalSize::new(2560, 1356),
        };
        let plan = plan_window_fit(
            work_area,
            1.75,
            PhysicalSize::new(2520, 1575),
            PhysicalSize::new(2534, 1582),
            PhysicalPosition::new(120, 120),
        );
        let new_inner = plan.inner_size.expect("height overflows work_area");
        let new_min = plan
            .min_inner_size
            .expect("min height leaves resize slack inside clamped height");
        let new_pos = plan.outer_position.expect("centered inside work_area");

        assert!(new_min.width <= new_inner.width);
        assert!(new_min.height <= new_inner.height);
        assert!(new_inner.width + 14 <= work_area.size.width);
        assert!(new_inner.height + 7 <= work_area.size.height);
        assert!(new_pos.x >= 0);
        assert!(new_pos.y >= 0);
        assert!((new_pos.y as u32) + new_inner.height + 7 <= work_area.size.height);
    }

    #[test]
    fn lowers_min_size_before_clamping_on_1080p_at_175_percent_scale() {
        // 1920x1080 with 48pt taskbar at 175% -> 1920x996 physical work_area.
        // Default 1000x700 min logical = 1750x1225 physical (> 996px work_area height).
        let work_area = PhysicalRect {
            position: PhysicalPosition::new(0, 0),
            size: PhysicalSize::new(1920, 996),
        };
        let plan = plan_window_fit(
            work_area,
            1.75,
            PhysicalSize::new(2520, 1575),
            PhysicalSize::new(2534, 1582),
            PhysicalPosition::new(80, 80),
        );
        let new_min = plan.min_inner_size.expect("must lower 1225px min_height");
        let new_inner = plan.inner_size.expect("must clamp both axes");
        let new_pos = plan.outer_position.expect("must center inside work_area");

        assert!(new_min.width <= new_inner.width);
        assert!(new_min.height <= new_inner.height);
        assert!(new_inner.width + 14 <= work_area.size.width);
        assert!(new_inner.height + 7 <= work_area.size.height);
        assert!((new_pos.x as u32) + new_inner.width + 14 <= work_area.size.width);
        assert!((new_pos.y as u32) + new_inner.height + 7 <= work_area.size.height);
    }

    #[test]
    fn pulls_cascaded_window_inside_work_area_on_secondary_monitor() {
        // Secondary monitor to the left (-2560, 40) with top taskbar; size fits
        // work_area, but OS cascade placed bottom past work_area bottom.
        let work_area = PhysicalRect {
            position: PhysicalPosition::new(-2560, 40),
            size: PhysicalSize::new(2560, 1400),
        };
        let plan = plan_window_fit(
            work_area,
            1.25,
            PhysicalSize::new(1800, 1125),
            PhysicalSize::new(1800, 1125),
            PhysicalPosition::new(-2400, 360),
        );
        assert_eq!(plan.min_inner_size, None);
        assert_eq!(plan.inner_size, None);
        assert_eq!(plan.outer_position, Some(PhysicalPosition::new(-2400, 315)));
    }
}
