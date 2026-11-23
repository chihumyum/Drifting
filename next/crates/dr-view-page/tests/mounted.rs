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
    // One entry, one tab (`kernel-v5.md` T1): the module a target names is
    // where the page scrolls to, and its editor is the page's own.
    assert_eq!(first.entity_id(), second.entity_id());
    view.read_with(cx, |w, _| assert_eq!(w.nav.tabs().len(), 1));
    let module = target(&entry, Some("second"));
    let actual = open(&view, cx, &module);
    view.read_with(cx, |w, _| assert_eq!(w.nav.tabs().len(), 1));
    assert_ne!(
        actual.entity_id(),
        first.entity_id(),
        "each module its own editor"
    );
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
            && c.body.text == "Synthetic saved comment"
    }));
    // Closing the one tab closes the entry's page, every module of it.
    view.update(cx, |w, cx| {
        w.nav.close_active();
        cx.notify();
    });
    wait(cx, |cx| {
        view.read_with(cx, |w, _| w.editor_of(&module).is_none())
    });
    view.read_with(cx, |w, _| assert!(w.editor_of(&exact).is_none()));
}
#[gpui::test]
fn actual_whole_book_registry_tracks_reload_focus_and_new_find(cx: &mut TestAppContext) {
    let (_dir, lib, book, _entry) = fixture();
    let (view, cx) = setup(cx, &lib, &book);
    let manuscript_id = view.read_with(cx, |w, _| w.book.v3().unwrap().roots[0].clone());
    let book_target = Target::Book(manuscript_id.parse().unwrap());
    view.update(cx, |w, cx| w.open(book_target.clone(), Open::KEEP, cx));
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
        manual: false,
    };
    let assist = first.read_with(cx, |e, _| e.assist().clone());
    assist.update(cx, |a, cx| a.open_entity_link_v3(link.clone(), cx));
    let exact = target(&entry, Some("second"));
    wait(cx, |cx| {
        view.read_with(cx, |w, _| {
            // One entry is one tab (kernel v5, T1): the link is a place on
            // the page already open.
            w.nav.current().is_some_and(|c| c.same_page(&exact)) && w.editor_of(&exact).is_some()
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
                lib.library().local_transaction(|tx| {tx.execute_batch("CREATE TRIGGER mounted_final_fault BEFORE INSERT ON loro_update WHEN NEW.doc_id LIKE 'checkpoints:%' BEGIN SELECT RAISE(ABORT,'mounted final fault'); END;")?;Ok(())}).map_err(|e|e.to_string())?;
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

#[gpui::test]
fn whole_book_opens_from_any_level_entry_and_keeps_per_entry_reading_positions(
    cx: &mut TestAppContext,
) {
    use dr_shell::Settings;

    let (_dir, lib, book, _entry) = fixture();
    let initial = dr_shell::book::Book::load(&lib, &book).unwrap();
    let v = initial.v3().unwrap();
    let ms_root = v.roots[0].clone();
    let sl_root = v.roots[1].clone();

    // Create an intermediate volume (`第一卷`, `level = true`) with `mod-description` (`in_book = false`)
    // and two multi-paragraph chapters under it, plus a storyline (`主线`, `level = true`) affiliating them
    // in reverse order.
    let vol = call(
        &lib,
        "entry.create",
        json!({"book": book, "parent": ms_root, "template": "tpl-group", "title": "第一卷", "level": true}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &lib,
        "module.set_prose",
        json!({"book": book, "owner": vol, "module": "mod-description", "paragraphs": [{"text": "卷说明不应出现在整书视图"}]}),
    );
    let make_chapter = |title: &str, prefix: &str| -> String {
        let id = call(
            &lib,
            "entry.create",
            json!({"book": book, "parent": vol, "template": "tpl-chapter", "title": title}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let paragraphs: Vec<Value> = (1..=12)
            .map(|n| json!({"text": format!("{prefix} 第{n}段")}))
            .collect();
        call(
            &lib,
            "module.set_prose",
            json!({"book": book, "owner": id, "module": "mod-prose", "paragraphs": paragraphs}),
        );
        id
    };
    let ch_a = make_chapter("卷内甲章", "甲");
    let ch_b = make_chapter("卷内乙章", "乙");

    let storyline = call(
        &lib,
        "entry.create",
        json!({"book": book, "parent": sl_root, "template": "tpl-storyline", "title": "主线视角", "level": true}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &lib,
        "membership.add",
        json!({"book": book, "host": storyline, "member": ch_b, "pos": "a0"}),
    );
    call(
        &lib,
        "membership.add",
        json!({"book": book, "host": storyline, "member": ch_a, "pos": "a1"}),
    );

    let (view, cx) = setup(cx, &lib, &book);
    wait(cx, |cx| {
        view.read_with(cx, |w, _| {
            w.book.v3().is_some_and(|v| v.entry(&storyline).is_some())
        })
    });

    let ms_book = Target::Book(ms_root.parse().unwrap());
    let vol_book = Target::Book(vol.parse().unwrap());
    let sl_book = Target::Book(storyline.parse().unwrap());

    for t in [&ms_book, &vol_book, &sl_book] {
        view.update(cx, |w, cx| w.open(t.clone(), Open::KEEP, cx));
        wait(cx, |cx| {
            view.read_with(cx, |w, _| w.book_editor_of(t).is_some())
        });
    }

    // Verify `第一卷` flattened view starts with prose-less `第一卷` (depth 0), excludes `mod-description`,
    // and contains both chapters with `mod-prose` + `second` in order.
    let vol_editor = view.read_with(cx, |w, _| w.book_editor_of(&vol_book).unwrap().clone());
    vol_editor.read_with(cx, |e, cx| {
        assert_eq!(e.from_entry(), vol);
        let sections: Vec<_> = e
            .sections()
            .iter()
            .map(|s| (s.entry.as_str(), s.title.as_str(), s.depth, s.doc.is_some()))
            .collect();
        assert_eq!(
            sections,
            vec![
                (vol.as_str(), "第一卷", 0, false),
                (ch_a.as_str(), "卷内甲章", 1, true),
                (ch_a.as_str(), "Second", 2, true),
                (ch_b.as_str(), "卷内乙章", 1, true),
                (ch_b.as_str(), "Second", 2, true),
            ]
        );
        let full_text = e
            .chapter_docs()
            .map(|d| e.plain_text(d, cx).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!full_text.contains("卷说明不应出现在整书视图"));
    });

    // Verify `主线视角` flattened view starts with prose-less `主线视角` (depth 0) followed by memberships `乙 -> 甲`.
    let sl_editor = view.read_with(cx, |w, _| w.book_editor_of(&sl_book).unwrap().clone());
    sl_editor.read_with(cx, |e, _| {
        assert_eq!(e.from_entry(), storyline);
        let entries: Vec<_> = e
            .sections()
            .iter()
            .map(|s| (s.entry.as_str(), s.depth, s.doc.is_some()))
            .collect();
        assert_eq!(
            entries,
            vec![
                (storyline.as_str(), 0, false),
                (ch_b.as_str(), 1, true),
                (ch_b.as_str(), 2, true),
                (ch_a.as_str(), 1, true),
                (ch_a.as_str(), 2, true),
            ]
        );
    });

    // Scroll `vol_book` to `ch_b` line 15 and `sl_book` to `ch_a` line 9; verify independent persistence!
    let doc_a = format!("body:{ch_a}/mod-prose");
    let doc_b = format!("body:{ch_b}/mod-prose");
    view.update(cx, |w, cx| w.open(vol_book.clone(), Open::KEEP, cx));
    wait(cx, |cx| {
        view.read_with(cx, |w, _| w.nav.current() == Some(&vol_book))
    });
    vol_editor.update_in(cx, |e, window, cx| {
        assert!(e.reveal_line(&doc_b, 15, window, cx));
    });
    wait(cx, |_| true);
    let expected_vol = vol_editor.read_with(cx, |e, cx| e.reading_position(cx).unwrap());
    assert_eq!(expected_vol.doc, doc_b);

    view.update(cx, |w, cx| w.open(sl_book.clone(), Open::KEEP, cx));
    wait(cx, |cx| {
        view.read_with(cx, |w, _| w.nav.current() == Some(&sl_book))
    });
    sl_editor.update_in(cx, |e, window, cx| {
        assert!(e.reveal_line(&doc_a, 9, window, cx));
    });
    wait(cx, |_| true);
    let expected_sl = sl_editor.read_with(cx, |e, cx| e.reading_position(cx).unwrap());
    assert_eq!(expected_sl.doc, doc_a);

    view.update(cx, |w, cx| w.store_layout(cx));
    let saved_positions =
        cx.update(|_, cx| Settings::read(cx).layout(&book).unwrap()["book_positions"].clone());
    assert_eq!(saved_positions[&vol]["doc"], doc_b);
    assert_eq!(saved_positions[&storyline]["doc"], doc_a);

    // Close both tabs and reopen them; each restores its own independent position.
    for key in [vol_book.key(), sl_book.key()] {
        view.update(cx, |w, cx| {
            let ix = w.nav.tabs().iter().position(|t| t.key() == key).unwrap();
            w.nav.close(ix);
            cx.notify();
        });
    }
    wait(cx, |cx| {
        view.read_with(cx, |w, _| {
            w.book_editor_of(&vol_book).is_none() && w.book_editor_of(&sl_book).is_none()
        })
    });

    view.update(cx, |w, cx| w.open(vol_book.clone(), Open::KEEP, cx));
    wait(cx, |cx| {
        view.read_with(cx, |w, _| w.book_editor_of(&vol_book).is_some())
    });
    let restored_vol = view.read_with(cx, |w, cx| {
        w.book_editor_of(&vol_book)
            .unwrap()
            .read(cx)
            .reading_position(cx)
            .unwrap()
    });
    assert_eq!(restored_vol.doc, expected_vol.doc);
    assert_eq!(restored_vol.paragraph, expected_vol.paragraph);

    view.update(cx, |w, cx| w.open(sl_book.clone(), Open::KEEP, cx));
    wait(cx, |cx| {
        view.read_with(cx, |w, _| w.book_editor_of(&sl_book).is_some())
    });
    let restored_sl = view.read_with(cx, |w, cx| {
        w.book_editor_of(&sl_book)
            .unwrap()
            .read(cx)
            .reading_position(cx)
            .unwrap()
    });
    assert_eq!(restored_sl.doc, expected_sl.doc);
    assert_eq!(restored_sl.paragraph, expected_sl.paragraph);
}

#[gpui::test]
fn whole_book_opens_from_timeline_view_and_lane_targets_and_closes_when_removed(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, book, _entry) = fixture();
    let initial = dr_shell::book::Book::load(&lib, &book).unwrap();
    let v = initial.v3().unwrap();
    let ms_root = v.roots[0].clone();
    let sl_root = v.roots[1].clone();
    let view_id = "synthetic-whole-view".to_owned();
    call(
        &lib,
        "timeline_view.put",
        json!({
            "book": book,
            "view": {
                "id": view_id,
                "name": "Synthetic whole-book scale view",
                "lanes": [],
                "placements": [],
                "pins": [],
            }
        }),
    );

    let ch_a = call(
        &lib,
        "entry.create",
        json!({"book": book, "parent": ms_root, "template": "tpl-chapter", "title": "刻度甲章"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let ch_b = call(
        &lib,
        "entry.create",
        json!({"book": book, "parent": ms_root, "template": "tpl-chapter", "title": "刻度乙章"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let ch_c = call(
        &lib,
        "entry.create",
        json!({"book": book, "parent": ms_root, "template": "tpl-chapter", "title": "刻度丙章"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let lane_1 = call(
        &lib,
        "entry.create",
        json!({"book": book, "parent": sl_root, "template": "tpl-storyline", "title": "一线", "level": false}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let lane_2 = call(
        &lib,
        "entry.create",
        json!({"book": book, "parent": sl_root, "template": "tpl-storyline", "title": "二线", "level": false}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    call(
        &lib,
        "timeline_view.add_lane",
        json!({"book": book, "view": view_id, "lane": lane_1}),
    );
    call(
        &lib,
        "timeline_view.add_lane",
        json!({"book": book, "view": view_id, "lane": lane_2}),
    );
    call(
        &lib,
        "timeline_view.place",
        json!({"book": book, "view": view_id, "lane": lane_1, "entry": ch_b, "at": 20.0}),
    );
    call(
        &lib,
        "timeline_view.place",
        json!({"book": book, "view": view_id, "lane": lane_1, "entry": ch_a, "at": 5.0}),
    );
    call(
        &lib,
        "timeline_view.place",
        json!({"book": book, "view": view_id, "lane": lane_2, "entry": ch_c, "at": 10.0}),
    );

    let (view, cx) = setup(cx, &lib, &book);
    wait(cx, |cx| {
        view.read_with(cx, |w, _| {
            w.book.v3().is_some_and(|v| v.entry(&lane_2).is_some())
        })
    });

    let tv_target = Target::BookView(view_id.parse().unwrap());
    let lane_target = Target::BookLane {
        view: view_id.parse().unwrap(),
        entry: lane_1.parse().unwrap(),
    };

    for t in [&tv_target, &lane_target] {
        view.update(cx, |w, cx| w.open(t.clone(), Open::KEEP, cx));
        wait(cx, |cx| {
            view.read_with(cx, |w, _| w.book_editor_of(t).is_some())
        });
    }

    let tv_editor = view.read_with(cx, |w, _| w.book_editor_of(&tv_target).unwrap().clone());
    tv_editor.read_with(cx, |e, _| {
        let mut entries: Vec<&str> = e.sections().iter().map(|s| s.entry.as_str()).collect();
        entries.dedup();
        assert_eq!(entries, vec![ch_a.as_str(), ch_c.as_str(), ch_b.as_str()]);
    });

    let lane_editor = view.read_with(cx, |w, _| w.book_editor_of(&lane_target).unwrap().clone());
    lane_editor.read_with(cx, |e, _| {
        let mut entries: Vec<&str> = e.sections().iter().map(|s| s.entry.as_str()).collect();
        entries.dedup();
        assert_eq!(entries, vec![ch_a.as_str(), ch_b.as_str()]);
    });

    // Moving ch_b before ch_a in the view updates both mounted whole-book editors live.
    call(
        &lib,
        "timeline_view.place",
        json!({"book": book, "view": view_id, "lane": lane_1, "entry": ch_b, "at": 1.0}),
    );
    wait(cx, |cx| {
        lane_editor.read_with(cx, |e, _| {
            let mut entries: Vec<&str> = e.sections().iter().map(|s| s.entry.as_str()).collect();
            entries.dedup();
            entries == vec![ch_b.as_str(), ch_a.as_str()]
        })
    });
    tv_editor.read_with(cx, |e, _| {
        let mut entries: Vec<&str> = e.sections().iter().map(|s| s.entry.as_str()).collect();
        entries.dedup();
        assert_eq!(entries, vec![ch_b.as_str(), ch_a.as_str(), ch_c.as_str()]);
    });

    // Removing lane_1 from the view closes the lane whole-book tab while keeping the view tab open.
    call(
        &lib,
        "timeline_view.remove_lane",
        json!({"book": book, "view": view_id, "lane": lane_1}),
    );
    wait(cx, |cx| {
        view.read_with(cx, |w, _| {
            !w.nav.tabs().iter().any(|t| t.key() == lane_target.key())
                && w.nav.tabs().iter().any(|t| t.key() == tv_target.key())
        })
    });

    // Deleting the view closes the view whole-book tab as well.
    call(
        &lib,
        "timeline_view.delete",
        json!({"book": book, "id": view_id}),
    );
    wait(cx, |cx| {
        view.read_with(cx, |w, _| {
            !w.nav.tabs().iter().any(|t| t.key() == tv_target.key())
        })
    });
}
