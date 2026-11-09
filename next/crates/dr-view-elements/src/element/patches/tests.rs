use super::Patches;
use crate::fields::guarded::tests::{Fixture, draw, pair, wait};
use gpui::{EntityInputHandler, Focusable, TestAppContext, VisualTestContext, px, size};
use serde_json::json;

fn edit_case(cx: &mut TestAppContext, body: bool, conflict: bool) {
    cx.executor().allow_parking();
    let f = Fixture::new("patches");
    f.put_patch(pair("old title", "old body"));
    let host = f.host(cx);
    let window = cx.add_window(|w, cx| Patches::new(host, w, cx));
    let view = window.root(cx).unwrap();
    let mut cx = VisualTestContext::from_window(window.into(), cx);
    cx.update(|w, _| w.activate_window());
    cx.simulate_resize(size(px(1000.), px(800.)));
    wait(&mut cx, |cx| {
        view.read_with(cx, |v, _| v.rows.contains_key("g1-record"))
    });
    let field = view.read_with(&cx, |v, _| {
        if body {
            v.rows["g1-record"].body.clone()
        } else {
            v.rows["g1-record"].title.clone()
        }
    });
    field.update_in(&mut cx, |f, w, cx| {
        f.focus_handle(cx).focus(w, cx);
        f.select_all_text(cx);
        f.replace_text_in_range(None, "author draft", w, cx);
    });
    draw(&mut cx);
    let remote = if body != conflict {
        pair("external title", "old body")
    } else {
        pair("old title", "external body")
    };
    f.put_patch(remote.clone());
    view.update(&mut cx, |v, cx| v.reload(cx));
    wait(&mut cx, |cx| view.read_with(cx, |v, _| !v.reading));
    assert_eq!(field.read_with(&cx, |f, _| f.text()), "author draft");
    cx.update(|w, cx| w.blur(cx));
    if conflict {
        wait(&mut cx, |cx| {
            view.read_with(cx, |v, _| v.rows["g1-record"].error)
        });
        assert_eq!(f.pair(true), remote);
        assert!(view.read_with(&cx, |v, _| v.rows["g1-record"].dirty));
        field.update_in(&mut cx, |f, w, cx| {
            f.focus_handle(cx).focus(w, cx);
            f.select_all_text(cx);
            f.replace_text_in_range(None, "revised draft", w, cx);
        });
        cx.update(|w, cx| w.blur(cx));
        draw(&mut cx);
        assert_eq!(f.pair(true), remote, "blur must not retry a refused draft");
        f.put_patch(pair("latest external title", "latest external body"));
        view.update(&mut cx, |v, cx| v.reload(cx));
        wait(&mut cx, |cx| view.read_with(cx, |v, _| !v.reading));
        assert_eq!(field.read_with(&cx, |f, _| f.text()), "revised draft");
        view.update(&mut cx, |v, cx| v.save_draft("g1-record", true, cx));
    }
    wait(&mut cx, |cx| {
        view.read_with(cx, |v, _| {
            !v.rows["g1-record"].writing && !v.rows["g1-record"].dirty
        })
    });
    assert!(!view.read_with(&cx, |v, _| v.rows["g1-record"].error));
    assert_eq!(
        f.pair(true),
        match (body, conflict) {
            (false, false) => pair("author draft", "external body"),
            (true, false) => pair("external title", "author draft"),
            (false, true) => pair("revised draft", "latest external body"),
            (true, true) => pair("latest external title", "revised draft"),
        }
    );
}
#[gpui::test]
fn editing_title_keeps_the_external_body(cx: &mut TestAppContext) {
    edit_case(cx, false, false);
}
#[gpui::test]
fn editing_body_keeps_the_external_title(cx: &mut TestAppContext) {
    edit_case(cx, true, false);
}
#[gpui::test]
fn conflicting_title_keeps_the_draft_until_explicit_retry(cx: &mut TestAppContext) {
    edit_case(cx, false, true);
}
#[gpui::test]
fn conflicting_body_keeps_the_draft_until_explicit_retry(cx: &mut TestAppContext) {
    edit_case(cx, true, true);
}

#[gpui::test]
fn a_removed_patch_keeps_its_refused_draft_and_is_never_recreated(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let f = Fixture::new("patches");
    f.put_patch(pair("old title", "old body"));
    let host = f.host(cx);
    let window = cx.add_window(|w, cx| Patches::new(host, w, cx));
    let view = window.root(cx).unwrap();
    let mut cx = VisualTestContext::from_window(window.into(), cx);
    cx.update(|w, _| w.activate_window());
    wait(&mut cx, |cx| {
        view.read_with(cx, |v, _| v.rows.contains_key("g1-record"))
    });
    let field = view.read_with(&cx, |v, _| v.rows["g1-record"].title.clone());
    field.update_in(&mut cx, |f, w, cx| {
        f.focus_handle(cx).focus(w, cx);
        f.replace_text_in_range(None, " draft", w, cx);
    });
    draw(&mut cx);
    f.call("module.remove_patch", json!({"id":"g1-record"}));
    view.update(&mut cx, |v, cx| v.reload(cx));
    wait(&mut cx, |cx| view.read_with(cx, |v, _| !v.reading));
    cx.update(|w, cx| w.blur(cx));
    wait(&mut cx, |cx| {
        view.read_with(cx, |v, _| v.rows["g1-record"].error)
    });
    let text = field.read_with(&cx, |f, _| f.text());
    view.update(&mut cx, |v, cx| v.save_draft("g1-record", true, cx));
    wait(&mut cx, |cx| {
        view.read_with(cx, |v, _| !v.rows["g1-record"].writing)
    });
    assert_eq!(field.read_with(&cx, |f, _| f.text()), text);
    assert!(view.read_with(&cx, |v, _| v.rows["g1-record"].error
        && v.rows["g1-record"].dirty));
    assert!(
        f.call("module.read", json!({}))["patches"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[gpui::test]
fn adding_a_patch_finishes_the_focused_draft_before_changing_the_book(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let f = Fixture::new("patches");
    f.put_patch(pair("old title", "old body"));
    let host = f.host(cx);
    let window = cx.add_window(|w, cx| Patches::new(host, w, cx));
    let view = window.root(cx).unwrap();
    let mut cx = VisualTestContext::from_window(window.into(), cx);
    cx.update(|w, _| w.activate_window());
    wait(&mut cx, |cx| {
        view.read_with(cx, |v, _| v.rows.contains_key("g1-record"))
    });
    let body = view.read_with(&cx, |v, _| v.rows["g1-record"].body.clone());
    body.update_in(&mut cx, |f, w, cx| {
        f.focus_handle(cx).focus(w, cx);
        f.select_all_text(cx);
        f.replace_text_in_range(None, "body before adding", w, cx);
    });
    draw(&mut cx);
    // Cover both the click handler and its blur arriving in the same turn,
    // plus repeated clicks while the first creation is still pending.
    view.update(&mut cx, |v, cx| {
        v.add(cx);
        v.add(cx);
    });
    cx.update(|w, cx| w.blur(cx));
    wait(&mut cx, |cx| {
        view.read_with(cx, |v, _| v.records.len() == 3 && !v.adding && !v.reading)
    });
    assert_eq!(f.pair(true), pair("old title", "body before adding"));
    assert!(view.read_with(&cx, |v, _| !v.rows["g1-record"].error
        && !v.rows["g1-record"].dirty));
}
