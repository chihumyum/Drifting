//! Where the picture lies on the stage, and how zoom and pan move it (the
//! 0.1 client's `useZoomPanSurface` and the fitting of `ImageMediaStage`
//! and `PdfMediaStage`).
//!
//! - The picture is fitted into the stage's [`area`]: the stage less a band
//!   at the top for the toolbar and, when there are pages to turn, a band
//!   at the foot for the pager, with 16 px of desk round the picture. An
//!   image is never larger than its own pixels; a PDF page is at most 1.8×
//!   and at least 0.18× its size in points.
//! - Zoom (0.5× to 6× of the fitted size) is about the picture's centre and
//!   then moved by the pan. At or under the fitted size there is nothing to
//!   pan: the picture is centred again. Zooming at a point keeps that point
//!   where it is.
//! - New here: the toolbar and the pager never cover the fitted picture
//!   (the 0.1 client laid them over it), images get the same desk round
//!   them as pages, and however far it is dragged, 48 px of the picture
//!   stay in the area (the 0.1 client let it go off entirely).
//!
//! Points and sizes are in the stage's pixels, its top left corner at 0.

/// The smallest and largest zoom, of the fitted size.
pub const MIN_ZOOM: f32 = 0.5;
pub const MAX_ZOOM: f32 = 6.0;
/// ⌘ + wheel: each pixel of wheel zooms by e^0.002 (0.1: the same).
pub const WHEEL_ZOOM: f32 = 0.002;
/// The toolbar's − and +.
pub const STEP: f32 = 1.25;
/// How much of the picture stays in the area.
pub const KEEP: f32 = 48.0;
/// The toolbar's band at the top of the stage (12 px, the 36 px pill, 8 px).
pub const TOOLBAR_BAND: f32 = 56.0;
/// The pager's band at the foot (16 px, the 36 px pill, 12 px).
pub const PAGER_BAND: f32 = 64.0;
/// Desk round a fitted picture.
pub const MARGIN: f32 = 16.0;

/// A rectangle in stage pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Frame {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Frame {
    pub fn contains(&self, (x, y): (f32, f32)) -> bool {
        x >= self.x && x <= self.x + self.w && y >= self.y && y <= self.y + self.h
    }

    pub fn centre(&self) -> (f32, f32) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }
}

/// Where a picture is fitted and centred on a stage of `stage`: under the
/// toolbar, and above the pager when `paged`.
pub fn area(stage: (f32, f32), paged: bool) -> Frame {
    let foot = if paged { PAGER_BAND } else { 0.0 };
    Frame {
        x: 0.0,
        y: TOOLBAR_BAND,
        w: stage.0.max(0.0),
        h: (stage.1 - TOOLBAR_BAND - foot).max(0.0),
    }
}

/// Zoom and pan: the scale of the fitted size, and how far the picture's
/// centre is from the area's.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Viewport {
    pub scale: f32,
    pub pan_x: f32,
    pub pan_y: f32,
}

impl Default for Viewport {
    fn default() -> Self {
        Viewport::FIT
    }
}

pub fn clamp_zoom(scale: f32) -> f32 {
    if scale.is_finite() {
        scale.clamp(MIN_ZOOM, MAX_ZOOM)
    } else {
        1.0
    }
}

impl Viewport {
    /// Fitted, centred.
    pub const FIT: Viewport = Viewport {
        scale: 1.0,
        pan_x: 0.0,
        pan_y: 0.0,
    };

    /// Larger than fitted: there is somewhere to pan to.
    pub fn zoomed(&self) -> bool {
        self.scale > 1.0
    }

    /// Zoomed to `scale`, the point `anchor` (from the area's centre)
    /// staying where it is.
    pub fn zoom_at(self, scale: f32, anchor: (f32, f32)) -> Viewport {
        let scale = clamp_zoom(scale);
        if scale == self.scale {
            return self;
        }
        if scale <= 1.0 {
            return Viewport {
                scale,
                pan_x: 0.0,
                pan_y: 0.0,
            };
        }
        let ratio = scale / self.scale;
        Viewport {
            scale,
            pan_x: ratio * self.pan_x + (1.0 - ratio) * anchor.0,
            pan_y: ratio * self.pan_y + (1.0 - ratio) * anchor.1,
        }
    }

    /// Zoomed by `factor` at `anchor`.
    pub fn zoom_by(self, factor: f32, anchor: (f32, f32)) -> Viewport {
        self.zoom_at(self.scale * factor, anchor)
    }

    /// Moved by a drag or a wheel; only when zoomed in.
    pub fn pan_by(self, dx: f32, dy: f32) -> Viewport {
        if !self.zoomed() {
            return self;
        }
        Viewport {
            pan_x: self.pan_x + dx,
            pan_y: self.pan_y + dy,
            ..self
        }
    }

    /// The pan held so [`KEEP`] pixels of a picture fitted at `fitted` stay
    /// in `area`.
    pub fn kept(self, fitted: (f32, f32), area: Frame) -> Viewport {
        if !self.zoomed() {
            return self;
        }
        let limit = |m: f32, s: f32| ((m * self.scale + s) / 2.0 - KEEP).max(0.0);
        let (lx, ly) = (limit(fitted.0, area.w), limit(fitted.1, area.h));
        Viewport {
            pan_x: self.pan_x.clamp(-lx, lx),
            pan_y: self.pan_y.clamp(-ly, ly),
            ..self
        }
    }

    /// Where a picture fitted at `fitted` lies, centred in `area`.
    pub fn frame(&self, fitted: (f32, f32), area: Frame) -> Frame {
        let (w, h) = (fitted.0 * self.scale, fitted.1 * self.scale);
        let (cx, cy) = area.centre();
        Frame {
            x: cx + self.pan_x - w / 2.0,
            y: cy + self.pan_y - h / 2.0,
            w,
            h,
        }
    }
}

/// An image fitted into an area of `room`: as large as fits inside the
/// margins, never past its pixels.
pub fn fit_image(natural: (f32, f32), room: (f32, f32)) -> (f32, f32) {
    let (w, h) = (room.0 - 2.0 * MARGIN, room.1 - 2.0 * MARGIN);
    if natural.0 <= 0.0 || natural.1 <= 0.0 || w <= 0.0 || h <= 0.0 {
        return (0.0, 0.0);
    }
    let fit = 1f32.min(w / natural.0).min(h / natural.1);
    ((natural.0 * fit).floor(), (natural.1 * fit).floor())
}

/// A PDF page (its size in points) fitted into an area of `room`.
pub fn fit_page(page: (f32, f32), room: (f32, f32)) -> (f32, f32) {
    if page.0 <= 0.0 || page.1 <= 0.0 {
        return (0.0, 0.0);
    }
    let w = (room.0 - 2.0 * MARGIN).max(160.0);
    let h = (room.1 - 2.0 * MARGIN).max(160.0);
    let scale = (w / page.0).min(h / page.1).clamp(0.18, 1.8);
    ((page.0 * scale).floor(), (page.1 * scale).floor())
}

/// A stage point as fractions of `frame` (outside 0–1 when outside it).
pub fn to_unit(point: (f32, f32), frame: Frame) -> (f32, f32) {
    if frame.w <= 0.0 || frame.h <= 0.0 {
        return (0.0, 0.0);
    }
    ((point.0 - frame.x) / frame.w, (point.1 - frame.y) / frame.h)
}

/// How many device pixels a PDF page is rendered at: the page as shown, at
/// the display's scale, held under [`MAX_PIXELS`] (and 8192 a side); a new
/// rendering is made only when this moves by more than [`RERENDER`].
pub fn render_scale(page: (f32, f32), shown: (f32, f32), device: f32) -> f32 {
    if page.0 <= 0.0 || page.1 <= 0.0 {
        return 1.0;
    }
    let mut scale = (shown.0 / page.0) * device.max(1.0);
    let (w, h) = (page.0 * scale, page.1 * scale);
    if w * h > MAX_PIXELS {
        scale *= (MAX_PIXELS / (w * h)).sqrt();
    }
    let side = (page.0 * scale).max(page.1 * scale);
    if side > 8192.0 {
        scale *= 8192.0 / side;
    }
    scale.max(0.05)
}

/// The most pixels one rendered page holds (4096 × 4096).
pub const MAX_PIXELS: f32 = 4096.0 * 4096.0;
/// A rendering is redone when the scale it needs is 15% off.
pub const RERENDER: f32 = 0.15;

/// Whether a page rendered at `had` should be rendered again for `want`.
pub fn needs_rerender(had: f32, want: f32) -> bool {
    had <= 0.0 || (want / had - 1.0).abs() > RERENDER
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zooming_at_a_point_keeps_it_still() {
        let v = Viewport::FIT.zoom_at(2.0, (100.0, -40.0));
        // The point 100 px right of the centre was at 100 px of the
        // fitted picture's centre; at 2× it is at 200, less the pan.
        assert_eq!(v.scale, 2.0);
        assert_eq!((v.pan_x, v.pan_y), (-100.0, 40.0));
        let back = v.zoom_at(4.0, (100.0, -40.0));
        // Still under the pointer: (100 - pan) / scale is the same point.
        let at = |v: Viewport| ((100.0 - v.pan_x) / v.scale, (-40.0 - v.pan_y) / v.scale);
        assert_eq!(at(v), at(back));
        // Back to the fitted size or under: centred.
        assert_eq!(
            back.zoom_at(0.8, (5.0, 5.0)),
            Viewport {
                scale: 0.8,
                pan_x: 0.0,
                pan_y: 0.0
            }
        );
    }

    #[test]
    fn zoom_has_bounds_and_pan_needs_zoom() {
        assert_eq!(Viewport::FIT.zoom_by(100.0, (0.0, 0.0)).scale, MAX_ZOOM);
        assert_eq!(Viewport::FIT.zoom_by(0.01, (0.0, 0.0)).scale, MIN_ZOOM);
        assert_eq!(clamp_zoom(f32::NAN), 1.0);
        assert_eq!(Viewport::FIT.pan_by(30.0, 30.0), Viewport::FIT);
        let z = Viewport::FIT.zoom_at(2.0, (0.0, 0.0)).pan_by(30.0, -10.0);
        assert_eq!((z.pan_x, z.pan_y), (30.0, -10.0));
    }

    #[test]
    fn a_dragged_picture_keeps_a_corner_in_the_area() {
        let a = area((800.0, 656.0), false);
        let z = Viewport::FIT
            .zoom_at(2.0, (0.0, 0.0))
            .pan_by(5000.0, -5000.0);
        let kept = z.kept((400.0, 300.0), a);
        let f = kept.frame((400.0, 300.0), a);
        // 48 px of the picture are still in the area, at its right and top.
        assert_eq!(a.x + a.w - f.x, KEEP);
        assert_eq!(f.y + f.h - a.y, KEEP);
    }

    #[test]
    fn the_toolbar_and_pager_keep_their_bands() {
        let plain = area((800.0, 700.0), false);
        assert_eq!(
            plain,
            Frame {
                x: 0.0,
                y: TOOLBAR_BAND,
                w: 800.0,
                h: 700.0 - TOOLBAR_BAND
            }
        );
        let paged = area((800.0, 700.0), true);
        assert_eq!(paged.h, 700.0 - TOOLBAR_BAND - PAGER_BAND);
        // A fitted page clears both bands.
        let fitted = fit_page((420.0, 595.0), (paged.w, paged.h));
        let f = Viewport::FIT.frame(fitted, paged);
        assert!(f.y >= TOOLBAR_BAND + MARGIN - 0.5, "{f:?}");
        assert!(f.y + f.h <= 700.0 - PAGER_BAND - MARGIN + 0.5, "{f:?}");
    }

    #[test]
    fn images_fit_without_growing_and_pages_keep_a_margin() {
        assert_eq!(fit_image((400.0, 300.0), (800.0, 600.0)), (400.0, 300.0));
        assert_eq!(fit_image((1600.0, 1200.0), (832.0, 632.0)), (800.0, 600.0));
        assert_eq!(fit_image((1000.0, 100.0), (532.0, 532.0)), (500.0, 50.0));
        assert_eq!(fit_image((0.0, 10.0), (500.0, 500.0)), (0.0, 0.0));
        // A5 in a 800 × 580 area: (580 - 32) / 595.
        let (w, h) = fit_page((420.0, 595.0), (800.0, 580.0));
        assert_eq!(h, (595.0f32 * (548.0 / 595.0)).floor());
        assert!(w < 800.0 - 32.0);
        // Never past 1.8×.
        assert_eq!(fit_page((100.0, 100.0), (2000.0, 2000.0)), (180.0, 180.0));
    }

    #[test]
    fn frames_and_units_meet() {
        let a = Frame {
            x: 0.0,
            y: 0.0,
            w: 800.0,
            h: 600.0,
        };
        let v = Viewport::FIT.zoom_at(2.0, (0.0, 0.0));
        let f = v.frame((200.0, 100.0), a);
        assert_eq!(
            f,
            Frame {
                x: 200.0,
                y: 200.0,
                w: 400.0,
                h: 200.0
            }
        );
        assert_eq!(to_unit((400.0, 300.0), f), (0.5, 0.5));
        assert_eq!(to_unit((200.0, 200.0), f), (0.0, 0.0));
        assert!(f.contains((300.0, 250.0)) && !f.contains((100.0, 250.0)));
    }

    #[test]
    fn pages_render_at_the_shown_size_within_bounds() {
        // A5 shown 400 px wide on a 2× display: 800 device pixels wide.
        let s = render_scale((420.0, 595.0), (400.0, 567.0), 2.0);
        assert!((420.0 * s - 800.0).abs() < 1.0);
        // Zoomed far in, held under the pixel budget.
        let s = render_scale((420.0, 595.0), (4000.0, 5667.0), 2.0);
        assert!(420.0 * s * 595.0 * s <= MAX_PIXELS * 1.001);
        assert!(!needs_rerender(2.0, 2.2));
        assert!(needs_rerender(2.0, 2.4));
        assert!(needs_rerender(0.0, 1.0));
    }
}
