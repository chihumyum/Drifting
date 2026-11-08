//! The Super View stage (workspace.md; motion.md 「重冰推进」): a layer over
//! the whole window, its own header with Back and the switcher, the
//! workspace underneath unreachable. Switching between views pushes the
//! body left or right by the switcher's order; opening and closing do not
//! push. Esc closes it (after anything floating over it).
//!
//! The three views (M21 story graph, M22 element overview, M23 review and
//! materials) are the modules' ([`crate::pages::add_super_view`]): each is
//! made the first time the stage shows it for a book, its body under the
//! header, its two slots in the header (the left after 返回, the right
//! end). A view nobody registered is an empty sheet.

use dr_i18n::{Key, keys};
use dr_ui::{
    Theme,
    components::{Button, Segmented},
    glass::{self, Ground},
    sand::Icon,
    transitions::Push,
};
use gpui::{
    AnyElement, Context, InteractiveElement, IntoElement, ParentElement, SharedString, Styled,
    Window, div, px,
};

use super::Workspace;
use super::chrome::{self, LEADING_INSET, TITLEBAR_HEIGHT};
use crate::pages::{SuperViewHost, SuperViewPage};
use crate::strings::t;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SuperView {
    StoryGraph,
    Elements,
    ReviewMaterials,
}

impl SuperView {
    /// In the switcher's order.
    pub const ALL: [SuperView; 3] = [
        SuperView::StoryGraph,
        SuperView::Elements,
        SuperView::ReviewMaterials,
    ];

    pub fn label(self) -> Key {
        match self {
            SuperView::StoryGraph => keys::bottom_status_bar::STORY_GRAPH,
            SuperView::Elements => keys::bottom_status_bar::ELEMENTS,
            SuperView::ReviewMaterials => keys::bottom_status_bar::TODO_LIBRARY,
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            SuperView::StoryGraph => "story-graph",
            SuperView::Elements => "elements",
            SuperView::ReviewMaterials => "review-materials",
        }
    }

    fn index(self) -> usize {
        SuperView::ALL.iter().position(|v| *v == self).unwrap_or(0)
    }
}

impl Workspace {
    /// `view`'s content for the book shown, made when it is not yet.
    fn super_view_page(
        &self,
        view: SuperView,
        window: &mut Window,
        cx: &mut Context<Workspace>,
    ) -> Option<SuperViewPage> {
        if let Some((book, made)) = self.super_views.borrow().get(&view)
            && *book == self.book_id
        {
            return made.clone();
        }
        let host = SuperViewHost {
            workspace: cx.weak_entity(),
            library: self.library.clone(),
            book_id: self.book_id.clone(),
            book: self.book.clone(),
        };
        let made = crate::pages::super_view_for(view, &host, window, cx);
        self.super_views
            .borrow_mut()
            .insert(view, (self.book_id.clone(), made.clone()));
        made
    }

    /// The made content of `view`, if a module draws it (tests).
    pub fn super_view_content(&self, view: SuperView) -> Option<SuperViewPage> {
        self.super_views.borrow().get(&view)?.1.clone()
    }
}

pub fn stage(
    ws: &Workspace,
    view: SuperView,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let page = ws.super_view_page(view, window, cx);
    // What each view shows, for the push between two of them.
    let bodies: std::collections::HashMap<&'static str, gpui::AnyView> = SuperView::ALL
        .iter()
        .filter_map(|v| Some((v.slug(), ws.super_view_content(*v)?.body)))
        .collect();
    let (head_start, head_end) = page.map(|p| (p.head_start, p.head_end)).unwrap_or_default();
    let labels: Vec<SharedString> = SuperView::ALL.iter().map(|v| t(cx, v.label())).collect();
    let entity = cx.entity();
    let switcher =
        Segmented::new("super-view-switcher", labels, view.index()).on_change(move |i, _, cx| {
            entity.update(cx, |ws, cx| {
                ws.super_view = Some(SuperView::ALL[i]);
                cx.notify();
            })
        });
    let entity = cx.entity();
    let back = Button::new("super-view-back", t(cx, keys::navigation::BACK))
        .text()
        .small()
        .icon(Icon::ArrowBack)
        .on_click(move |_, _, cx| {
            entity.update(cx, |ws, cx| {
                ws.super_view = None;
                cx.notify();
            })
        });
    let header = chrome::drag_region(
        div()
            .id("super-view-header")
            .flex_none()
            .relative()
            .h(px(TITLEBAR_HEIGHT))
            .pl(px(LEADING_INSET))
            .pr(px(12.0))
            .border_b(px(0.5))
            .border_color(p.hairline())
            .flex()
            .flex_row()
            .items_center()
            .child(back)
            .children(head_start.map(|v| div().relative().ml(px(8.0)).child(v)))
            .child(div().flex_1())
            .children(head_end.map(|v| div().relative().child(v)))
            .child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .top_0()
                    .h_full()
                    .flex()
                    .justify_center()
                    .items_center()
                    .child(switcher),
            ),
        cx,
    );
    let body = Push::new(
        "super-view-body",
        SharedString::new_static(view.slug()),
        view.index(),
        move |key, window, cx| {
            let p = Theme::of(window, cx).palette;
            div()
                .size_full()
                .bg(p.paper.solid())
                .children(bodies.get(key.as_ref()).cloned())
                .into_any_element()
        },
    );
    glass::surface(
        Ground::flat(p.desk),
        div()
            .id("super-view")
            .absolute()
            .inset_0()
            .occlude()
            .bg(p.desk.solid())
            .flex()
            .flex_col()
            .child(header)
            .child(div().flex_1().min_h_0().child(body)),
    )
    .into_any_element()
}
