//! The single-line input under GPUI's test platform: the owner never hears
//! about half-composed text, Enter while composing is the input method's,
//! and losing focus (or the window) discards the composition here and in the
//! system input method.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use dr_ui::input::{FieldEvent, TextField};
use gpui::{
    AppContext as _, Context, Entity, EntityInputHandler, Focusable as _, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, Styled as _, TestAppContext, Window, div,
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
fn secure_field_masks_paint_and_ime_and_never_copies_the_secret(cx: &mut TestAppContext) {
    cx.update(|cx| cx.bind_keys(dr_ui::input::field::bindings()));
    let (host, cx) = cx.add_window_view(|window, cx| {
        let mut host = Host::new(window, cx);
        host.field = cx.new(|cx| {
            TextField::new("credential", window, cx)
                .secure(true)
                .with_text("synthetic-密🔑")
        });
        host
    });
    let field = host.read_with(cx, |host, _| host.field.clone());
    cx.update(|window, cx| {
        window.focus(&field.focus_handle(cx), cx);
        cx.write_to_clipboard(gpui::ClipboardItem::new_string("unchanged".into()));
    });
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let length = "synthetic-密🔑".encode_utf16().count();
    assert_eq!(
        field.read_with(cx, |field, _| field.display_text()),
        "•".repeat(length)
    );
    cx.update(|window, cx| {
        field.update(cx, |field, cx| {
            let mut actual = None;
            assert_eq!(
                field.text_for_range(0..length, &mut actual, window, cx),
                Some("•".repeat(length))
            );
            assert_eq!(actual, Some(0..length));
            field.select_all_text(cx);
        })
    });
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-c cmd-x"
    } else {
        "ctrl-c ctrl-x"
    });
    assert_eq!(
        field.read_with(cx, |field, _| field.text()),
        "synthetic-密🔑"
    );
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
        Some("unchanged".into())
    );
    assert!(
        !format!("{:?}", FieldEvent::Submitted("synthetic-secret".into()))
            .contains("synthetic-secret")
    );
    cx.update(|window, cx| {
        field.update(cx, |field, cx| {
            field.replace_and_mark_text_in_range(None, "秘密", Some(2..2), window, cx);
            let mut actual = None;
            assert_eq!(
                field.text_for_range(0..2, &mut actual, window, cx),
                Some("••".into())
            );
        })
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
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

/// Counts the field's calls to the system input method.
fn count_discards(cx: &mut TestAppContext) -> Rc<Cell<usize>> {
    let calls = Rc::new(Cell::new(0));
    let seen = calls.clone();
    cx.update(|cx| dr_ui::input::set_discard_marked_text(cx, move |_| seen.set(seen.get() + 1)));
    calls
}

#[gpui::test]
fn losing_focus_discards_the_composition(cx: &mut TestAppContext) {
    let discards = count_discards(cx);
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
    // Leaving with nothing marked asks the system for nothing.
    cx.update(|window, cx| window.blur(cx));
    frame(cx);
    assert_eq!(discards.get(), 0);
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
    assert_eq!(field.read_with(cx, |f, _| f.text()), "林");
    assert_eq!(
        field.read_with(cx, |f, _| f.composer().text().to_string()),
        "林"
    );
    assert_eq!(discards.get(), 1, "the system input method is told once");
    // The window still routes the input method here until the next frame;
    // a late commit of the pinyin is not taken.
    cx.update(|window, cx| {
        field.update(cx, |f, cx| {
            f.replace_text_in_range(None, "wu gang", window, cx)
        })
    });
    assert_eq!(field.read_with(cx, |f, _| f.text()), "林");
    let seen = events.borrow();
    assert!(
        !seen.iter().any(|e| matches!(e, FieldEvent::Changed(_))),
        "{seen:?}"
    );
    assert_eq!(
        seen.iter().filter(|e| **e == FieldEvent::Blurred).count(),
        2
    );
}

#[gpui::test]
fn switching_apps_discards_the_composition(cx: &mut TestAppContext) {
    let discards = count_discards(cx);
    let (host, cx) = cx.add_window_view(Host::new);
    let (field, events) = host.read_with(cx, |h, _| (h.field.clone(), h.events.clone()));
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
    assert_eq!(field.read_with(cx, |f, _| f.text()), "林");
    assert_eq!(discards.get(), 1, "once, though the window also blurs it");
    let seen = events.borrow();
    assert!(
        !seen.iter().any(|e| matches!(e, FieldEvent::Changed(_))),
        "{seen:?}"
    );
}

/// A bare field and a framed one, in a 34px title's type.
struct Titles {
    bare: Entity<TextField>,
    framed: Entity<TextField>,
}

impl Render for Titles {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .text_size(gpui::px(34.0))
            .line_height(gpui::px(44.0))
            .child(
                div()
                    .debug_selector(|| "bare".into())
                    .child(self.bare.clone()),
            )
            .child(
                div()
                    .debug_selector(|| "framed".into())
                    .child(self.framed.clone()),
            )
    }
}

#[gpui::test]
fn a_bare_field_takes_the_type_around_it(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|window, cx| Titles {
        bare: cx.new(|cx| {
            TextField::new("bare", window, cx)
                .bare()
                .with_text("雾港纪事")
        }),
        framed: cx.new(|cx| TextField::new("framed", window, cx).with_text("雾港纪事")),
    });
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let bare = cx.debug_bounds("bare").expect("drawn");
    let framed = cx.debug_bounds("framed").expect("drawn");
    // The title's own row, no frame or padding; the framed one keeps the
    // control's height and the interface's size.
    assert_eq!(f32::from(bare.size.height), 44.0);
    assert!(f32::from(framed.size.height) < 44.0, "{framed:?}");
}
