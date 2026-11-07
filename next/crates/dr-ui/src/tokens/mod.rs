//! Design tokens as compile-time constants: colours, type and spacing,
//! motion. Nothing here is looked up by name at run time.

pub mod color;
pub mod metrics;
pub mod motion;
pub mod page;

pub use color::{Palette, Rgb, Story};
pub use metrics::{TextSize, TypeScale, glass, menu, radius, space, surface};
pub use motion::{Easing, Motion};
