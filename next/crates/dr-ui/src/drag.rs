//! Shared drag payloads across views and the prose editor.

use gpui::SharedString;

/// One or more files or folders dragged from the asset library (`素材库`),
/// accepted by the library itself, `MediaModule`, and `dr-editor` prose.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetDrag {
    pub book: String,
    pub assets: Vec<String>,
    pub folders: Vec<String>,
    pub label: SharedString,
}
