//! Canonical v3 timeline.
pub mod spring;
pub mod v3;
pub fn init(cx: &mut gpui::App) {
    v3::init(cx);
}
