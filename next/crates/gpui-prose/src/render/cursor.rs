//! The caret, drawn over the editor. It owns the blink timer and notifies only
//! itself, so the paragraphs (a cached view) are replayed, not rebuilt: a blink
//! repaints a 2 px quad instead of every paragraph.

use std::{cell::Cell, rc::Rc, time::Duration};

use gpui::{
    Bounds, ContentMask, Context, Hsla, IntoElement, ParentElement, Pixels, Render, Styled, Task,
    Window, canvas, div, fill,
};

pub struct CursorLayer {
    pub(crate) rect: Rc<Cell<Option<Bounds<Pixels>>>>,
    pub(crate) color: Hsla,
    pub(crate) blink: Option<Duration>,
    visible: bool,
    epoch: u64,
    _task: Option<Task<()>>,
}

impl CursorLayer {
    /// Changes the caret colour (a new theme).
    pub fn set_color(&mut self, color: Hsla, cx: &mut Context<Self>) {
        self.color = color;
        cx.notify();
    }

    pub(crate) fn new(
        rect: Rc<Cell<Option<Bounds<Pixels>>>>,
        color: Hsla,
        blink: Option<Duration>,
    ) -> CursorLayer {
        CursorLayer {
            rect,
            color,
            blink,
            visible: false,
            epoch: 0,
            _task: None,
        }
    }

    /// Shows the caret and restarts the blink.
    pub(crate) fn restart(&mut self, cx: &mut Context<Self>) {
        self.visible = true;
        self.epoch += 1;
        let epoch = self.epoch;
        self._task = self.blink.map(|interval| {
            cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(interval).await;
                    let alive = this
                        .update(cx, |this, cx| {
                            if this.epoch != epoch {
                                return false;
                            }
                            this.visible = !this.visible;
                            cx.notify();
                            true
                        })
                        .unwrap_or(false);
                    if !alive {
                        break;
                    }
                }
            })
        });
        cx.notify();
    }

    /// Changes the blink half-period (`None`: a solid caret) and restarts.
    pub fn set_blink(&mut self, blink: Option<Duration>, cx: &mut Context<Self>) {
        self.blink = blink;
        self.restart(cx);
    }

    /// Hides the caret (the editor lost focus).
    pub(crate) fn stop(&mut self, cx: &mut Context<Self>) {
        self.epoch += 1;
        self._task = None;
        self.visible = false;
        cx.notify();
    }
}

impl Render for CursorLayer {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let (rect, color, visible) = (self.rect.clone(), self.color, self.visible);
        div().absolute().top_0().left_0().size_full().child(
            canvas(
                |_, _, _| {},
                move |bounds, _, window, _| {
                    if let (true, Some(caret)) = (visible, rect.get()) {
                        window.with_content_mask(Some(ContentMask { bounds }), |window| {
                            window.paint_quad(fill(caret, color));
                        });
                    }
                },
            )
            .size_full(),
        )
    }
}
