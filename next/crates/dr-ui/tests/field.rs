//! The single-line input under GPUI's test platform: the owner never hears
//! about half-composed text, Enter while composing is the input method's,
//! and losing focus leaves no composition behind.

use std::{cell::RefCell, rc::Rc};

use dr_ui::input::{FieldEvent, TextField};
use gpui::{
    AppContext as _, Context, Entity, EntityInputHandler, Focusable as _, IntoElement,
    ParentElement as _, Render, Styled as _, TestAppContext, Window, div,
};

struct Host {
    field: Entity<TextField>,
    events: Rc<RefCell<Vec<FieldEvent>>>,
}

impl Host {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Host {
        let field = cx.new(|cx| TextField::new("title", window, cx).with_text("林"));
        let events = Rc::new(RefCell::new(Vec::new()));
        let sink = events.clone();
        cx.subscribe(&field, move |_, _, event: &FieldEvent, _| {
            sink.borrow_mut().push(event.clone());
        })
        .detach();
        Host { field, events }
    }
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.field.clone())
    }
}

#[gpui::test]
fn composition_is_shown_but_never_reported(cx: &mut TestAppContext) {
    cx.update(|cx| cx.bind_keys(dr_ui::input::field::bindings()));
    let (host, cx) = cx.add_window_view(Host::new);
    let (field, events) = host.read_with(cx, |h, _| (h.field.clone(), h.events.clone()));
    cx.update(|window, cx| window.focus(&field.focus_handle(cx), cx));
    cx.run_until_parked();

    cx.update(|window, cx| {
        field.update(cx, |f, cx| {
            f.replace_and_mark_text_in_range(None, "l", Some(1..1), window, cx);
            f.replace_and_mark_text_in_range(None, "lan", Some(3..3), window, cx);
        })
    });
    assert!(events.borrow().is_empty(), "{:?}", events.borrow());
    assert_eq!(field.read_with(cx, |f, _| f.text()), "林");
    assert!(field.read_with(cx, |f, _| f.is_composing()));

    // Enter chooses the candidate; it does not submit the field.
    cx.simulate_keystrokes("enter");
    assert!(events.borrow().is_empty(), "{:?}", events.borrow());

    cx.update(|window, cx| {
        field.update(cx, |f, cx| f.replace_text_in_range(None, "岚", window, cx))
    });
    assert_eq!(
        events.borrow().as_slice(),
        &[FieldEvent::Changed("林岚".into())]
    );
    cx.simulate_keystrokes("enter");
    assert_eq!(
        events.borrow().last(),
        Some(&FieldEvent::Submitted("林岚".into()))
    );
}

#[gpui::test]
fn losing_focus_commits_the_composition(cx: &mut TestAppContext) {
    let (host, cx) = cx.add_window_view(Host::new);
    let (field, events) = host.read_with(cx, |h, _| (h.field.clone(), h.events.clone()));
    // Focus listeners run when a frame sees the focus change.
    let frame = |cx: &mut gpui::VisualTestContext| {
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.run_until_parked();
    };
    cx.update(|window, _| window.activate_window());
    cx.update(|window, cx| window.focus(&field.focus_handle(cx), cx));
    frame(cx);
    cx.update(|window, cx| {
        field.update(cx, |f, cx| {
            f.replace_and_mark_text_in_range(None, "wu gang", Some(7..7), window, cx)
        })
    });
    cx.update(|window, cx| window.blur(cx));
    frame(cx);
    assert!(!field.read_with(cx, |f, _| f.is_composing()));
    assert_eq!(field.read_with(cx, |f, _| f.text()), "林wu gang");
    let seen = events.borrow();
    assert!(
        seen.contains(&FieldEvent::Changed("林wu gang".into())),
        "{seen:?}"
    );
    assert!(seen.contains(&FieldEvent::Blurred));
}

#[gpui::test]
fn switching_apps_commits_the_composition(cx: &mut TestAppContext) {
    let (host, cx) = cx.add_window_view(Host::new);
    let field = host.read_with(cx, |h, _| h.field.clone());
    cx.update(|window, _| window.activate_window());
    cx.update(|window, cx| window.focus(&field.focus_handle(cx), cx));
    cx.run_until_parked();
    cx.update(|window, cx| {
        field.update(cx, |f, cx| {
            f.replace_and_mark_text_in_range(None, "deng", None, window, cx)
        })
    });
    cx.deactivate_window();
    cx.run_until_parked();
    assert!(!field.read_with(cx, |f, _| f.is_composing()));
    assert_eq!(field.read_with(cx, |f, _| f.text()), "林deng");
}
