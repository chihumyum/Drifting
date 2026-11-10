use super::*;
use crate::{ChapterEditor, EditorSettings};
use dr_doc::prose::v3::EntityLinkMarksV3;
use dr_workspace::{Actor, Workspace};
use gpui::{TestAppContext, VisualTestContext};
use loro::ContainerTrait as _;

fn raw(module: &str) -> LoroValue {
    LoroValue::Map(
        vec![
            ("kind".to_owned(), "entry".into()),
            ("module".to_owned(), module.into()),
            ("block".to_owned(), "block-a".into()),
            ("end_block".to_owned(), "block-b".into()),
            (
                "future".to_owned(),
                LoroValue::List(
                    vec![
                        LoroValue::Binary(vec![0, 128, 255].into()),
                        LoroValue::I64(i64::MAX),
                        LoroValue::Double(-0.0),
                    ]
                    .into(),
                ),
            ),
        ]
        .into(),
    )
}
struct Env {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
    entry: String,
    doc: String,
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
    let entries = ws
        .call(&Actor::User, "entry.list", json!({"book":book,"all":true}))
        .unwrap();
    let entry = entries["output"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == "tpl-chapter")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = format!("body:{entry}/mod-prose");
    ws.call(
        &Actor::User,
        "module.set_prose",
        json!({"book":book,"owner":entry,"module":"mod-prose","paragraphs":[{"text":"前α😀後末"}]}),
    )
    .unwrap();
    let marks = EntityLinkMarksV3::from_marks(
        5,
        vec![
            (1..4, "entity:target".into(), raw("alternate")),
            (
                0..1,
                "entity:future".into(),
                LoroValue::Map(vec![("kind".to_owned(), "future-kind".into())].into()),
            ),
        ],
    )
    .unwrap();
    ws.prose_session(&doc)
        .unwrap()
        .edit(move |t| t.apply_entity_links_v3(0, &marks))
        .unwrap();
    Env {
        _dir: dir,
        ws,
        book,
        entry,
        doc,
    }
}
fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|w, cx| w.draw(cx).clear(cx));
    cx.run_until_parked();
}
fn open<'a>(
    cx: &'a mut TestAppContext,
    e: &Env,
    doc: &str,
) -> (
    Entity<ChapterEditor>,
    Entity<ProseEditor>,
    &'a mut VisualTestContext,
) {
    cx.executor().allow_parking();
    let (ws, book, doc) = (e.ws.clone(), e.book.clone(), doc.to_owned());
    let (view, cx) = cx.add_window_view(move |w, cx| {
        ChapterEditor::open(
            ws,
            &book,
            &doc,
            EditorSettings {
                auto_entity_links: false,
                ..Default::default()
            },
            w,
            cx,
        )
        .unwrap()
    });
    draw(cx);
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    editor.update_in(cx, |e, w, cx| e.focus_at(0, 0, w, cx));
    draw(cx);
    (view, editor, cx)
}
fn durable(e: &Env) -> (String, EntityLinkMarksV3) {
    let d = e.ws.library().load_copy(&e.doc).unwrap();
    let id = dr_model::DocId::parse(&e.doc).unwrap();
    let p = dr_doc::prose::BorrowedProse::new(&d, &id).unwrap();
    (
        p.view().plain_text(),
        p.view()
            .copy_entity_links_v3(0..p.view().len() - 1)
            .unwrap(),
    )
}
#[test]
fn typed_values_preserve_binary_integer_float_and_unknown_nested_fields() {
    let value = raw("second");
    assert_eq!(decode_value(&encode_value(&value).unwrap()).unwrap(), value);
    for v in [
        LoroValue::Double(f64::NAN),
        LoroValue::Double(f64::INFINITY),
        LoroValue::Double(-0.0),
    ] {
        let LoroValue::Double(w) = decode_value(&encode_value(&v).unwrap()).unwrap() else {
            panic!()
        };
        let LoroValue::Double(v) = v else {
            unreachable!()
        };
        assert_eq!(w.to_bits(), v.to_bits());
    }
    let d = loro::LoroDoc::new();
    assert!(encode_value(&LoroValue::Container(d.get_map("future").id())).is_err());
    assert!(decode_marks(&json!([[0, 1, "entity:target", ["unknown", 1]]])).is_err());
}
#[gpui::test]
fn unicode_body_os_clipboard_retains_raw_module_range_and_durable_neighbors(
    cx: &mut TestAppContext,
) {
    let e = env();
    let (view, editor, cx) = open(cx, &e, &e.doc);
    editor.update_in(cx, |e, w, cx| e.select(0, 1..4, w, cx));
    cx.update(|w, cx| assert!(copy(&editor, false, w, cx)));
    let item = cx.read_from_clipboard().unwrap();
    assert_eq!(item.text().as_deref(), Some("α😀後"));
    editor.update_in(cx, |e, w, cx| e.select(0, 5..5, w, cx));
    cx.update(|w, cx| assert!(paste(&editor, w, cx)));
    draw(cx);
    let (text, marks) = durable(&e);
    assert_eq!(text, "前α😀後末α😀後\n");
    assert!(
        marks
            .marks()
            .contains(&(1..4, "entity:target".into(), raw("alternate")))
    );
    assert!(
        marks
            .marks()
            .contains(&(5..8, "entity:target".into(), raw("alternate")))
    );
    assert_eq!(
        marks
            .marks()
            .iter()
            .filter(|m| m.1 == "entity:future")
            .count(),
        1
    );
    assert_eq!(editor.read_with(cx, |p, _| p.selection().head), 8);
    editor.update_in(cx, |p, w, cx| p.undo(w, cx));
    draw(cx);
    assert_eq!(durable(&e).0, "前α😀後末\n");
    editor.update_in(cx, |p, w, cx| p.redo(w, cx));
    draw(cx);
    assert_eq!(durable(&e), (text.clone(), marks.clone()));
    cx.update(|w, _| w.remove_window());
    cx.run_until_parked();
    drop(editor);
    drop(view);
    cx.cx.update(|_| {});
    cx.run_until_parked();
    let Env {
        _dir,
        ws,
        book,
        entry,
        doc,
    } = e;
    ws.shutdown().unwrap();
    let ws = Workspace::open_dir(_dir.path(), "test").unwrap();
    let reopened = Env {
        _dir,
        ws,
        book,
        entry,
        doc,
    };
    assert_eq!(durable(&reopened), (text, marks));
}
#[gpui::test]
fn malformed_paste_and_stale_copy_cannot_authorize_overwriting_new_body(cx: &mut TestAppContext) {
    let e = env();
    let (_view, editor, cx) = open(cx, &e, &e.doc);
    editor.update_in(cx, |p, w, cx| p.select(0, 1..4, w, cx));
    cx.update(|w, cx| assert!(copy(&editor, false, w, cx)));
    let item = cx.read_from_clipboard().unwrap();
    cx.write_to_clipboard(ClipboardItem::new_string_with_json_metadata(
        "x".into(),
        json!({KEY:{"version":1,"text":"x","marks":[[0,2,"entity:x",["string","bad"]]]}}),
    ));
    let before = e.ws.observe(&e.doc).unwrap();
    cx.update(|w, cx| assert!(paste(&editor, w, cx)));
    assert_eq!(e.ws.observe(&e.doc).unwrap().version, before.version);
    cx.write_to_clipboard(item);
    e.ws.call(&Actor::User,"module.set_prose",json!({"book":e.book,"owner":e.entry,"module":"mod-prose","paragraphs":[{"text":"concurrent author value"}]})).unwrap();
    let current = e.ws.observe(&e.doc).unwrap();
    // No event pump: the visible selection is deliberately still the old one.
    cx.update(|w, cx| assert!(copy(&editor, false, w, cx)));
    cx.update(|w, cx| assert!(paste(&editor, w, cx)));
    assert_eq!(e.ws.observe(&e.doc).unwrap().version, current.version);
    assert_eq!(durable(&e).0, "concurrent author value\n");
}
#[gpui::test]
fn real_table_grid_and_cell_text_clipboard_keep_module_and_binary_on_disk(cx: &mut TestAppContext) {
    let e = env();
    let material =
        e.ws.call(
            &Actor::User,
            "material.create",
            json!({"book":e.book,"kind":"text","title":"Synthetic note"}),
        )
        .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
    let doc = format!("material:{material}");
    let (view, _body, cx) = open(cx, &e, &doc);
    let embeds = view.read_with(cx, |v, _| v.note_embeds().unwrap().clone());
    let link_key = format!("entity:{}", e.entry);
    let cells = vec![vec!["α😀後".to_owned(), "outside".to_owned()]];
    let marks = vec![vec![vec![(0, 3, link_key.clone(), raw("second"))], vec![]]];
    let item = crate::table::clip::table_item(&cells, &marks).unwrap();
    cx.write_to_clipboard(item);
    let item = cx.read_from_clipboard().unwrap();
    let decoded = crate::table::clip::marks_from_clipboard(&item).unwrap();
    assert_eq!(decoded, marks);
    cx.update(|w, cx| crate::embeds::insert_table(&embeds, 0, cells, decoded, w, cx));
    draw(cx);
    let table = embeds.tables()[0].clone();
    let (r, c, id) = table.read_with(cx, |t, _| {
        (
            t.rows()[0].id.clone(),
            t.cols()[0].id.clone(),
            t.embed().clone(),
        )
    });
    let cell = table.read_with(cx, |t, _| t.cell_editor(0, 0).unwrap().clone());
    cell.update_in(cx, |p, w, cx| {
        p.focus_at(0, 0, w, cx);
        p.select(0, 0..3, w, cx);
    });
    cx.update(|w, cx| assert!(copy(&cell, false, w, cx)));
    cell.update_in(cx, |p, w, cx| p.select(0, 3..3, w, cx));
    cx.update(|w, cx| assert!(paste(&cell, w, cx)));
    draw(cx);
    let d = e.ws.library().load_copy(&doc).unwrap();
    let pid = dr_model::DocId::parse(&doc).unwrap();
    let p = dr_doc::prose::BorrowedProse::new(&d, &pid).unwrap();
    let copied = p
        .view()
        .copy_table_cell_entity_links_v3(&id, &r, &c, 0..6)
        .unwrap();
    assert_eq!(copied.marks(), &[(0..6, link_key.clone(), raw("second"))]);
    assert_eq!(embeds.table_cells(id.as_str()).unwrap()[0][1], "outside");
    let opened = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let received = opened.clone();
    cx.update(|_, cx| {
        crate::links::set_v3_opener(cx, move |_, _, link, _| received.borrow_mut().push(link))
    });
    cell.update_in(cx, |p, w, cx| p.select(0, 0..0, w, cx));
    draw(cx);
    let point = cell.read_with(cx, |p, _| p.range_bounds(0, 0..1).unwrap().center());
    cx.simulate_click(point, gpui::Modifiers::none());
    draw(cx);
    assert_eq!(opened.borrow().len(), 1);
    assert_eq!(
        opened.borrow()[0].module.as_ref().unwrap().as_str(),
        "second"
    );
    assert_eq!(
        opened.borrow()[0].block.as_ref().unwrap().as_str(),
        "block-a"
    );
    assert_eq!(
        opened.borrow()[0].end_block.as_ref().unwrap().as_str(),
        "block-b"
    );
}

#[gpui::test]
fn unsupported_typed_clipboard_preserves_selection_values_and_versions(cx: &mut TestAppContext) {
    let e = env();
    let (_view, editor, cx) = open(cx, &e, &e.doc);
    editor.update_in(cx, |p, w, cx| p.select(0, 1..4, w, cx));
    let notices = std::rc::Rc::new(std::cell::Cell::new(0));
    let seen = notices.clone();
    cx.update(|_, cx| crate::links::set_clipboard_refusal(cx, move |_| seen.set(seen.get() + 1)));
    let before = e.ws.observe(&e.doc).unwrap();
    let data = durable(&e);
    for (key, value) in [
        ("entity:future", json!(["container", "future-reference"])),
        ("code", json!(["bool", true])),
    ] {
        cx.write_to_clipboard(ClipboardItem::new_string_with_json_metadata(
            "x".into(),
            json!({KEY:{"version":1,"text":"x","marks":[[0,1,key,value]]}}),
        ));
        cx.update(|w, cx| assert!(paste(&editor, w, cx)));
        assert_eq!(
            cx.read_from_clipboard().unwrap().text().as_deref(),
            Some("x")
        );
        assert_eq!(editor.read_with(cx, |p, _| p.selection().range()), 1..4);
        assert_eq!(e.ws.observe(&e.doc).unwrap().version, before.version);
        assert_eq!(durable(&e), data);
    }
    cx.write_to_clipboard(ClipboardItem::new_string_with_metadata(
        "x".into(),
        "{\"drifting_prose_v3\":".into(),
    ));
    cx.update(|w, cx| assert!(paste(&editor, w, cx)));
    assert_eq!(e.ws.observe(&e.doc).unwrap().version, before.version);
    assert_eq!(editor.read_with(cx, |p, _| p.selection().range()), 1..4);
    assert_eq!(notices.get(), 3);
}
