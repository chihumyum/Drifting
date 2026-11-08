//! The page turn tells each page the opacity it is drawn under: the page
//! coming in from 0 up to 1 while it turns, the one underneath whole, and 1
//! again once the turn is over (a cached view inside draws afresh then).

use std::{
    cell::RefCell,
    rc::Rc,
    time::{Duration, Instant},
};

use dr_ui::{anim, tokens::motion, transitions::PageTurn};
use gpui::{
    Context, IntoElement, ParentElement as _, Render, SharedString, Styled as _, TestAppContext,
    VisualTestContext, Window, div,
};

type Seen = Rc<RefCell<Vec<(String, f32)>>>;

struct Host {
    page: &'static str,
    seen: Seen,
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let seen = self.seen.clone();
        div().size_full().child(PageTurn::with_level(
            "turn",
            self.page,
            move |key: &SharedString, level, _, _| {
                seen.borrow_mut().push((key.to_string(), level));
                div().size_full().child(key.clone()).into_any_element()
            },
        ))
    }
}

fn frame(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

/// What the pages were told since the last look (a frame may be drawn
/// more than once; the same pairs come again then).
fn last(seen: &Seen) -> Vec<(String, f32)> {
    let mut out = std::mem::take(&mut *seen.borrow_mut());
    let mut unique = Vec::new();
    for pair in out.drain(..) {
        if !unique.contains(&pair) {
            unique.push(pair);
        }
    }
    unique
}

#[gpui::test]
fn the_turn_tells_each_page_its_level(cx: &mut TestAppContext) {
    let seen: Seen = Rc::default();
    let s = seen.clone();
    let (view, cx) = cx.add_window_view(move |_, _| Host {
        page: "一",
        seen: s,
    });
    anim::freeze(Some(Instant::now()));
    last(&seen);
    frame(cx);
    assert_eq!(last(&seen), [("一".to_owned(), 1.0)]);
    // Turned: the old page whole underneath, the new one coming in from 0.
    view.update(cx, |h, cx| {
        h.page = "二";
        cx.notify();
    });
    frame(cx);
    assert_eq!(
        last(&seen),
        [("一".to_owned(), 1.0), ("二".to_owned(), 0.0)]
    );
    // Half way through, the new page is part way in.
    let half = motion::PAGE_BLEND.duration / 2;
    anim::freeze(Some(anim::now() + half));
    frame(cx);
    let mid = last(&seen);
    assert_eq!(mid[0], ("一".to_owned(), 1.0));
    assert!(
        mid[1].0 == "二" && mid[1].1 > 0.0 && mid[1].1 < 1.0,
        "{mid:?}"
    );
    // Over: the new page alone, at 1.
    anim::freeze(Some(anim::now() + half + Duration::from_millis(20)));
    frame(cx);
    frame(cx);
    assert_eq!(last(&seen).last(), Some(&("二".to_owned(), 1.0)));
    frame(cx);
    assert!(last(&seen).iter().all(|(k, l)| k == "二" && *l == 1.0));
    anim::freeze(None);
}
