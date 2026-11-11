//! M23: Review & Materials Super View (`SuperView::ReviewMaterials`) on canonical v3.
//!
//! Hosts two independently resizable review rails (TODOs and Comments, rendered
//! and mutated through [`dr_view_review::ReviewView`]), a right-hand Material
//! shelf reusing [`dr_view_material::card::MaterialCard`], kind chips and
//! [`dr_view_material::v3`] entry-relation filters, and a collapsible bottom
//! drawer for unsorted (unlinked) materials and resolved review items.

pub mod dialogs;
pub mod drawer;
pub mod model;
pub mod shelf;
pub mod view;

use futures::FutureExt as _;
use gpui::{App, AppContext as _, Global, WeakEntity};

pub use model::{MEMORY_KEY, Rail, ShelfCounts, ShelfMemory};
pub use view::{ShelfReviewHeadEnd, ShelfReviewHeadStart, ShelfReviewView};

#[derive(Default)]
pub(crate) struct Registry {
    pub(crate) frozen: bool,
    pub(crate) views: Vec<WeakEntity<ShelfReviewView>>,
}

impl Global for Registry {}

pub(crate) fn is_frozen(cx: &App) -> bool {
    cx.try_global::<Registry>().is_some_and(|r| r.frozen) || dr_shell::release::is_releasing(cx)
}

/// Registers `SuperView::ReviewMaterials` and library-release barriers.
pub fn init(cx: &mut App) {
    if !cx.has_global::<Registry>() {
        cx.set_global(Registry::default());
    }

    dr_shell::release::before_release(cx, |cx| {
        let views = {
            let reg = cx.default_global::<Registry>();
            reg.frozen = true;
            reg.views.retain(|v| v.upgrade().is_some());
            reg.views.clone()
        };
        let app = cx.to_async();
        async move {
            let (own_waiters, review_drains) = app.update(|cx| {
                let mut own = Vec::new();
                let mut drains = Vec::new();
                for weak in &views {
                    if let Some(view) = weak.upgrade() {
                        let (w, d) = view.update(cx, |v, cx| v.prepare_release(cx));
                        own.extend(w);
                        if let Some(d) = d {
                            drains.push(d);
                        }
                    }
                }
                (own, drains)
            });
            for rx in own_waiters {
                let _ = rx.await;
            }
            for drain in review_drains {
                drain.await;
            }
            app.update(|cx| {
                for weak in &views {
                    if let Some(view) = weak.upgrade() {
                        view.update(cx, |v, cx| v.drop_library_handles(cx));
                    }
                }
                dr_view_material::previews::forget(cx);
            });
            Ok(())
        }
        .boxed_local()
    });

    dr_shell::release::after_release(cx, |cx| {
        let next_lib = cx
            .try_global::<dr_shell::Services>()
            .and_then(|s| s.library.clone());
        let views = {
            let reg = cx.default_global::<Registry>();
            reg.frozen = false;
            reg.views.retain(|v| v.upgrade().is_some());
            reg.views.clone()
        };
        for weak in views {
            if let Some(view) = weak.upgrade() {
                view.update(cx, |v, cx| v.rebind_library(next_lib.clone(), cx));
            }
        }
    });

    dr_shell::pages::add_super_view(
        cx,
        dr_shell::workspace::SuperView::ReviewMaterials,
        |host, window, cx| {
            let view = cx.new(|cx| ShelfReviewView::new(host, window, cx));
            let head_start = cx.new(|cx| ShelfReviewHeadStart::new(&view, cx));
            let head_end = cx.new(|cx| ShelfReviewHeadEnd::new(&view, window, cx));
            dr_shell::pages::SuperViewPage::new(view)
                .head_start(head_start)
                .head_end(head_end)
        },
    );
}
