//! A category's or a storyline's colour, picked on its page (dr-ui's
//! [`ColorSwatch`], which opens the system's colour picker as the 0.1
//! client's `<input type="color">` did).
//!
//! The picker hands over a colour every time it changes while the author
//! drags across it. The page shows each one at once (its marks and the
//! swatch); the colour is written through F3 once the picker has been still
//! for [`SETTLE`], so one pick is one undo step (the 0.1 client wrote each
//! change; m11-elements.md, 「和旧版不一样的地方」).

use std::time::Duration;

use dr_ui::components::color::hex;
use dr_ui::tokens::Rgb;
use gpui::Task;

/// How long the picker stays still before the colour is written.
pub const SETTLE: Duration = Duration::from_millis(300);

/// The colour being picked, until the stored one is the same.
#[derive(Default)]
pub struct Picked {
    color: Option<Rgb>,
    /// Waiting for the picker to settle.
    timer: Option<Task<()>>,
}

impl Picked {
    /// A new colour from the picker; `timer` writes it after [`SETTLE`].
    pub fn pick(&mut self, color: Rgb, timer: Task<()>) {
        self.color = Some(color);
        self.timer = Some(timer);
    }

    /// The colour to write now that the picker settled, unless `stored`
    /// already is it.
    pub fn settled(&mut self, stored: Option<&str>) -> Option<String> {
        self.timer = None;
        let picked = hex(self.color?);
        (stored.map(str::to_ascii_lowercase).as_deref() != Some(picked.as_str())).then_some(picked)
    }

    /// The write failed: back to the stored colour.
    pub fn forget(&mut self) {
        self.color = None;
        self.timer = None;
    }

    /// What the page shows: the colour being picked until the stored one has
    /// caught up with it, else `stored`.
    pub fn shown(&mut self, stored_text: Option<&str>, stored: Option<Rgb>) -> Option<Rgb> {
        if let Some(color) = self.color
            && self.timer.is_none()
            && stored_text.map(str::to_ascii_lowercase) == Some(hex(color))
        {
            self.color = None;
        }
        self.color.or(stored)
    }
}
