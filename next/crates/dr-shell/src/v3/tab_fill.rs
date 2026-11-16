//! The left Tab's local layout choice and the scope shared by its canvases.
use dr_i18n::Key;
use dr_i18n::keys;
use dr_workspace::commands::v3::types::{ProjectTab, TabMount};
use serde::{Deserialize, Serialize};

use crate::{book::v3::BookV3, pages::PageViewHost};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FillLayout {
    #[default]
    List,
    Grid,
    Board,
    Island,
    Relation,
}

impl FillLayout {
    pub const ALL: [Self; 5] = [
        Self::List,
        Self::Grid,
        Self::Board,
        Self::Island,
        Self::Relation,
    ];

    pub fn default_for(display: &str) -> Self {
        match display {
            "grid" => Self::Grid,
            "board" => Self::Board,
            // Island-based collections open on their relation canvas.
            "island" => Self::Relation,
            _ => Self::List,
        }
    }

    pub fn display(self) -> Option<&'static str> {
        match self {
            Self::List => Some("list"),
            Self::Grid => Some("grid"),
            Self::Board => Some("board"),
            Self::Island | Self::Relation => None,
        }
    }

    pub fn label(self) -> Key {
        use keys::v3_shell as k;
        match self {
            Self::List => k::LIST,
            Self::Grid => k::GRID,
            Self::Board => k::BOARD,
            Self::Island => k::ISLANDS,
            Self::Relation => keys::super_element::layout::RELATE,
        }
    }
}

#[derive(Clone)]
pub struct TabCanvasHost {
    pub page: PageViewHost,
    pub tab: ProjectTab,
    pub layout: FillLayout,
}

/// The top of a Tab's scope. Entry Tabs contain what lives below the
/// mount and what hangs on it. Book Tabs consume the book sequence.
pub fn tab_entries(book: &BookV3, mount: &TabMount) -> Vec<String> {
    match mount {
        TabMount::Root => book.roots.clone(),
        TabMount::Book => book.book_entries(),
        TabMount::Entry { entry } => book.levels.get(entry).map_or_else(Vec::new, |level| {
            level
                .children
                .iter()
                .chain(
                    level
                        .members
                        .iter()
                        .filter(|id| !level.children.contains(id)),
                )
                .cloned()
                .collect()
        }),
        TabMount::View { .. } => Vec::new(),
    }
}
