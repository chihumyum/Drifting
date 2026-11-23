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
fn note_doc(e: &Env, title: &str) -> String {
    let id =
        e.ws.call(
            &Actor::User,
            "entry.create",
            json!({"book":e.book,"template":"tpl-note","title":title,"bodies":{"mod-prose":""}}),
        )
        .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
    format!("body:{id}/mod-prose")
}

#[gpui::test]
fn real_table_grid_and_cell_text_clipboard_keep_module_and_binary_on_disk(cx: &mut TestAppContext) {
    let e = env();
    let doc = note_doc(&e, "Synthetic note");
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
    // A link into a module and a block is the author's (automatic linking
    // never writes one): it opens though the chapter's own 「自动链接」 is
    // off, as a chapter's starts (`kernel-v5.md` §16).
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
    // A fresh grid read for copying does not authorize the old displayed
    // selection to overwrite an equally sized peer update.
    let (table_id, row, col) = (id.clone(), r.clone(), c.clone());
    e.ws.prose_session(&doc)
        .unwrap()
        .edit(move |t| t.table(&table_id)?.set_cell(&row, &col, "peer!!"))
        .unwrap();
    let before = e.ws.observe(&doc).unwrap().version;
    let _fresh = embeds.table_grid(id.as_str()).unwrap();
    table.update_in(cx, |t, w, cx| {
        t.paste_marked(0, 0, vec![vec!["stale!".into()]], vec![], w, cx)
    });
    assert_eq!(e.ws.observe(&doc).unwrap().version, before);
    assert_eq!(
        embeds.table_cells(id.as_str()).unwrap()[0],
        vec!["peer!!".to_owned(), "outside".to_owned()]
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
        ("unknown", json!(["bool", true])),
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
    // Unified prose profile: `code` and `highlight` marks paste cleanly into an entry body.
    cx.write_to_clipboard(ClipboardItem::new_string_with_json_metadata(
        "码亮".into(),
        json!({KEY:{"version":1,"text":"码亮","marks":[
            [0,1,"code",["bool",true]],
            [1,2,"highlight",["string",""]]
        ]}}),
    ));
    cx.update(|w, cx| assert!(paste(&editor, w, cx)));
    draw(cx);
    assert_eq!(notices.get(), 3);
    assert_eq!(durable(&e).0, "前码亮末\n");
    editor.read_with(cx, |p, _| {
        let doc = &p.book().chapters[0].doc;
        assert!(doc.range_has_mark(1..2, "code"));
        assert!(doc.range_has_mark(2..3, "highlight"));
    });
}

#[gpui::test]
fn v3_typing_over_selected_cells_replaces_the_range_and_undoes_once(cx: &mut TestAppContext) {
    use gpui::EntityInputHandler as _;
    let e = env();
    let doc = note_doc(&e, "Synthetic selected cells");
    let (view, body, cx) = open(cx, &e, &doc);
    let embeds = view.read_with(cx, |v, _| v.note_embeds().unwrap().clone());
    let cells = vec![
        vec!["好".to_owned(), "outside".to_owned()],
        vec!["好".to_owned(), "outside two".to_owned()],
    ];
    let marks = vec![
        vec![
            vec![],
            vec![(0, 7, "entity:future".into(), raw("unknown-module"))],
        ],
        vec![vec![], vec![]],
    ];
    cx.update(|w, cx| crate::embeds::insert_table(&embeds, 0, cells.clone(), marks, w, cx));
    draw(cx);
    let table = embeds.tables()[0].clone();
    let id = table.read_with(cx, |t, _| t.embed().to_string());
    let before = embeds.table_grid(&id).unwrap();
    table.update_in(cx, |t, w, cx| {
        t.focus_cell(0, 0, true, w, cx);
        t.select_cells((0, 0), (1, 0), w, cx);
    });
    draw(cx);
    assert_eq!(
        table.read_with(cx, |t, _| t.selected_cells()),
        Some((0..2, 0..1))
    );
    let input = table.read_with(cx, |t, _| t.cell_editor(0, 0).unwrap().clone());
    input.update_in(cx, |p, w, cx| p.replace_text_in_range(None, "新", w, cx));
    draw(cx);
    assert_eq!(
        embeds.table_cells(&id).unwrap(),
        vec![
            vec!["新".to_owned(), "outside".to_owned()],
            vec!["".to_owned(), "outside two".to_owned()]
        ]
    );
    assert_eq!(table.read_with(cx, |t, _| t.selected_cells()), None);
    assert_eq!(embeds.table_grid(&id).unwrap().1[0][1], before.1[0][1]);
    cx.update(|w, cx| assert!(input.read(cx).focus_handle(cx).is_focused(w)));
    cx.dispatch_action(gpui_prose::input::actions::Undo);
    draw(cx);
    assert_eq!(embeds.table_grid(&id).unwrap(), before);
    // A successful own paste (including a no-op value) and format operation
    // may advance this selection only through their exact acknowledged state.
    table.update_in(cx, |t, w, cx| {
        t.focus_cell(0, 0, true, w, cx);
        t.select_cells((0, 0), (1, 0), w, cx);
    });
    draw(cx);
    cx.write_to_clipboard(ClipboardItem::new_string("好".into()));
    cx.dispatch_action(gpui_prose::input::actions::Paste);
    draw(cx);
    cx.dispatch_action(gpui_prose::input::actions::ToggleBold);
    draw(cx);
    assert_eq!(
        table.read_with(cx, |t, _| t.selected_cells()),
        Some((0..2, 0..1))
    );
    let formatted = embeds.table_grid(&id).unwrap();
    input.update_in(cx, |p, w, cx| p.replace_text_in_range(None, "再", w, cx));
    draw(cx);
    assert_eq!(
        embeds.table_cells(&id).unwrap(),
        vec![
            vec!["再".to_owned(), "outside".to_owned()],
            vec!["".to_owned(), "outside two".to_owned()]
        ]
    );
    cx.dispatch_action(gpui_prose::input::actions::Undo);
    draw(cx);
    assert_eq!(embeds.table_grid(&id).unwrap(), formatted);

    assert_eq!(
        body.read_with(cx, |p, _| p.book().chapters[0].doc.plain_text())
            .matches('\u{fffc}')
            .count(),
        1
    );
}

/// The body's paragraphs as stored: text, heading level, list kind.
fn stored(e: &Env, doc: &str) -> Vec<(String, Option<i64>, Option<String>)> {
    let d = e.ws.library().load_copy(doc).unwrap();
    let id = dr_model::DocId::parse(doc).unwrap();
    let p = dr_doc::prose::BorrowedProse::new(&d, &id).unwrap();
    p.view()
        .paragraphs()
        .map(|p| {
            (
                p.text(),
                p.attrs.heading.map(|h| h.level()),
                p.attrs.list.as_ref().map(|l| l.as_str().to_owned()),
            )
        })
        .collect()
}

/// What another program put on the clipboard: its plain text through
/// GPUI's (test) clipboard, its HTML through the reader the app sets.
fn other_program(cx: &mut VisualTestContext, text: &str, html: &'static str) {
    cx.write_to_clipboard(ClipboardItem::new_string(text.into()));
    cx.update(|_, cx| set_clipboard_html(cx, move || Some(html.to_owned())));
}

const FORMATTED: &str = r#"<meta charset="utf-8"><h2 style="color:#333">标题</h2><p>有<b>粗体</b>和<a href="https://example.com/">链接</a><img src="https://example.com/a.png"><script>alert(1)</script></p><ul><li>一</li><li>二</li></ul>"#;

#[gpui::test]
fn formatted_text_from_another_program_keeps_the_body_formats(cx: &mut TestAppContext) {
    let e = env();
    let (_view, editor, cx) = open(cx, &e, &e.doc);
    editor.update_in(cx, |p, w, cx| {
        p.select(0, 5..5, w, cx);
        p.press_enter(w, cx);
    });
    draw(cx);
    let (before_text, before_links) = durable(&e);
    other_program(cx, "标题\n有粗体和链接\n一\n二", FORMATTED);
    cx.dispatch_action(gpui_prose::input::actions::Paste);
    draw(cx);
    assert_eq!(
        stored(&e, &e.doc),
        [
            ("前α😀後末".into(), None, None),
            ("标题".into(), Some(2), None),
            ("有粗体和链接".into(), None, None),
            ("一".into(), None, Some("bullet".into())),
            ("二".into(), None, Some("bullet".into())),
        ]
    );
    let (text, links) = durable(&e);
    assert_eq!(
        links.marks(),
        before_links.marks(),
        "the entity links around it stay, and none come in"
    );
    editor.read_with(cx, |p, _| {
        let doc = &p.book().chapters[0].doc;
        let at = doc.line_start(2);
        assert!(doc.range_has_mark(at + 1..at + 3, "bold"));
        assert!(!doc.range_has_mark(at..at + 1, "bold"));
        assert!(doc.range_has_mark(at + 4..at + 6, "link"));
        assert_eq!(
            doc.line(2)
                .spans
                .iter()
                .filter_map(|s| s.marks.link())
                .collect::<Vec<_>>(),
            ["https://example.com/"]
        );
        // The caret after the pasted text.
        assert_eq!(p.selection().head, doc.line_start(4) + 1);
    });
    // One undo takes the whole paste back.
    cx.dispatch_action(gpui_prose::input::actions::Undo);
    draw(cx);
    assert_eq!(durable(&e), (before_text, before_links));
    assert_ne!(text, durable(&e).0);
}

#[gpui::test]
fn without_a_reader_or_into_a_code_line_or_a_cell_only_the_text(cx: &mut TestAppContext) {
    let e = env();
    // No reader (tests, examples): the plain text, as before.
    let (_view, editor, cx) = open(cx, &e, &e.doc);
    editor.update_in(cx, |p, w, cx| p.select(0, 0..7, w, cx));
    cx.write_to_clipboard(ClipboardItem::new_string("标题\n有粗体".into()));
    cx.dispatch_action(gpui_prose::input::actions::Paste);
    draw(cx);
    assert_eq!(
        stored(&e, &e.doc),
        [("标题".into(), None, None), ("有粗体".into(), None, None)]
    );
    // Into a code line: the plain text.
    editor.update_in(cx, |p, w, cx| {
        p.edit_chapter(0, gpui_prose::HostStep::Own, w, cx, |doc| {
            doc.set_block_attr(
                1,
                gpui_prose::schema::block::CODE_BLOCK,
                Some("".into()),
                ORIGIN_USER,
            );
            None
        });
        p.select(0, 3..6, w, cx);
    });
    draw(cx);
    other_program(cx, "<b>x</b>", "<p><b>x</b></p><h1>y</h1>");
    cx.dispatch_action(gpui_prose::input::actions::Paste);
    draw(cx);
    assert_eq!(stored(&e, &e.doc)[1].0, "<b>x</b>");
    editor.read_with(cx, |p, _| {
        assert!(!p.book().chapters[0].doc.range_has_mark(3..4, "bold"));
    });
}

#[gpui::test]
fn another_programs_table_keeps_its_cells_formats(cx: &mut TestAppContext) {
    let e = env();
    let doc = note_doc(&e, "Synthetic table paste");
    let (view, _body, cx) = open(cx, &e, &doc);
    let embeds = view.read_with(cx, |v, _| v.note_embeds().unwrap().clone());
    // A spreadsheet's copy: tab-separated text, and its HTML with classes.
    other_program(
        cx,
        "名字\t年龄\n安\t30\n",
        r#"<style>.xl65 {font-weight:700}</style><table><tr><td class=xl65>名字</td><td class=xl65>年龄</td></tr><tr><td><a href="https://example.com/">安</a></td><td>30</td></tr></table>"#,
    );
    cx.dispatch_action(gpui_prose::input::actions::Paste);
    draw(cx);
    let table = embeds.tables()[0].clone();
    let id = table.read_with(cx, |t, _| t.embed().to_string());
    let (cells, marks) = embeds.table_grid(&id).unwrap();
    assert_eq!(cells, [["名字", "年龄"], ["安", "30"]]);
    assert_eq!(
        crate::table::clip::marks_at(&marks, 0, 0),
        [(0, 2, "bold".to_owned(), LoroValue::Bool(true))]
    );
    assert_eq!(crate::table::clip::marks_at(&marks, 0, 1).len(), 1);
    assert_eq!(
        crate::table::clip::marks_at(&marks, 1, 0),
        [(
            0,
            1,
            "link".to_owned(),
            LoroValue::from("https://example.com/")
        )]
    );
    assert!(crate::table::clip::marks_at(&marks, 1, 1).is_empty());
    // HTML that is not the same table: the cells stay plain.
    let rows = vec![
        vec!["名字".to_owned(), "年龄".to_owned()],
        vec!["安".to_owned(), "31".to_owned()],
    ];
    cx.update(|_, cx| assert_eq!(html_table_marks(cx, &rows), None));
}

#[gpui::test]
fn a_table_cell_takes_only_the_text(cx: &mut TestAppContext) {
    let e = env();
    let doc = note_doc(&e, "Synthetic formatted paste");
    let (view, _body, cx) = open(cx, &e, &doc);
    let embeds = view.read_with(cx, |v, _| v.note_embeds().unwrap().clone());
    let cells = vec![vec!["".to_owned(), "b".to_owned()]];
    cx.update(|w, cx| crate::embeds::insert_table(&embeds, 0, cells, Vec::new(), w, cx));
    draw(cx);
    let table = embeds.tables()[0].clone();
    let id = table.read_with(cx, |t, _| t.embed().to_string());
    let cell = table.read_with(cx, |t, _| t.cell_editor(0, 0).unwrap().clone());
    cell.update_in(cx, |p, w, cx| p.focus_at(0, 0, w, cx));
    draw(cx);
    other_program(cx, "粗", "<h1><b>粗</b></h1>");
    cx.dispatch_action(gpui_prose::input::actions::Paste);
    draw(cx);
    assert_eq!(embeds.table_cells(&id).unwrap()[0], ["粗", "b"]);
    let (_, marks) = embeds.table_grid(&id).unwrap();
    assert!(
        marks.iter().flatten().all(|cell| cell.is_empty()),
        "no bold from the HTML: {marks:?}"
    );
}

fn selected_cells_peer_case(cx: &mut TestAppContext, after_input: bool) {
    use gpui::EntityInputHandler as _;
    let e = env();
    let doc = note_doc(&e, "Synthetic concurrent selected cells");
    let (view, _body, cx) = open(cx, &e, &doc);
    let embeds = view.read_with(cx, |v, _| v.note_embeds().unwrap().clone());
    let cells = vec![
        vec!["好".to_owned(), "outside".to_owned()],
        vec!["好".to_owned(), "outside two".to_owned()],
    ];
    let marks = vec![
        vec![
            vec![],
            vec![(0, 7, "entity:future".into(), raw("unknown-module"))],
        ],
        vec![vec![], vec![]],
    ];
    cx.update(|w, cx| crate::embeds::insert_table(&embeds, 0, cells, marks, w, cx));
    draw(cx);
    let table = embeds.tables()[0].clone();
    let (id, row, col) = table.read_with(cx, |t, _| {
        (
            t.embed().clone(),
            t.rows()[1].id.clone(),
            t.cols()[0].id.clone(),
        )
    });
    let before = embeds.table_grid(id.as_str()).unwrap();
    table.update_in(cx, |t, w, cx| {
        t.focus_cell(0, 0, true, w, cx);
        t.select_cells((0, 0), (1, 0), w, cx);
    });
    draw(cx);
    let notices = std::rc::Rc::new(std::cell::Cell::new(0));
    let seen = notices.clone();
    cx.update(|_, cx| crate::links::set_clipboard_refusal(cx, move |_| seen.set(seen.get() + 1)));
    let input = table.read_with(cx, |t, _| t.cell_editor(0, 0).unwrap().clone());
    let handle =
        e.ws.library()
            .open_doc(&doc, dr_store::OpenDoc::Existing)
            .unwrap();
    let doc_id = dr_model::DocId::parse(&doc).unwrap();
    let peer = move || {
        let (result, _) = handle
            .write(
                dr_store::Origin::agent("synthetic-selected-peer", 1),
                move |d| {
                    let prose = dr_doc::prose::BorrowedProse::new(d, &doc_id)?;
                    prose.txn().table(&id)?.set_cell(&row, &col, "他")
                },
            )
            .unwrap();
        result.unwrap();
    };
    let mut peer = Some(peer);
    input.update_in(cx, |p, w, cx| {
        if !after_input {
            peer.take().unwrap()();
        }
        p.replace_text_in_range(None, "新", w, cx);
        // EditorEvent subscribers cannot run while this editor is borrowed.
        // This is a real intervening commit after durable input, before the
        // table's cleanup callback, without changing the selected cell count.
        if after_input {
            peer.take().unwrap()();
        }
    });
    draw(cx);
    let id = table.read_with(cx, |t, _| t.embed().to_string());
    assert_eq!(
        embeds.table_cells(&id).unwrap(),
        vec![
            vec!["好新".to_owned(), "outside".to_owned()],
            vec!["他".to_owned(), "outside two".to_owned()]
        ]
    );
    assert_eq!(notices.get(), 1, "a refused cleanup must report failure");
    assert_eq!(embeds.table_grid(&id).unwrap().1[0][1], before.1[0][1]);
    assert_eq!(table.read_with(cx, |t, _| t.selected_cells()), None);
    cx.update(|w, cx| assert!(input.read(cx).focus_handle(cx).is_focused(w)));
    cx.dispatch_action(gpui_prose::input::actions::Undo);
    draw(cx);
    assert_eq!(
        embeds.table_cells(&id).unwrap(),
        vec![
            vec!["好".to_owned(), "outside".to_owned()],
            vec!["他".to_owned(), "outside two".to_owned()]
        ]
    );
    assert_eq!(embeds.table_grid(&id).unwrap().1[0][1], before.1[0][1]);
}
#[gpui::test]
fn v3_selected_cells_reject_unseen_peer_before_input_without_losing_accepted_text(
    cx: &mut TestAppContext,
) {
    selected_cells_peer_case(cx, false);
}
#[gpui::test]
fn v3_selected_cells_reject_peer_between_input_and_cleanup_without_fresh_authority(
    cx: &mut TestAppContext,
) {
    selected_cells_peer_case(cx, true);
}
