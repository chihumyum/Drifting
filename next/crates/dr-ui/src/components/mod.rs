//! The components every view is built from (docs/design-system/components.md).

use std::rc::Rc;

use gpui::{AnyElement, App, Window};

/// Callbacks the components take.
pub type Handler = Rc<dyn Fn(&mut Window, &mut App)>;
pub type OnIndex = Rc<dyn Fn(usize, &mut Window, &mut App)>;
pub type OnToggle = Rc<dyn Fn(bool, &mut Window, &mut App)>;
pub type Build = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;

pub mod button;
pub mod cell;
pub mod choice;
pub mod color;
pub mod dock;
pub mod feedback;
pub mod hover_card;
pub mod menu;
pub mod overlay;
pub mod range;
pub mod reorder;
pub mod select;
pub mod toggles;

pub use button::{Button, IconButton, PanelIconButton, Seat, Variant};
pub use cell::SandCell;
pub use choice::{DraggedPill, Pill, PillGroup, Segmented};
pub use color::ColorSwatch;
pub use dock::{DockMark, DockTab, TabDock};
pub use feedback::{EmptyState, Loading, NotificationPill, Progress};
pub use hover_card::{CardAction, CardBody, HoverCard};
pub use menu::{Menu, MenuItem, MenuWidth, RowIcon};
pub use overlay::{Align, Dialog, Layer, Place, float, place};
pub use range::{NumberField, Range};
pub use select::{Choice, Select};
pub use toggles::{Chip, ScopeToggle, Switch};
