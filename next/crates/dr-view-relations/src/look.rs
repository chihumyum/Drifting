use dr_ui::tokens::Rgb;
use gpui::{IntoElement, Styled, canvas, point, px, size};

pub fn dotted_rule(color: Rgb) -> impl IntoElement {
    let color = color.solid();
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let w = f32::from(bounds.size.width);
            let mut x = 0.0;
            while x < w {
                window.paint_quad(gpui::fill(
                    gpui::Bounds {
                        origin: bounds.origin + point(px(x), px(0.0)),
                        size: size(px(1.0), px(1.0)),
                    },
                    color,
                ));
                x += 3.0;
            }
        },
    )
    .w_full()
    .h(px(1.0))
}
