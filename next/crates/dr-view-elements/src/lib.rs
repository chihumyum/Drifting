//! Canonical v3 fields, level displays and selectors.
pub mod category;
pub mod data;
pub mod dialogs;
pub mod fields;
pub mod menu;
mod page;
pub mod panel;
pub mod patches;
pub mod storyline;
pub mod swatch;
pub use fields::Fields;

pub fn init(cx: &mut gpui::App) {
    fields::v3::register(cx);
    patches::register(cx);
    dr_view_relations::register_modules(cx);
    storyline::init_v3(cx);
    panel::v3::register(cx);
    category::v3::register(cx);
    menu::v3::register(cx);
    dr_shell::v3::add_level_display(cx, "board", |host, _, cx| {
        panel::v3::make(host, panel::v3::Display::Board, cx)
    });
}

#[cfg(test)]
mod release_tests;
