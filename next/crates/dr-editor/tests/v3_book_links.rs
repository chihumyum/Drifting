//! V3 manuscript order, session lifetime and name eligibility on the shared synthetic seed.
use dr_editor::entity_links::{NameGroup, NameIndex};
use dr_editor::links::LinkTargets as _;
use dr_editor::{BookEditor, EditorSettings};
use dr_workspace::{Actor, Workspace};
use gpui::{EntityInputHandler, TestAppContext};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
struct Env {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
    entries: Value,
}
fn call(e: &Env, name: &str, mut input: Value) -> Value {
    input["book"] = e.book.clone().into();
    e.ws.call(&Actor::User, name, input)
        .unwrap_or_else(|err| panic!("{name}: {err}"))["output"]
        .clone()
}
fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&lib).unwrap();
    lib.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "test").unwrap();
    let mut e = Env {
        _dir: dir,
        ws,
        book,
        entries: Value::Null,
    };
    e.entries = call(&e, "entry.list", json!({"all":true}));
    e
}
fn entry<'a>(e: &'a Env, template: &str) -> &'a Value {
    e.entries
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["template"] == template)
        .unwrap()
}

// F4c's ordinary cross-chapter text, on the canonical v3 manuscript. These
// actions must pass through the drawn BookEditor/Assist capture, not through
// ProseEditor's paste_text/on_cut helpers.
fn cross_fixture() -> (Env, Vec<String>) {
    let e = env();
    let docs = dr_editor::v3::read(&e.ws, &e.book, |v| dr_editor::v3::manuscript_docs(&v))
        .unwrap()
        .into_iter()
        .map(|(doc, _)| doc)
        .collect::<Vec<_>>();
    for (doc, text) in docs.iter().zip([vec!["甲乙丙"], vec!["丁戊", "己"]]) {
        let (owner, module) = dr_editor::v3::body(doc).unwrap();
        call(
            &e,
            "module.set_prose",
            json!({"owner":owner,"module":module,
            "paragraphs":text.into_iter().map(|text|json!({"text":text})).collect::<Vec<_>>()}),
        );
    }
    (e, docs)
}
fn draw_cross(cx: &mut gpui::VisualTestContext) {
    cx.run_until_parked();
    cx.update(|w, cx| {
        w.simulate_next_frame(cx);
        w.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}
fn open_cross<'a>(
    cx: &'a mut TestAppContext,
    e: &Env,
) -> (
    gpui::Entity<BookEditor>,
    gpui::Entity<gpui_prose::ProseEditor>,
    &'a mut gpui::VisualTestContext,
) {
    use gpui::Focusable as _;
    let ws = e.ws.clone();
    let book = e.book.clone();
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |w, cx| {
        BookEditor::open(
            ws,
            &book,
            EditorSettings {
                auto_entity_links: false,
                ..Default::default()
            },
            w,
            cx,
        )
        .unwrap()
    });
    draw_cross(cx);
    let prose = view.read_with(cx, |v, _| v.editor().clone());
    cx.update(|w, cx| prose.read(cx).focus_handle(cx).focus(w, cx));
    draw_cross(cx);
    (view, prose, cx)
}
fn select_cross(prose: &gpui::Entity<gpui_prose::ProseEditor>, cx: &mut gpui::VisualTestContext) {
    use gpui_prose::layout::BookPos;
    prose.update_in(cx, |p, w, cx| {
        p.select_across(
            BookPos {
                chapter: 0,
                offset: 1,
            },
            BookPos {
                chapter: 1,
                offset: 1,
            },
            w,
            cx,
        )
    });
    draw_cross(cx);
}
fn cross_states(e: &Env, docs: &[String]) -> Vec<(loro::Frontiers, Value)> {
    docs.iter()
        .map(|id| {
            let d = e.ws.library().load_copy(id).unwrap();
            (
                d.oplog_frontiers(),
                dr_doc::v3::raw_document_state(&d).unwrap(),
            )
        })
        .collect()
}
fn cross_texts(e: &Env, docs: &[String]) -> Vec<String> {
    docs.iter()
        .map(|id| {
            let doc = e.ws.library().load_copy(id).unwrap();
            dr_doc::prose::BorrowedProse::new(&doc, &dr_model::DocId::parse(id).unwrap())
                .unwrap()
                .view()
                .plain_text()
        })
        .collect()
}
fn cross_case(cx: &mut TestAppContext, cut: bool, external: bool) {
    use gpui::Focusable as _;
    use gpui_prose::{
        input::actions::{Copy, Cut, Paste, Undo},
        layout::BookPos,
    };
    let (e, docs) = cross_fixture();
    let before = cross_texts(&e, &docs);
    assert_eq!(&before[..2], &["甲乙丙\n", "丁戊\n己\n"]);
    let ws = e.ws.clone();
    let book = e.book.clone();
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |w, cx| {
        BookEditor::open(
            ws,
            &book,
            EditorSettings {
                auto_entity_links: false,
                ..Default::default()
            },
            w,
            cx,
        )
        .unwrap()
    });
    draw_cross(cx);
    let prose = view.read_with(cx, |v, _| v.editor().clone());
    let focus = prose.read_with(cx, |p, cx| p.focus_handle(cx));
    cx.update(|w, cx| w.focus(&focus, cx));
    if !cut {
        prose.update_in(cx, |p, w, cx| p.select(0, 0..1, w, cx));
        draw_cross(cx);
        cx.dispatch_action(Copy);
        draw_cross(cx);
        let item = cx.read_from_clipboard().unwrap();
        assert_eq!(item.text().as_deref(), Some("甲"));
        let meta: Value = serde_json::from_str(item.metadata().unwrap()).unwrap();
        assert_eq!(meta["drifting_prose_v3"]["marks"], json!([]));
        if external {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string("甲".into()));
        }
    }
    prose.update_in(cx, |p, w, cx| {
        p.select_across(
            BookPos {
                chapter: 0,
                offset: 1,
            },
            BookPos {
                chapter: 1,
                offset: 1,
            },
            w,
            cx,
        )
    });
    draw_cross(cx);
    cx.update(|w, cx| assert!(prose.read(cx).focus_handle(cx).is_focused(w)));
    if cut {
        cx.dispatch_action(Cut);
    } else {
        cx.dispatch_action(Paste);
    }
    draw_cross(cx);
    if cut {
        assert_eq!(
            cx.read_from_clipboard().unwrap().text().as_deref(),
            Some("乙丙\n丁")
        );
    }
    let mut after = before.clone();
    after[0] = if cut { "甲\n" } else { "甲甲\n" }.into();
    after[1] = "戊\n己\n".into();
    assert_eq!(
        cross_texts(&e, &docs),
        after,
        "actual Assist action must replace each chapter's selected range"
    );
    cx.dispatch_action(Undo);
    draw_cross(cx);
    assert_eq!(
        cross_texts(&e, &docs),
        before,
        "one routed Undo must restore the whole group"
    );
}
#[gpui::test]
fn v3_cross_document_cut_through_assist_persists_and_undoes_once(cx: &mut TestAppContext) {
    cross_case(cx, true, false);
}
#[gpui::test]
fn v3_cross_document_internal_plain_paste_through_assist_persists_and_undoes_once(
    cx: &mut TestAppContext,
) {
    cross_case(cx, false, false);
}
#[gpui::test]
fn v3_cross_document_external_plain_paste_control(cx: &mut TestAppContext) {
    cross_case(cx, false, true);
}

#[gpui::test]
fn v3_cross_document_cut_at_first_chapter_end_undoes_from_unchanged_caret_chapter(
    cx: &mut TestAppContext,
) {
    use gpui_prose::{
        input::actions::{Cut, Redo, Undo},
        layout::BookPos,
    };
    let (e, docs) = cross_fixture();
    let original = cross_texts(&e, &docs);
    let (_view, prose, cx) = open_cross(cx, &e);
    prose.update_in(cx, |p, w, cx| {
        p.select(0, 3..3, w, cx);
        p.replace_text_in_range(None, "新", w, cx);
    });
    draw_cross(cx);
    let before = cross_texts(&e, &docs);
    let first_state = cross_states(&e, &docs)[0].clone();
    prose.update_in(cx, |p, w, cx| {
        p.select_across(
            BookPos {
                chapter: 0,
                offset: 4,
            },
            BookPos {
                chapter: 1,
                offset: 1,
            },
            w,
            cx,
        )
    });
    draw_cross(cx);
    cx.dispatch_action(Cut);
    draw_cross(cx);
    let mut after = before.clone();
    after[1] = "戊\n己\n".into();
    assert_eq!(cross_texts(&e, &docs), after);
    assert_eq!(
        cross_states(&e, &docs)[0],
        first_state,
        "empty fragment must not manufacture a body write for Undo"
    );
    assert_eq!(prose.read_with(cx, |p, _| p.selection().chapter), 0);
    cx.dispatch_action(Undo);
    draw_cross(cx);
    assert_eq!(
        cross_texts(&e, &docs),
        before,
        "one Undo must restore the group without consuming the older first-chapter typing"
    );
    cx.dispatch_action(Undo);
    draw_cross(cx);
    assert_eq!(cross_texts(&e, &docs), original);
    cx.dispatch_action(Redo);
    draw_cross(cx);
    assert_eq!(cross_texts(&e, &docs), before);
    cx.dispatch_action(Redo);
    draw_cross(cx);
    assert_eq!(cross_texts(&e, &docs), after);
}

#[gpui::test]
fn v3_cross_document_later_typing_does_not_rejoin_the_clipboard_undo_group(
    cx: &mut TestAppContext,
) {
    use gpui_prose::input::actions::{Cut, Undo};
    let (e, docs) = cross_fixture();
    let (_view, prose, cx) = open_cross(cx, &e);
    select_cross(&prose, cx);
    // No selection/navigation checkpoint between the accepted Cut and the
    // subsequent ordinary IME input in its caret chapter.
    cx.update(|window, cx| {
        use gpui::Focusable as _;
        prose
            .read(cx)
            .focus_handle(cx)
            .dispatch_action(&Cut, window, cx);
        prose.update(cx, |p, cx| p.replace_text_in_range(None, "新", window, cx));
    });
    draw_cross(cx);
    assert_eq!(&cross_texts(&e, &docs)[..2], &["甲新\n", "戊\n己\n"]);
    // Undo the group's step in the OTHER chapter. The later first-chapter
    // input and its older deletion stay for that chapter's own Undo.
    prose.update_in(cx, |p, w, cx| p.select(1, 0..0, w, cx));
    draw_cross(cx);
    cx.dispatch_action(Undo);
    draw_cross(cx);
    assert_eq!(&cross_texts(&e, &docs)[..2], &["甲新\n", "丁戊\n己\n"]);
    prose.update_in(cx, |p, w, cx| p.select(0, 2..2, w, cx));
    draw_cross(cx);
    cx.dispatch_action(Undo);
    draw_cross(cx);
    assert_eq!(&cross_texts(&e, &docs)[..2], &["甲\n", "丁戊\n己\n"]);
    cx.dispatch_action(Undo);
    draw_cross(cx);
    assert_eq!(&cross_texts(&e, &docs)[..2], &["甲乙丙\n", "丁戊\n己\n"]);
}

#[gpui::test]
fn v3_cross_document_old_typing_inside_the_cut_still_undoes_after_group_restore(
    cx: &mut TestAppContext,
) {
    use gpui::Focusable as _;
    use gpui_prose::{
        input::actions::{Cut, Redo, Undo},
        layout::BookPos,
    };
    let (e, docs) = cross_fixture();
    let before = cross_texts(&e, &docs);
    let (_view, prose, cx) = open_cross(cx, &e);
    prose.update_in(cx, |p, w, cx| p.replace_text_in_range(None, "新", w, cx));
    draw_cross(cx);
    let (owner, module) = dr_editor::v3::body(&docs[0]).unwrap();
    assert_eq!(
        call(
            &e,
            "module.read_prose",
            json!({"owner":owner,"module":module})
        )["paragraphs"][0]["text"],
        "新甲乙丙"
    );
    prose.update_in(cx, |p, w, cx| {
        p.select_across(
            BookPos {
                chapter: 0,
                offset: 0,
            },
            BookPos {
                chapter: 1,
                offset: 1,
            },
            w,
            cx,
        )
    });
    draw_cross(cx);
    cx.dispatch_action(Cut);
    draw_cross(cx);
    assert_eq!(&cross_texts(&e, &docs)[..2], &["\n", "戊\n己\n"]);
    assert_eq!(
        call(
            &e,
            "module.read_prose",
            json!({"owner":owner,"module":module})
        )["paragraphs"][0]["text"],
        ""
    );
    cx.dispatch_action(Undo);
    draw_cross(cx);
    assert_eq!(&cross_texts(&e, &docs)[..2], &["新甲乙丙\n", "丁戊\n己\n"]);
    assert_eq!(
        call(
            &e,
            "module.read_prose",
            json!({"owner":owner,"module":module})
        )["paragraphs"][0]["text"],
        "新甲乙丙"
    );
    assert_eq!(prose.read_with(cx, |p, _| p.selection().chapter), 0);
    cx.update(|w, cx| {
        assert!(
            prose.read(cx).focus_handle(cx).is_focused(w),
            "restored book must retain the actual editor focus"
        )
    });
    cx.dispatch_action(Undo);
    draw_cross(cx);
    assert_eq!(cross_texts(&e, &docs), before);
    cx.dispatch_action(Redo);
    draw_cross(cx);
    assert_eq!(&cross_texts(&e, &docs)[..2], &["新甲乙丙\n", "丁戊\n己\n"]);
    cx.dispatch_action(Redo);
    draw_cross(cx);
    assert_eq!(&cross_texts(&e, &docs)[..2], &["\n", "戊\n己\n"]);
    cx.dispatch_action(Undo);
    draw_cross(cx);
    cx.dispatch_action(Undo);
    draw_cross(cx);
    assert_eq!(cross_texts(&e, &docs), before);
}

#[gpui::test]
fn v3_cross_document_rich_paste_middle_chapter_raw_marks_anchor_and_grouped_undo(
    cx: &mut TestAppContext,
) {
    use dr_doc::prose::v3::EntityLinkMarksV3;
    use gpui_prose::{
        HostStep,
        input::actions::{Copy, Paste, Redo, Undo},
        layout::BookPos,
    };
    use loro::LoroValue as L;
    let (e, docs) = cross_fixture();
    let target = dr_editor::v3::body(&docs[2]).unwrap().0;
    let block = call(&e, "prose.read", json!({"doc":docs[2]}))["paragraphs"][0]["block_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let raw = L::Map(
        vec![
            ("kind".into(), "entry".into()),
            ("module".into(), "mod-prose".into()),
            ("block".into(), block.clone().into()),
            ("end_block".into(), block.into()),
            ("future".into(), L::Binary(vec![0, 128, 255].into())),
        ]
        .into(),
    );
    let key = format!("entity:{target}");
    let marks = EntityLinkMarksV3::from_marks(2, vec![(0..2, key.clone(), raw.clone())]).unwrap();
    e.ws.prose_session(&docs[0])
        .unwrap()
        .edit(move |t| {
            t.apply_entity_links_v3(0, &marks)?;
            t.set_style(0..2, &dr_model::prose::InlineStyle::Bold)
        })
        .unwrap();
    // An unknown author value outside the copied/replaced range must survive.
    let untouched =
        e.ws.library()
            .open_doc(&docs[3], dr_store::OpenDoc::Existing)
            .unwrap();
    untouched
        .write(dr_store::Origin::Command, |d| {
            d.get_map("future-owner")
                .insert("bytes", L::Binary(vec![5, 0, 255].into()))
        })
        .unwrap()
        .0
        .unwrap();
    let before = cross_states(&e, &docs);
    let texts = cross_texts(&e, &docs);
    let (view, prose, cx) = open_cross(cx, &e);
    prose.update_in(cx, |p, w, cx| {
        p.edit_chapter(1, HostStep::Own, w, cx, |doc| {
            doc.add_anchor("selected", 0..1).unwrap();
            None
        });
        p.select(0, 0..2, w, cx);
    });
    draw_cross(cx);
    cx.dispatch_action(Copy);
    draw_cross(cx);
    prose.update_in(cx, |p, w, cx| {
        p.select_across(
            BookPos {
                chapter: 2,
                offset: 1,
            },
            BookPos {
                chapter: 0,
                offset: 1,
            },
            w,
            cx,
        )
    });
    draw_cross(cx);
    cx.dispatch_action(Paste);
    draw_cross(cx);
    let mut expected = texts.clone();
    expected[0] = "甲甲乙\n".into();
    expected[1] = "\n".into();
    expected[2] = texts[2].chars().skip(1).collect();
    assert_eq!(cross_texts(&e, &docs), expected);
    let d = e.ws.library().load_copy(&docs[0]).unwrap();
    let id = dr_model::DocId::parse(&docs[0]).unwrap();
    let b = dr_doc::prose::BorrowedProse::new(&d, &id).unwrap();
    // The original marked 甲 remains outside the replaced range. Its mark
    // joins the identical mark on the pasted 甲乙 into exactly 0..3.
    assert_eq!(
        b.view().copy_entity_links_v3(0..3).unwrap().marks(),
        &[(0..3, key, raw)]
    );
    assert!(d.get_text(dr_doc::schema::prose::BODY).to_delta().iter().any(|d|matches!(d,loro::TextDelta::Insert{attributes:Some(a),..} if a.get("bold")==Some(&L::Bool(true)))));
    assert_eq!(cross_states(&e, &docs)[3], before[3]);
    cx.dispatch_action(Undo);
    draw_cross(cx);
    assert_eq!(
        cross_states(&e, &docs)
            .iter()
            .map(|s| &s.1)
            .collect::<Vec<_>>(),
        before.iter().map(|s| &s.1).collect::<Vec<_>>()
    );
    prose.update_in(cx, |p, w, cx| {
        p.edit_chapter(1, HostStep::Own, w, cx, |doc| {
            assert_eq!(doc.anchor("selected").unwrap().range, 0..1);
            None
        });
    });
    // Redo still reaches the same group (the anchor read makes no body step).
    cx.dispatch_action(Redo);
    draw_cross(cx);
    assert_eq!(cross_texts(&e, &docs), expected);
    cx.dispatch_action(Undo);
    draw_cross(cx);
    assert_eq!(cross_texts(&e, &docs), texts);
    cx.update(|w, _| w.remove_window());
    drop(prose);
    drop(view);
    drop(untouched);
    cx.run_until_parked();
    cx.cx.update(|_| {});
    cx.run_until_parked();
    let Env { _dir, ws, .. } = e;
    ws.shutdown().unwrap();
    let reopened = Workspace::open_dir(_dir.path(), "test").unwrap();
    for (id, (_, state)) in docs.iter().zip(before) {
        assert_eq!(
            dr_doc::v3::raw_document_state(&reopened.library().load_copy(id).unwrap()).unwrap(),
            state
        );
    }
}

fn cross_failure(cx: &mut TestAppContext, fault: bool) {
    use gpui_prose::input::actions::{Copy, Cut, Paste, Undo};
    use std::{cell::Cell, rc::Rc};
    let (e, docs) = cross_fixture();
    let (view, prose, cx) = open_cross(cx, &e);
    let errors = Rc::new(Cell::new(0));
    let seen = errors.clone();
    cx.update(|_, cx| {
        dr_editor::links::set_clipboard_refusal(cx, move |_| seen.set(seen.get() + 1))
    });
    prose.update_in(cx, |p, w, cx| p.select(0, 0..1, w, cx));
    draw_cross(cx);
    cx.dispatch_action(Copy);
    draw_cross(cx);
    select_cross(&prose, cx);
    let selection = prose.read_with(cx, |p, _| p.selection());
    if fault {
        let last = docs[..2].iter().max().unwrap();
        e.ws.library().local_transaction(|tx|{tx.execute_batch(&format!("CREATE TRIGGER cross_fail BEFORE INSERT ON loro_update WHEN NEW.doc_id='{last}' BEGIN SELECT RAISE(ABORT,'second cross append'); END;"))?;Ok(())}).unwrap();
    } else {
        let (owner, module) = dr_editor::v3::body(&docs[1]).unwrap();
        call(
            &e,
            "module.set_prose",
            json!({"owner":owner,"module":module,"paragraphs":[{"text":"他戊"},{"text":"己"}]}),
        );
    }
    let before = cross_states(&e, &docs);
    let seq = e.ws.library().write_seq().unwrap();
    // Dispatch synchronously on the actual focused dispatch-tree node, through
    // Assist capture. Check the refusal before the normal peer-refresh task
    // gets a turn to transform the retained selection over the peer's edits.
    cx.update(|window, cx| {
        use gpui::Focusable as _;
        let focus = prose.read(cx).focus_handle(cx);
        if fault {
            focus.dispatch_action(&Paste, window, cx);
        } else {
            focus.dispatch_action(&Cut, window, cx);
        }
        assert_eq!(prose.read(cx).selection(), selection);
        assert!(focus.is_focused(window));
    });
    assert_eq!(cross_states(&e, &docs), before);
    assert_eq!(e.ws.library().write_seq().unwrap(), seq);
    assert_eq!(errors.get(), 1);
    draw_cross(cx);
    if fault {
        e.ws.library()
            .local_transaction(|tx| {
                tx.execute_batch("DROP TRIGGER cross_fail")?;
                Ok(())
            })
            .unwrap();
        // Failure retained the actual selection and inputs: the same action
        // succeeds after the fault is removed; one Undo restores the group.
        cx.dispatch_action(Paste);
        draw_cross(cx);
        assert_eq!(&cross_texts(&e, &docs)[..2], &["甲甲\n", "戊\n己\n"]);
        cx.dispatch_action(Undo);
        draw_cross(cx);
        assert_eq!(
            cross_states(&e, &docs)
                .iter()
                .map(|s| &s.1)
                .collect::<Vec<_>>(),
            before.iter().map(|s| &s.1).collect::<Vec<_>>()
        );
    }
    cx.update(|w, _| w.remove_window());
    drop(prose);
    drop(view);
    cx.run_until_parked();
    cx.cx.update(|_| {});
    cx.run_until_parked();
    let Env { _dir, ws, .. } = e;
    ws.shutdown().unwrap();
    let reopened = Workspace::open_dir(_dir.path(), "test").unwrap();
    for (id, (_, state)) in docs.iter().zip(before) {
        assert_eq!(
            dr_doc::v3::raw_document_state(&reopened.library().load_copy(id).unwrap()).unwrap(),
            state
        );
    }
}
#[gpui::test]
fn v3_cross_document_second_append_failure_keeps_selection_and_every_doc_for_retry(
    cx: &mut TestAppContext,
) {
    cross_failure(cx, true);
}
#[gpui::test]
fn v3_cross_document_unseen_same_size_peer_rejects_cut_without_refresh_authority(
    cx: &mut TestAppContext,
) {
    cross_failure(cx, false);
}

#[test]
fn v3_cross_document_atomic_sessions_preserve_undo_items_in_every_live_session() {
    use dr_workspace::ProseSession;
    let (e, docs) = cross_fixture();
    let before = cross_states(&e, &docs);
    let a = e.ws.prose_session(&docs[0]).unwrap();
    let b = e.ws.prose_session(&docs[1]).unwrap();
    let observer = e.ws.prose_session(&docs[0]).unwrap();
    let stage =
        |copies: &std::collections::BTreeMap<String, loro::LoroDoc>| -> dr_workspace::Result<()> {
            for (id, doc) in copies {
                let id = dr_model::DocId::parse(id).unwrap();
                dr_doc::prose::BorrowedProse::new(doc, &id)?
                    .txn()
                    .insert_text(0, "新")?;
            }
            Ok(())
        };
    let result = ProseSession::edit_atomic(&[&a, &b], |copies| {
        stage(copies)?;
        Err::<(), _>(dr_workspace::WsError::Invalid("staging failure".into()))
    });
    assert!(result.is_err());
    assert_eq!(cross_states(&e, &docs), before);
    assert!(!a.can_undo() && !b.can_undo() && !observer.can_undo());
    ProseSession::edit_atomic(&[&a, &b], stage).unwrap();
    assert!(a.can_undo() && b.can_undo() && observer.can_undo());
    assert!(a.undo().unwrap());
    assert!(b.undo().unwrap());
    assert_eq!(&cross_texts(&e, &docs)[..2], &["甲乙丙\n", "丁戊\n己\n"]);
    assert!(a.redo().unwrap());
    assert!(b.redo().unwrap());
    let accepted = cross_texts(&e, &docs);
    observer.edit(|t| t.insert_text(0, "後")).unwrap();
    assert!(observer.undo().unwrap());
    assert_eq!(
        cross_texts(&e, &docs),
        accepted,
        "another session's typing undo cannot absorb the atomic author edit"
    );
    // A book change cannot be authorized merely because both holders exist.
    let other = call(&e, "project.create", json!({"name":"Synthetic other"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let output=e.ws.call(&Actor::User,"entry.create",json!({"book":other,"title":"Other","template":"tpl-chapter","bodies":{"mod-prose":"甲乙丙"}})).unwrap();
    let other =
        e.ws.prose_session(&format!(
            "body:{}/mod-prose",
            output["output"]["id"].as_str().unwrap()
        ))
        .unwrap();
    assert!(
        ProseSession::edit_atomic::<()>(&[&a, &other], |_| panic!(
            "cross-book staging must not run"
        ))
        .is_err()
    );
}
#[test]
fn eligibility_uses_home_or_any_membership_and_never_links_the_owner() {
    let e = env();
    let chapter = entry(&e, "tpl-chapter");
    let id = chapter["id"].as_str().unwrap();
    let home = chapter["parent"].as_str().unwrap();
    let names = NameIndex::load(&e.ws, &e.book, &[]).unwrap();
    assert!(!names.search("", 1000).iter().any(|r| r.1.id == id));
    let character = entry(&e, "tpl-character");
    let host = character["parent"].as_str().unwrap();
    call(
        &e,
        "entry.update",
        json!({"id":host,"overrides":{"allow":[],"auto_link":true,"accept":true}}),
    );
    call(&e, "membership.add", json!({"host":host,"member":id}));
    let names = NameIndex::load(&e.ws, &e.book, &[]).unwrap();
    assert!(
        names
            .search("", 1000)
            .iter()
            .any(|r| r.1.id == id && r.2 == NameGroup::Entry)
    );
    let own = format!("body:{id}/mod-prose");
    assert!(
        !NameIndex::load(&e.ws, &e.book, &[&own])
            .unwrap()
            .search("", 1000)
            .iter()
            .any(|r| r.1.id == id)
    );
    call(&e, "membership.remove", json!({"host":host,"member":id}));
    assert!(
        !NameIndex::load(&e.ws, &e.book, &[])
            .unwrap()
            .search("", 1000)
            .iter()
            .any(|r| r.1.id == id)
    );
    call(
        &e,
        "entry.update",
        json!({"id":home,"overrides":{"auto_link":true}}),
    );
    assert!(
        NameIndex::load(&e.ws, &e.book, &[])
            .unwrap()
            .search("", 1000)
            .iter()
            .any(|r| r.1.id == id)
    );
    let targets = dr_editor::v3::LinkTargets {
        workspace: e.ws.clone(),
        book: e.book.clone(),
    };
    assert!(targets.alive(&dr_model::kind::EntityKind::Entry, id));
    call(&e, "entry.trash", json!({"id":id}));
    assert!(!targets.alive(&dr_model::kind::EntityKind::Entry, id));
    assert!(
        dr_editor::link_card::card_facts(
            &e.ws,
            &e.book,
            &dr_text::autolink::LinkTarget::new(dr_model::kind::EntityKind::Entry, id)
        )
        .is_none()
    );
}
#[gpui::test]
fn manuscript_refresh_keeps_sessions_undo_and_document_order(cx: &mut TestAppContext) {
    let e = env();
    call(
        &e,
        "entry_template.put_module",
        json!({"template":"tpl-chapter","module":{"id":"second","kind":"prose","name":"Second"}}),
    );
    let expected =
        dr_editor::v3::read(&e.ws, &e.book, |v| dr_editor::v3::manuscript_docs(&v)).unwrap();
    assert_eq!(expected.len(), 8);
    assert!(expected.iter().all(|(d, _)| d.starts_with("body:")));
    // Existing seed prose opens directly; a newly added module must still
    // initialize from its template, once, before its first editor session.
    assert!(e.ws.library().doc_info(&expected[0].0).unwrap().is_some());
    assert!(e.ws.library().doc_info(&expected[1].0).unwrap().is_none());
    let first_owner = dr_editor::v3::body(&expected[0].0).unwrap().0;
    let defaults = call(
        &e,
        "module.read_prose",
        json!({"owner":first_owner,"module":"mod-prose"}),
    )["paragraphs"][0]["text"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &e,
        "module.set_prose",
        json!({"owner":"tpl-chapter","module":"second","template":true,
            "paragraphs":[{"text":defaults}]}),
    );
    let ws = e.ws.clone();
    let book = e.book.clone();
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |w, cx| {
        BookEditor::open(ws, &book, EditorSettings::default(), w, cx).unwrap()
    });
    let docs = view.read_with(cx, |v, _| {
        v.chapter_docs().map(str::to_owned).collect::<Vec<_>>()
    });
    assert_eq!(
        docs,
        expected.iter().map(|r| r.0.clone()).collect::<Vec<_>>()
    );
    let (first, second) = (docs[0].clone(), docs[1].clone());
    let original = view.read_with(cx, |v, cx| v.plain_text(&first, cx).unwrap());
    let second_original = view.read_with(cx, |v, cx| v.plain_text(&second, cx).unwrap());
    assert_eq!(second_original.trim(), defaults);
    let prose = view.read_with(cx, |v, _| v.editor().clone());
    prose.update_in(cx, |p, w, cx| {
        p.select(0, 0..0, w, cx);
        p.replace_text_in_range(None, "A", w, cx);
    });
    prose.update_in(cx, |p, w, cx| {
        p.select(1, 0..0, w, cx);
        p.replace_text_in_range(None, "B", w, cx);
    });
    let owner = dr_editor::v3::body(&first).unwrap().0;
    let parent = e
        .entries
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == owner)
        .unwrap()["parent"]
        .clone();
    let manuscript = e
        .entries
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == parent)
        .unwrap()["parent"]
        .clone();
    call(
        &e,
        "entry.move",
        json!({"id":owner,"parent":manuscript,"index":2}),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if view.read_with(cx, |v, _| v.chapter_of(&first)) == Some(6) {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        view.read_with(cx, |v, cx| v.plain_text(&first, cx).unwrap()),
        format!("A{original}")
    );
    let prose = view.read_with(cx, |v, _| v.editor().clone());
    prose.update_in(cx, |p, w, cx| p.select(6, 0..0, w, cx));
    assert!(view.update_in(cx, |v, w, cx| v.undo(w, cx)));
    assert_eq!(
        view.read_with(cx, |v, cx| v.plain_text(&first, cx).unwrap()),
        original
    );
    assert_eq!(
        view.read_with(cx, |v, cx| v.plain_text(&second, cx).unwrap()),
        format!("B{second_original}")
    );
    prose.update_in(cx, |p, w, cx| p.select(7, 0..0, w, cx));
    assert!(view.update_in(cx, |v, w, cx| v.undo(w, cx)));
    assert_eq!(
        view.read_with(cx, |v, cx| v.plain_text(&second, cx).unwrap()),
        second_original
    );
}

#[gpui::test]
fn body_typing_and_mentions_write_entry_links_and_undo_with_the_text(cx: &mut TestAppContext) {
    use dr_editor::{ChapterEditor, assist::MenuRow};
    let e = env();
    let owner = entry(&e, "tpl-chapter")["id"].as_str().unwrap();
    let doc = format!("body:{owner}/mod-prose");
    let target = entry(&e, "tpl-character")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let name = entry(&e, "tpl-character")["title"]
        .as_str()
        .unwrap()
        .to_owned();
    let ws = e.ws.clone();
    let book = e.book.clone();
    let opened = doc.clone();
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |w, cx| {
        ChapterEditor::open(ws, &book, &opened, EditorSettings::default(), w, cx).unwrap()
    });
    let prose = view.read_with(cx, |v, _| v.editor().clone());
    let before = view.read_with(cx, |v, cx| v.plain_text(cx));
    prose.update_in(cx, |p, w, cx| {
        p.select(0, 0..0, w, cx);
        p.replace_text_in_range(None, &format!("{name} "), w, cx);
    });
    cx.run_until_parked();
    cx.executor().advance_clock(Duration::from_millis(700));
    cx.run_until_parked();
    let linked = prose.read_with(cx, |p, _| {
        p.book().chapters[0].doc.lines()[0].spans.iter().any(|s| {
            s.marks.entities().any(|(id, value)| {
                id == target
                    && dr_editor::links::link_kind(value) == dr_model::kind::EntityKind::Entry
            })
        })
    });
    assert!(linked, "typed eligible names gain entry marks");
    prose.update_in(cx, |p, w, cx| p.undo(w, cx));
    assert_eq!(view.read_with(cx, |v, cx| v.plain_text(cx)), before);
    prose.update_in(cx, |p, w, cx| {
        p.select(0, 0..0, w, cx);
        p.replace_text_in_range(None, &format!("@{name}"), w, cx);
    });
    cx.run_until_parked();
    let assist = view.read_with(cx, |v, _| v.assist().clone());
    assist.read_with(cx, |a, _| {
        let menu = a.menu().unwrap();
        assert!(menu.rows.iter().any(
            |r| matches!(r, MenuRow::Link {target:t,group:NameGroup::Entry,..} if t.id==target)
        ));
        assert!(
            !menu
                .rows
                .iter()
                .any(|r| matches!(r, MenuRow::Create { .. }))
        );
        assert!(
            a.position_link(0, 2)
                .unwrap()
                .contains("/modules/id-mod-prose/prose.md#L5")
        );
    });
    assist.update_in(cx, |a, w, cx| a.choose(Some(0), w, cx));
    assert!(
        view.read_with(cx, |v, cx| v.plain_text(cx))
            .starts_with(&name)
    );
    prose.update_in(cx, |p, w, cx| p.undo(w, cx));
    assert!(
        view.read_with(cx, |v, cx| v.plain_text(cx))
            .starts_with(&format!("@{name}"))
    );
}
