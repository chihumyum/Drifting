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
//!
//! A cell can also lead with its own element (a disclosure and an icon, a
//! thumbnail: [`SandCell::lead`]) and carry a quieter second line under
//! its name ([`SandCell::subline`]: a material's kind or first words); with a
//! second line the row grows to fit it.

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
    icon: Option<sand::Icon>,
    dense: bool,
    hollow: bool,
    color: Option<Rgb>,
    selected: bool,
    disabled: bool,
    font: Role,
    italic: bool,
    children: SmallVec<[AnyElement; 2]>,
    lead: Option<AnyElement>,
    sub: Option<SharedString>,
    on_click: Option<OnClick>,
}

impl SandCell {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> SandCell {
        SandCell {
            id: id.into(),
            label: label.into(),
            mark: None,
            icon: None,
            dense: false,
            hollow: false,
            color: None,
            selected: false,
            disabled: false,
            font: Role::Ui,
            italic: false,
            children: SmallVec::new(),
            lead: None,
            sub: None,
            on_click: None,
        }
    }

    /// The kind mark before the name.
    pub fn mark(mut self, kind: sand::Kind) -> Self {
        self.mark = Some(kind);
        self
    }

    /// The mark drawn hollow (a chapter not yet begun).
    /// A brush icon where the mark goes (an action, not a thing): the
    /// chapter end's 「标为完成」, 「新建下一章」.
    pub fn icon(mut self, icon: sand::Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    /// The short row of a small action list (the chapter end's ⁂ menu,
    /// `.chapter-end-menu__item`): 22px, the index face, ink 3, the icon
    /// 14px and 6px from the words.
    pub fn dense(mut self) -> Self {
        self.dense = true;
        self
    }

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

    /// An element before everything else in the row (before the mark).
    pub fn lead(mut self, lead: impl IntoElement) -> Self {
        self.lead = Some(lead.into_any_element());
        self
    }

    /// A second line under the name, in the index face, quieter.
    pub fn subline(mut self, sub: impl Into<SharedString>) -> Self {
        self.sub = Some(sub.into());
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
        let dense = self.dense;
        let ink = if selected {
            p.ink(1)
        } else if dense {
            p.ink(3)
        } else {
            p.ink(2)
        };
        let icon = self
            .icon
            .map(|i| sand::icon(i, if dense { 14.0 } else { 16.0 }, ink.solid()));
        let two_lines = self.sub.is_some();
        let label = div()
            // A dense row sizes to its words (a column of actions as wide
            // as its longest); a list row fills its width.
            .when(!dense, |el| el.flex_1().min_w_0().overflow_hidden())
            .whitespace_nowrap()
            .when(self.italic, |el| el.italic())
            .child(self.label.clone());
        let label = match self.sub {
            None => label.into_any_element(),
            Some(sub) => div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(label)
                .child(
                    div()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .font_role(Role::Index)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.muted().solid())
                        .child(sub),
                )
                .into_any_element(),
        };
        div()
            .id(self.id.clone())
            .relative()
            .when(!two_lines, |el| {
                el.h(px(if dense { 22.0 } else { s.row_height }))
            })
            .when(two_lines, |el| el.min_h(px(s.row_height)).py(px(5.0)))
            .px(px(if dense { 8.0 } else { 10.0 }))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(if dense { 6.0 } else { 8.0 }))
            .rounded(px(radius::SM))
            .font_role(if dense { Role::Index } else { self.font })
            .type_px(s.secondary, if dense { 18.0 } else { s.line_body })
            .text_color(ink.solid())
            .child(glass::layer(ring, spec, theme))
            .child(frame)
            .children(self.lead)
            .children(mark)
            .children(icon)
            .child(label)
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
