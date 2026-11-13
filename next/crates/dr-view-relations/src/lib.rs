//! Canonical v3 relations module.
pub mod legend;
pub mod look;
pub mod model;
mod section;
pub use section::register_modules;

/// The name a relation type is shown by: the built-in generic association
/// (`system_key` `generic-association`) in the interface language, any
/// other by the name it was given.
pub fn type_name(
    info: &dr_workspace::commands::v3::content::RelationTypeInfo,
    cx: &gpui::App,
) -> String {
    if info.system_key.as_deref() == Some("generic-association") {
        dr_shell::strings::t(cx, dr_i18n::keys::relation_types::generic_association::NAME)
            .to_string()
    } else {
        info.definition.name.clone()
    }
}
