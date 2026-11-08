//! A book's last days on its card (the 0.1 client's `SandStrip`,
//! docs/writing-days.md): one upright sand stroke per day written, as tall
//! as its share of the busiest of them, and a few loose grains for each day
//! without words, in ink 2 like the progress stroke under it. 20 px high,
//! as wide as the card gives it.

use std::{rc::Rc, sync::Arc};

use dr_ui::Theme;
use gpui::{
    App, Bounds, Corners, ElementId, InteractiveElement as _, IntoElement, ParentElement as _,
    Pixels, RenderImage, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, canvas, div, px,
};

use crate::heat::paint_strip;
use crate::images;

pub const STRIP_HEIGHT: f32 = 20.0;

#[derive(IntoElement)]
pub struct SandStrip {
    id: ElementId,
    daily: Rc<Vec<u64>>,
    seed: u32,
    label: SharedString,
}

impl SandStrip {
    /// `daily`: words on each of the last days, today last; `seed`: the
    /// book's ([`crate::art::cover_seed`]), so its strokes stay put.
    pub fn new(
        id: impl Into<ElementId>,
        daily: Rc<Vec<u64>>,
        seed: u32,
        label: impl Into<SharedString>,
    ) -> SandStrip {
        SandStrip {
            id: id.into(),
            daily,
            seed,
            label: label.into(),
        }
    }
}

/// The strip as last painted: for which days, width, scale and colour.
#[derive(Default)]
struct Painted {
    made_for: Option<(Vec<u64>, u32, u32, [u32; 3])>,
    image: Option<Arc<RenderImage>>,
}

impl RenderOnce for SandStrip {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let painted = window.use_keyed_state(self.id.clone(), cx, |_, _| Painted::default());
        let (daily, seed) = (self.daily.clone(), self.seed);
        div()
            .id(self.id)
            .role(gpui::Role::Image)
            .aria_label(self.label)
            .w_full()
            .h(px(STRIP_HEIGHT))
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds: Bounds<Pixels>, _, window, cx| {
                        let p = Theme::of(window, cx).palette;
                        let dpr = window.scale_factor().min(2.0);
                        let width = f32::from(bounds.size.width).round();
                        if width <= 0.0 {
                            return;
                        }
                        let color = p.sand_on(p.ink(2), p.desk);
                        let tag = [color.r, color.g, color.b].map(|c| (c * 1000.0) as u32);
                        let want = (daily.to_vec(), width as u32, (dpr * 100.0) as u32, tag);
                        let fresh = painted
                            .read(cx)
                            .made_for
                            .as_ref()
                            .is_none_or(|m| *m != want);
                        if fresh {
                            let mask = paint_strip(&daily, width, STRIP_HEIGHT, dpr, seed);
                            let image = images::tinted(
                                &mask.alpha,
                                mask.width,
                                mask.height,
                                color,
                                p.pigment,
                            );
                            let old = painted.update(cx, |s, _| {
                                s.made_for = Some(want);
                                s.image.replace(image)
                            });
                            if let Some(old) = old {
                                let _ = window.drop_image(old);
                            }
                        }
                        if let Some(image) = painted.read(cx).image.clone() {
                            let at = Bounds {
                                origin: bounds.origin,
                                size: gpui::size(px(width), px(STRIP_HEIGHT)),
                            };
                            let _ = window.paint_image(at, at, Corners::default(), image, 0, false);
                        }
                    },
                )
                .size_full(),
            )
    }
}
