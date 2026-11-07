//! A list cell (components.md, 「侧栏 cell」; materials.css `.sand-cell`):
//! the sidebar's chapters, elements and storylines, a stats panel's jump
//! rows, a timeline lane's name.
//!
//! No hover wash. Under the pointer the cell's outline, all four sides,
//! becomes a hairline of flowing glass in the cell's colour (half its
//! colour, half the clear glass): one ring cut from one texture, so no side
//! is heavier than another. Selected, the ring goes and the brush leaves
//! beside the mark and goes round the cell once ([`SandFrame`]); when the
//! selection moves on the frame fades out whole. A cell has no press state.
//! A cell that opens nothing (`disabled`) never shows the ring.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, InteractiveElement, IntoElement, ParentElement,
    RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder as _, px,
};
use smallvec::SmallVec;

use crate::{
    fonts::Role,
    glass::{self, Kind, Mode, Spec, Tone},
    sand::{self, KindMark, SandFrame},
    style::{DrStyled, child_id},
    theme::Theme,
    tokens::{Rgb, radius},
};

type OnClick = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// How far the ring reaches inward (`--glass-rim` for a cell).
pub const RING_RIM: f32 = 3.0;

#[derive(IntoElement)]
pub struct SandCell {
    id: ElementId,
    label: SharedString,
    mark: Option<sand::Kind>,
    hollow: bool,
    color: Option<Rgb>,
    selected: bool,
    disabled: bool,
    font: Role,
    italic: bool,
    children: SmallVec<[AnyElement; 2]>,
    on_click: Option<OnClick>,
}

impl SandCell {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> SandCell {
        SandCell {
            id: id.into(),
            label: label.into(),
            mark: None,
            hollow: false,
            color: None,
            selected: false,
            disabled: false,
            font: Role::Ui,
            italic: false,
            children: SmallVec::new(),
            on_click: None,
        }
    }

    /// The kind mark before the name.
    pub fn mark(mut self, kind: sand::Kind) -> Self {
        self.mark = Some(kind);
        self
    }

    /// The mark drawn hollow (a chapter not yet begun).
    pub fn hollow(mut self, hollow: bool) -> Self {
        self.hollow = hollow;
        self
    }

    /// The cell's colour (its storyline's or category's): the mark, the
    /// ring and the frame take it. Without one they are the clear glass
    /// and the third ink.
    pub fn color(mut self, color: Rgb) -> Self {
        self.color = Some(color);
        self
    }

    pub fn color_opt(mut self, color: Option<Rgb>) -> Self {
        self.color = color;
        self
    }

    /// Open in the editor: the brush goes round it.
    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    /// Opens nothing (a lane with no entity): no ring, no click.
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The name's face: places (chapters, storylines) are in the structure
    /// face; things in the interface face.
    pub fn font(mut self, role: Role) -> Self {
        self.font = role;
        self
    }

    /// An italic name (a preview).
    pub fn italic(mut self, italic: bool) -> Self {
        self.italic = italic;
        self
    }

    /// Called on every click; `ClickEvent::click_count` tells a double
    /// click (keep a preview) from a single one.
    pub fn on_click(mut self, f: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(f));
        self
    }
}

/// Things after the name (a count, a trailing mark), in the row.
impl ParentElement for SandCell {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// The ring's colour: half the cell's colour, half the clear glass
/// (`--cell-line`).
pub fn ring_tone(color: Option<Rgb>, glass_clear: Rgb) -> Tone {
    color.map_or(Tone::Clear, |c| Tone::Color(c.mix(glass_clear, 0.5)))
}

impl RenderOnce for SandCell {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let selected = self.selected;
        let interactive = !self.disabled;
        // The ring: hidden glass that answers hover only, and never while
        // the cell is selected (the frame shows it then).
        let ring = glass::use_state(
            child_id(&self.id, "ring"),
            Kind::Hidden,
            Mode::default(),
            false,
            theme,
            window,
            cx,
        );
        let pointer = window.use_keyed_state(child_id(&self.id, "pointer"), cx, |_, _| false);
        let over = *pointer.read(cx) && interactive && !selected;
        ring.update(cx, |r, _| {
            r.set_hover(over);
            r.set_pressed(false);
        });
        let spec = Spec::new(ring_tone(self.color, p.glass_clear), radius::SM).rim(RING_RIM);
        let mark = self.mark.map(|kind| {
            let m = KindMark::new(child_id(&self.id, "mark"), kind).hollow(self.hollow);
            match self.color {
                Some(c) => m.color(c),
                None => m,
            }
        });
        let frame = SandFrame::new(child_id(&self.id, "frame"), selected && interactive);
        let frame = match self.color {
            Some(c) => frame.color(c),
            None => frame,
        };
        let ring_hover = ring.clone();
        div()
            .id(self.id.clone())
            .relative()
            .h(px(s.row_height))
            .px(px(10.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .rounded(px(radius::SM))
            .font_role(self.font)
            .type_px(s.secondary, s.line_body)
            .text_color(if selected { p.ink(1) } else { p.ink(2) }.solid())
            .child(glass::layer(ring, spec, theme))
            .child(frame)
            .children(mark)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .when(self.italic, |el| el.italic())
                    .child(self.label.clone()),
            )
            .children(self.children)
            .role(gpui::Role::ListItem)
            .aria_label(self.label)
            .aria_selected(selected)
            .on_hover(move |hovered, _, cx| {
                pointer.update(cx, |p, _| *p = *hovered);
                let show = *hovered && interactive && !selected;
                ring_hover.update(cx, |r, cx| {
                    if r.set_hover(show) {
                        cx.notify();
                    }
                });
            })
            .when(interactive && self.on_click.is_some(), |el| {
                el.cursor_pointer()
            })
            .when_some(self.on_click.filter(|_| interactive), |el, f| {
                el.on_click(move |e, w, cx| f(e, w, cx))
            })
    }
}
