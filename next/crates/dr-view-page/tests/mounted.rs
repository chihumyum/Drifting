//! The real G1 makers, rather than shell mock renderers, expose current editors.
use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace,
    nav::{Open, Target},
};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{Entity, Focusable as _, TestAppContext, VisualTestContext};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
fn call(lib: &Library, name: &str, input: Value) -> Value {
    lib.call(&Actor::User, name, input).unwrap()["output"].clone()
}
fn fixture() -> (tempfile::TempDir, Library, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let store = dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let lib = Library::open_dir(dir.path(), "test").unwrap();
    let entries = call(&lib, "entry.list", json!({"book":book,"all":true}));
    let entry = entries
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == "tpl-chapter")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &lib,
        "entry_template.put_module",
        json!({"book":book,"template":"tpl-chapter","module":{"id":"second","name":"Second","kind":"prose"}}),
    );
    call(
        &lib,
        "module.set_prose",
        json!({"book":book,"owner":entry,"module":"second","paragraphs":[{"text":"Synthetic selected module"},{"text":"Synthetic last block"}]}),
    );
    (dir, lib, book, entry)
}
fn target(entry: &str, module: Option<&str>) -> Target {
    Target::Entry {
        id: entry.parse().unwrap(),
        module: module.map(|m| m.parse().unwrap()),
    }
}
fn wait(cx: &mut VisualTestContext, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        cx.run_until_parked();
        cx.update(|w, cx| {
            w.simulate_next_frame(cx);
            w.draw(cx).clear(cx);
        });
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "real G1 maker did not settle");
        std::thread::sleep(Duration::from_millis(3));
    }
}
fn setup<'a>(
    cx: &'a mut TestAppContext,
    lib: &Library,
    book: &str,
) -> (Entity<Workspace>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "test",
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(dr_ui::Appearance::Light),
            },
            Services {
                library: Some(lib.clone()),
                book: Some(book.into()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_page::init(cx);
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.update(|w, _| w.activate_window());
    wait(cx, |cx| view.read_with(cx, |w, _| w.book.v3().is_some()));
    (view, cx)
}
fn open(
    view: &Entity<Workspace>,
    cx: &mut VisualTestContext,
    t: &Target,
) -> Entity<dr_editor::ChapterEditor> {
    view.update(cx, |w, cx| w.open(t.clone(), Open::KEEP, cx));
    wait(cx, |cx| view.read_with(cx, |w, _| w.editor_of(t).is_some()));
    view.read_with(cx, |w, _| w.editor_of(t).unwrap().clone())
}
#[gpui::test]
fn actual_body_makers_isolate_tabs_and_drive_find_selection_comment_save(cx: &mut TestAppContext) {
    let (_dir, lib, book, entry) = fixture();
    let (view, cx) = setup(cx, &lib, &book);
    let combined = target(&entry, None);
    let exact = target(&entry, Some("mod-prose"));
    let first = open(&view, cx, &combined);
    let second = open(&view, cx, &exact);
    assert_ne!(first.entity_id(), second.entity_id());
    assert_eq!(
        first.read_with(cx, |e, _| e.doc_id().to_owned()),
        second.read_with(cx, |e, _| e.doc_id().to_owned())
    );
    let module = target(&entry, Some("second"));
    let actual = open(&view, cx, &module);
    actual.update_in(cx, |e, w, cx| {
        let p = e.editor().clone();
        p.update(cx, |p, cx| {
            p.focus_handle(cx).focus(w, cx);
            p.select(0, 0..9, w, cx);
        });
    });
    view.update_in(cx, |w, window, cx| w.open_find(window, cx));
    let find = view.read_with(cx, |w, _| w.find.clone().unwrap());
    assert_eq!(
        find.read_with(cx, |f, _| f.prose.entity_id()),
        actual.read_with(cx, |e, _| e.editor().entity_id())
    );
    view.update_in(cx, |w, window, cx| w.close_find(window, cx));
    cx.simulate_keystrokes("secondary-alt-m");
    wait(cx, |cx| view.read_with(cx, |w, _| w.composer.is_some()));
    let composer = view.read_with(cx, |w, _| w.composer.as_ref().unwrap().view().clone());
    composer.update(cx, |c, cx| {
        c.set_text("Synthetic saved comment", cx);
        c.save(cx);
    });
    wait(cx, |cx| view.read_with(cx, |w, _| w.composer.is_none()));
    let comments = dr_editor::v3::read(&lib, &book, |v| v.comments()).unwrap();
    assert!(comments.iter().any(|c| {
        c.target_module
            .as_ref()
            .is_some_and(|m| m.as_str() == "second")
            && c.quote.as_deref() == Some("Synthetic")
            && c.body == "Synthetic saved comment"
    }));
    view.update(cx, |w, cx| {
        w.nav.close_active();
        cx.notify();
    });
    wait(cx, |cx| {
        view.read_with(cx, |w, _| w.editor_of(&module).is_none())
    });
    assert_eq!(
        view.read_with(cx, |w, _| w.editor_of(&exact).unwrap().entity_id()),
        second.entity_id()
    );
}
#[gpui::test]
fn actual_whole_book_registry_tracks_reload_focus_and_new_find(cx: &mut TestAppContext) {
    let (_dir, lib, book, _entry) = fixture();
    let (view, cx) = setup(cx, &lib, &book);
    view.update(cx, |w, cx| w.open(Target::Book, Open::KEEP, cx));
    wait(cx, |cx| {
        view.read_with(cx, |w, _| w.book_editor().is_some())
    });
    let whole = view.read_with(cx, |w, _| w.book_editor().unwrap().clone());
    let old = whole.read_with(cx, |w, _| w.editor().entity_id());
    view.update_in(cx, |w, window, cx| w.open_find(window, cx));
    let first = whole.read_with(cx, |w, cx| {
        w.editor().read(cx).book().chapters[0]
            .doc
            .source_as::<dr_editor::SessionSource>()
            .unwrap()
            .doc_id()
            .to_owned()
    });
    let owner = dr_editor::v3::body(&first).unwrap().0;
    let parent = call(&lib, "entry.get", json!({"book":book,"id":owner}))["parent"].clone();
    let manuscript = call(&lib, "entry.get", json!({"book":book,"id":parent}))["parent"].clone();
    call(
        &lib,
        "entry.move",
        json!({"book":book,"id":owner,"parent":manuscript,"index":2}),
    );
    wait(cx, |cx| {
        whole.read_with(cx, |w, _| w.editor().entity_id() != old)
    });
    // F6's published reload contract closes the old find panel and hands
    // focus back through the renderer, then a new find binds the current prose.
    wait(cx, |cx| view.read_with(cx, |w, _| w.find.is_none()));
    wait(cx, |cx| {
        cx.update(|w, cx| whole.read(cx).editor().focus_handle(cx).is_focused(w))
    });
    view.update_in(cx, |w, window, cx| w.open_find(window, cx));
    assert_eq!(
        view.read_with(cx, |w, cx| w
            .find
            .as_ref()
            .unwrap()
            .read(cx)
            .prose
            .entity_id()),
        whole.read_with(cx, |w, _| w.editor().entity_id())
    );
    assert_eq!(
        view.read_with(cx, |w, _| w.book_editor().unwrap().entity_id()),
        whole.entity_id()
    );
}
#[gpui::test]
fn versioned_module_click_reveals_block_range(cx: &mut TestAppContext) {
    let (_dir, lib, book, entry) = fixture();
    let (view, cx) = setup(cx, &lib, &book);
    let first = open(&view, cx, &target(&entry, Some("mod-prose")));
    let paragraphs = call(
        &lib,
        "prose.read",
        json!({"doc":format!("body:{entry}/second")}),
    )["paragraphs"]
        .clone();
    let link = dr_model::v3::EntityLinkV3 {
        target: entry.clone(),
        kind: dr_model::kind::EntityKind::Entry,
        module: Some("second".parse().unwrap()),
        block: Some(paragraphs[0]["block_id"].as_str().unwrap().parse().unwrap()),
        end_block: Some(paragraphs[1]["block_id"].as_str().unwrap().parse().unwrap()),
    };
    let assist = first.read_with(cx, |e, _| e.assist().clone());
    assist.update(cx, |a, cx| a.open_entity_link_v3(link.clone(), cx));
    let exact = target(&entry, Some("second"));
    wait(cx, |cx| {
        view.read_with(cx, |w, _| {
            w.nav.current() == Some(&exact) && w.editor_of(&exact).is_some()
        })
    });
    wait(cx, |cx| {
        view.read_with(cx, |w, cx| {
            !w.editor_of(&exact)
                .unwrap()
                .read(cx)
                .editor()
                .read(cx)
                .selection()
                .is_empty()
        })
    });
    let other = call(
        &lib,
        "project.create",
        json!({"name":"Synthetic other book"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assist.update(cx, |a, cx| a.open_entity_link_v3(link, cx));
    view.update_in(cx, |w, window, cx| w.open_book(&other, window, cx));
    wait(cx, |cx| {
        view.read_with(cx, |w, _| w.book_id == other && w.book.v3().is_some())
    });
    assert_ne!(
        view.read_with(cx, |w, _| w.nav.current().cloned()),
        Some(exact)
    );
}

#[gpui::test]
fn failed_final_checkpoint_retains_real_head_input_and_resumes_typing(cx: &mut TestAppContext) {
    use futures::FutureExt as _;
    use gpui::EntityInputHandler as _;
    use std::{cell::RefCell, rc::Rc};
    let (_dir, lib, book, entry) = fixture();
    let (view, cx) = setup(cx, &lib, &book);
    let exact = target(&entry, Some("mod-prose"));
    open(&view, cx, &exact);
    let doc = format!("body:{entry}/mod-prose");
    wait(cx, |cx| {
        cx.update(|_, cx| dr_view_page::page_views(&doc, cx).is_some())
    });
    let head = cx.update(|_, cx| dr_view_page::page_views(&doc, cx).unwrap().0);
    let input = head.read_with(cx, |h, _| h.title().clone());
    input.update_in(cx, |f, w, cx| {
        f.focus_handle(cx).focus(w, cx);
        f.select_all_text(cx);
        f.replace_text_in_range(None, "Accepted final head", w, cx);
    });
    let (send, recv) = futures::channel::oneshot::channel();
    let mut recv = Some(recv);
    let target = dr_workspace::commands::v3::snapshots::EntryIn {
        book: book.clone(),
        entry: entry.clone(),
    };
    let t = target.clone();
    let outcome = Rc::new(RefCell::new(None));
    let seen = outcome.clone();
    cx.update(|_,cx| {
        dr_shell::release::before_release(cx,move |cx| {
            let wait=recv.take().unwrap();let lib=cx.global::<Services>().library.clone().unwrap();let t=t.clone();
            async move {
                wait.await.unwrap();
                lib.call(&Actor::User,"module.set_prose",json!({"book":t.book,"owner":t.entry,"module":"mod-prose","paragraphs":[{"text":"last producer after G1 baseline"}]})).map_err(|e|e.to_string())?;
                lib.library().local_transaction(|tx| {tx.execute_batch("CREATE TRIGGER mounted_final_fault BEFORE INSERT ON loro_update WHEN NEW.doc_id LIKE 'book:%' BEGIN SELECT RAISE(ABORT,'mounted final fault'); END;")?;Ok(())}).map_err(|e|e.to_string())?;
                Ok(())
            }.boxed_local()
        });
        dr_shell::library::replace(cx,|_,_|panic!("a failed final point must keep the mounted page"),move |r,_|*seen.borrow_mut()=Some(r));
    });
    wait(cx, |_| {
        lib.run::<dr_workspace::commands::v3::snapshots::List>(&Actor::User, target.clone())
            .unwrap()
            .output
            .iter()
            .any(|p| p.reason == "close")
            && call(&lib, "entry.get", json!({"book":book,"id":entry}))["title"]
                == "Accepted final head"
    });
    send.send(()).unwrap();
    wait(cx, |cx| {
        cx.executor().advance_clock(Duration::from_millis(10));
        outcome.borrow().is_some()
    });
    assert!(
        outcome
            .borrow()
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap_err()
            .contains("mounted final fault")
    );
    assert_eq!(input.read_with(cx, |f, _| f.text()), "Accepted final head");
    assert!(view.read_with(cx, |w, _| w.editor_of(&exact).is_some()));
    cx.update(|_, cx| assert!(!dr_shell::release::is_releasing(cx)));
    lib.library()
        .local_transaction(|tx| {
            tx.execute_batch("DROP TRIGGER mounted_final_fault")?;
            Ok(())
        })
        .unwrap();
    input.update_in(cx, |f, w, cx| {
        f.focus_handle(cx).focus(w, cx);
        f.select_all_text(cx);
        f.replace_text_in_range(None, "Retry input enabled", w, cx);
    });
    assert_eq!(input.read_with(cx, |f, _| f.text()), "Retry input enabled");
}
