//! A material note's editor (M19's note profile) on a real workspace:
//! tables (cells, Tab, Enter, rows and columns, one undo history, the
//! clipboard), highlights, and embedded materials.

use dr_editor::assist::{MenuKind, MenuRow, NoteChoice};
use dr_editor::table::TableView;
use dr_editor::{ChapterEditor, EditorSettings, MaterialOpened};
use dr_store::Library;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{
    ClipboardItem, Entity, EntityInputHandler, Focusable, TestAppContext, VisualTestContext, px,
    size,
};
use gpui_prose::ProseEditor;
use gpui_prose::input::actions::{
    Copy, IndentListItem, MoveDown, Newline, OutdentListItem, Paste, Undo,
};
use serde_json::{Value, json};

const OBJ: &str = "\u{FFFC}";

struct Env {
    dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
}

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let book = out(&ws, "book.create", json!({"name": "笔记"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Env { dir, ws, book }
}

/// A text material whose note reads `text`: its document id.
fn note(e: &Env, text: &str) -> String {
    let id = out(
        &e.ws,
        "material.create",
        json!({"book": e.book, "kind": "text", "title": "读书笔记", "text": text}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    format!("material:{id}")
}

/// A small synthetic PNG (a warm gradient).
fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        let data: Vec<u8> = (0..height)
            .flat_map(|y| {
                (0..width).flat_map(move |x| {
                    [
                        (200 + 40 * x / width) as u8,
                        (150 + 60 * y / height) as u8,
                        (110 + 30 * (x + y) / (width + height)) as u8,
                    ]
                })
            })
            .collect();
        writer.write_image_data(&data).unwrap();
    }
    bytes
}

/// An image material with a synthetic picture: its id.
fn image_material(e: &Env, title: &str) -> String {
    let bytes = png(64, 40);
    let file = e.dir.path().join("picture.png");
    std::fs::write(&file, &bytes).unwrap();
    let asset = dr_model::id::new_uuid_v7();
    let record =
        e.ws.library()
            .import_asset(&dr_store::asset::SourceImport {
                book_id: &e.book,
                asset_id: &asset,
                source: &file,
                mime: "image/png",
                ext: "png",
                dimensions: Some((64, 40)),
                limit: 1 << 20,
            })
            .unwrap();
    out(
        &e.ws,
        "asset.put",
        json!({"book": e.book, "id": asset, "kind": "image", "mime": "image/png",
               "size": bytes.len(), "sha256": record.sha256, "width": 64, "height": 40}),
    );
    out(
        &e.ws,
        "material.create",
        json!({"book": e.book, "kind": "image", "title": title, "asset": asset}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

struct Open<'a> {
    view: Entity<ChapterEditor>,
    editor: Entity<ProseEditor>,
    cx: &'a mut VisualTestContext,
}

fn open<'a>(cx: &'a mut TestAppContext, e: &Env, doc: &str) -> Open<'a> {
    let (ws, book, doc) = (e.ws.clone(), e.book.clone(), doc.to_owned());
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        ChapterEditor::open(ws, &book, &doc, EditorSettings::default(), window, cx).unwrap()
    });
    cx.simulate_resize(size(px(900.), px(800.)));
    draw(cx);
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    let focus = editor.read_with(cx, |e, cx| e.focus_handle(cx));
    cx.update(|window, cx| window.focus(&focus, cx));
    draw(cx);
    Open { view, editor, cx }
}

impl Open<'_> {
    fn caret(&mut self, at: usize) {
        self.editor
            .update_in(self.cx, |e, window, cx| e.select(0, at..at, window, cx));
        draw(self.cx);
    }

    /// Types into whichever editor has the focus (the body or a cell).
    fn type_text(&mut self, text: &str) {
        for c in text.chars() {
            let s = c.to_string();
            let editor = self
                .view
                .update_in(self.cx, |v, window, cx| v.focused_prose(window, cx))
                .expect("an editor has the focus");
            editor.update_in(self.cx, |e, window, cx| {
                e.replace_text_in_range(None, &s, window, cx)
            });
        }
        draw(self.cx);
    }

    fn lines(&mut self) -> Vec<String> {
        self.editor.read_with(self.cx, |e, _| {
            let doc = &e.book().chapters[0].doc;
            (0..doc.visible_lines())
                .map(|l| doc.line(l).text.to_string())
                .collect()
        })
    }

    fn table(&mut self) -> Entity<TableView> {
        self.view.read_with(self.cx, |v, _| {
            v.note_embeds().expect("a note").tables()[0].clone()
        })
    }

    fn cells(&mut self) -> Vec<Vec<String>> {
        let table = self.table();
        table.read_with(self.cx, |t, cx| t.texts(cx))
    }

    /// The table's cells as stored.
    fn stored(&mut self) -> Vec<Vec<String>> {
        let table = self.table();
        let id = table.read_with(self.cx, |t, _| t.embed().to_string());
        self.view.read_with(self.cx, |v, _| {
            v.note_embeds().unwrap().table_cells(&id).unwrap()
        })
    }

    /// The focused cell: `(row, column)`.
    fn focused_cell(&mut self) -> Option<(usize, usize)> {
        let table = self.table();
        let focused = self
            .view
            .update_in(self.cx, |v, window, cx| v.focused_prose(window, cx))?;
        table.read_with(self.cx, |t, _| {
            (0..t.rows().len())
                .flat_map(|r| (0..t.cols().len()).map(move |c| (r, c)))
                .find(|&(r, c)| t.cell_editor(r, c) == Some(&focused))
        })
    }

    fn action(&mut self, action: impl gpui::Action) {
        self.cx.dispatch_action(action);
        draw(self.cx);
    }

    fn slash(&mut self, query: &str) -> Vec<MenuRow> {
        self.type_text(&format!("/{query}"));
        let assist = self.view.read_with(self.cx, |v, _| v.assist().clone());
        assist.read_with(self.cx, |a, _| {
            a.menu()
                .filter(|m| m.kind == MenuKind::Slash)
                .map(|m| m.rows.clone())
                .unwrap_or_default()
        })
    }

    /// A 3 × 3 table from the slash menu at the caret.
    fn slash_table(&mut self) {
        let rows = self.slash("表格");
        assert_eq!(rows, [MenuRow::Note(NoteChoice::Table)]);
        self.action(Newline);
    }
}

#[gpui::test]
fn the_slash_menu_of_a_note_has_its_own_entries(cx: &mut TestAppContext) {
    let e = env();
    let doc = note(&e, "");
    let mut o = open(cx, &e, &doc);
    let rows = o.slash("");
    let labels: Vec<&str> = rows
        .iter()
        .map(|r| match r {
            MenuRow::Block(b) => b.label(),
            MenuRow::Note(n) => n.label(),
            MenuRow::Action(a) => a.label(),
            _ => "",
        })
        .collect();
    assert_eq!(
        labels,
        [
            "正文",
            "一级标题",
            "二级标题",
            "三级标题",
            "引用",
            "分隔线",
            "无序列表",
            "有序列表",
            "待办清单",
            "表格",
            "代码块",
            "提示块",
            "高亮",
            "插入素材…",
            "人物链接",
            "批注"
        ]
    );
}

#[gpui::test]
fn a_table_from_the_slash_menu_and_tab_through_its_cells(cx: &mut TestAppContext) {
    let e = env();
    let doc = note(&e, "");
    let mut o = open(cx, &e, &doc);
    o.slash_table();
    assert_eq!(o.lines(), [OBJ, ""], "the table, then a paragraph to go on");
    assert_eq!(o.cells(), vec![vec![String::new(); 3]; 3]);
    assert_eq!(
        o.focused_cell(),
        Some((0, 0)),
        "the caret in the first cell"
    );
    o.type_text("甲");
    o.action(IndentListItem);
    assert_eq!(o.focused_cell(), Some((0, 1)));
    o.type_text("乙");
    o.action(OutdentListItem);
    assert_eq!(o.focused_cell(), Some((0, 0)));
    assert_eq!(o.stored()[0], ["甲", "乙", ""]);
    // Tab in the last cell: a new row.
    let table = o.table();
    table.update_in(o.cx, |t, window, cx| t.focus_cell(2, 2, false, window, cx));
    o.action(IndentListItem);
    assert_eq!(o.focused_cell(), Some((3, 0)));
    assert_eq!(o.stored().len(), 4);
}

#[gpui::test]
fn enter_breaks_a_cells_line_and_arrows_leave_the_table(cx: &mut TestAppContext) {
    let e = env();
    let doc = note(&e, "");
    let mut o = open(cx, &e, &doc);
    o.slash_table();
    o.type_text("一");
    o.action(Newline);
    o.type_text("二");
    assert_eq!(
        o.stored()[0][0],
        "一\u{2028}二",
        "a line break, not a paragraph"
    );
    // ↓ from the last row: the paragraph after the table.
    let table = o.table();
    table.update_in(o.cx, |t, window, cx| t.focus_cell(2, 1, false, window, cx));
    o.action(MoveDown);
    assert_eq!(o.focused_cell(), None);
    let (focused, head) = o.view.update_in(o.cx, |v, window, cx| {
        let e = v.editor().read(cx);
        (e.focus_handle(cx).is_focused(window), e.selection().head)
    });
    assert!(focused, "the body has the caret");
    assert_eq!(head, 2, "at the start of the paragraph after the table");
}

#[gpui::test]
fn a_notes_cells_and_text_undo_in_one_history(cx: &mut TestAppContext) {
    let e = env();
    let doc = note(&e, "");
    let mut o = open(cx, &e, &doc);
    o.slash_table();
    // The body after the table, then a cell.
    o.caret(2);
    let focus = o.editor.read_with(o.cx, |e, cx| e.focus_handle(cx));
    o.cx.update(|window, cx| window.focus(&focus, cx));
    o.type_text("前");
    let table = o.table();
    table.update_in(o.cx, |t, window, cx| t.focus_cell(1, 1, false, window, cx));
    o.type_text("格");
    assert_eq!(o.stored()[1][1], "格");
    // ⌘Z in the cell: the cell's typing first, then the body's.
    o.action(Undo);
    assert_eq!(o.stored()[1][1], "");
    assert_eq!(o.cells()[1][1], "", "the cell's editor caught up");
    assert_eq!(o.lines(), [OBJ, "前"]);
    o.action(Undo);
    assert_eq!(o.lines(), [OBJ, ""]);
    // A row the bar added is a step too.
    table.update_in(o.cx, |t, window, cx| t.add_row(0, window, cx));
    assert_eq!(o.stored().len(), 4);
    o.action(Undo);
    draw(o.cx);
    assert_eq!(o.stored().len(), 3);
    // And the table itself.
    o.action(Undo);
    assert_eq!(o.lines(), [""]);
}

#[gpui::test]
fn the_bar_adds_and_deletes_rows_columns_and_the_table(cx: &mut TestAppContext) {
    let e = env();
    let doc = note(&e, "");
    let mut o = open(cx, &e, &doc);
    o.slash_table();
    let table = o.table();
    table.update_in(o.cx, |t, window, cx| {
        t.add_col(0, window, cx);
        t.delete_row(2, window, cx);
    });
    let (rows, cols) = table.read_with(o.cx, |t, _| (t.rows().len(), t.cols().len()));
    assert_eq!((rows, cols), (2, 4));
    table.update_in(o.cx, |t, window, cx| t.delete_col(3, window, cx));
    assert_eq!(table.read_with(o.cx, |t, _| t.cols().len()), 3);
    table.update_in(o.cx, |t, window, cx| t.delete_table(window, cx));
    draw(o.cx);
    assert_eq!(o.lines(), [""], "the table's paragraph went");
}

#[gpui::test]
fn tables_on_the_clipboard(cx: &mut TestAppContext) {
    let e = env();
    let doc = note(&e, "");
    let mut o = open(cx, &e, &doc);
    o.slash_table();
    // A grid pasted into a cell fills from there, growing the table.
    o.cx.write_to_clipboard(ClipboardItem::new_string("甲\t乙\n丙\t丁\n戊\t己".into()));
    let table = o.table();
    table.update_in(o.cx, |t, window, cx| t.focus_cell(1, 2, false, window, cx));
    o.action(Paste);
    let stored = o.stored();
    assert_eq!(stored.len(), 4);
    assert_eq!(stored[1][2..], ["甲", "乙"]);
    assert_eq!(stored[3][2..], ["戊", "己"]);
    // The table selected in the text copies as a table…
    o.editor
        .update_in(o.cx, |e, window, cx| e.select_embed(0, 0, window, cx));
    o.action(Copy);
    let item = o.cx.read_from_clipboard().unwrap();
    assert!(item.text().unwrap().starts_with("\t\t\t\n"));
    assert_eq!(
        dr_editor::table::clip::table_from_clipboard(&item).map(|c| c.len()),
        Some(4)
    );
    // …and pastes as a new one after the caret's paragraph.
    o.caret(2);
    o.action(Paste);
    assert_eq!(o.lines(), [OBJ, OBJ, ""]);
    // Tab-separated text of 2 × 2 or more becomes a table; one line stays text.
    let focus = o.editor.read_with(o.cx, |e, cx| e.focus_handle(cx));
    o.cx.update(|window, cx| window.focus(&focus, cx));
    o.caret(4);
    o.cx.write_to_clipboard(ClipboardItem::new_string("名\t值".into()));
    o.action(Paste);
    assert_eq!(o.lines(), [OBJ, OBJ, "名\t值"]);
}

#[gpui::test]
fn highlights_by_key_slash_and_markdown(cx: &mut TestAppContext) {
    let e = env();
    let doc = note(&e, "重点在这里");
    let mut o = open(cx, &e, &doc);
    let highlighted = |o: &mut Open<'_>, at: usize| {
        o.editor.update(o.cx, |e, _| {
            e.marks_at(0, at)
                .get(gpui_prose::schema::inline::HIGHLIGHT)
                .cloned()
        })
    };
    o.editor
        .update_in(o.cx, |e, window, cx| e.select(0, 0..2, window, cx));
    o.view
        .update_in(o.cx, |v, window, cx| v.toggle_highlight(window, cx));
    o.cx.executor()
        .advance_clock(std::time::Duration::from_secs(1));
    draw(o.cx);
    assert_eq!(highlighted(&mut o, 1), Some("".into()), "the one highlight");
    assert_eq!(highlighted(&mut o, 3), None);
    let drawn = o.editor.read_with(o.cx, |e, _| {
        e.painted_decoration(0, dr_editor::highlight::GROUP, "h0")
            .is_some()
    });
    assert!(drawn, "drawn as the highlighter's swash");
    // `==text==` as typed.
    o.caret(5);
    o.type_text("，==再看==");
    assert_eq!(o.lines(), ["重点在这里，再看"]);
    assert_eq!(highlighted(&mut o, 7), Some("".into()));
    // The slash menu's 高亮: for what is typed next.
    o.type_text("。");
    let rows = o.slash("高亮");
    assert_eq!(rows, [MenuRow::Note(NoteChoice::Highlight)]);
    o.action(Newline);
    o.type_text("新");
    assert_eq!(o.lines(), ["重点在这里，再看。新"]);
    assert_eq!(highlighted(&mut o, 9), Some("".into()));
    assert_eq!(highlighted(&mut o, 8), None, "only what came after it");
}

#[gpui::test]
fn an_embedded_material_shows_and_opens(cx: &mut TestAppContext) {
    let e = env();
    let picture = image_material(&e, "码头旧照");
    let doc = note(&e, "看图：");
    let mut o = open(cx, &e, &doc);
    o.caret(3);
    let rows = o.slash("素材");
    assert_eq!(rows, [MenuRow::Note(NoteChoice::Material)]);
    o.action(Newline);
    let assist = o.view.read_with(o.cx, |v, _| v.assist().clone());
    let picker = assist.read_with(o.cx, |a, _| a.menu().map(|m| (m.kind, m.rows.clone())));
    assert_eq!(
        picker,
        Some((
            MenuKind::Material,
            vec![MenuRow::Material {
                id: picture.clone(),
                title: "码头旧照".into(),
                pdf: false,
            }]
        ))
    );
    let opened = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let seen = opened.clone();
    o.cx.update(|_, cx| {
        cx.subscribe(&o.view, move |_, event: &MaterialOpened, _| {
            seen.borrow_mut().push(event.material.clone())
        })
        .detach()
    });
    o.action(Newline);
    assert_eq!(o.lines(), ["看图：", OBJ, ""]);
    // Its view knows the picture; opening it goes to the host.
    let block = o.view.read_with(o.cx, |v, cx| {
        let id = v.editor().read(cx).embed_at(0, 1).unwrap().0;
        v.note_embeds().unwrap().material_block(&id).expect("drawn")
    });
    let facts = block.update(o.cx, |b, _| b.facts().cloned()).unwrap();
    assert_eq!(
        (facts.title.as_str(), facts.kind.as_str()),
        ("码头旧照", "image")
    );
    assert!(facts.picture.is_some_and(|p| p.exists()));
    block.update(o.cx, |b, cx| b.open(cx));
    draw(o.cx);
    assert_eq!(*opened.borrow(), [picture]);
    // Copied with the text around it: its title.
    o.editor
        .update_in(o.cx, |e, window, cx| e.select(0, 0..6, window, cx));
    o.action(Copy);
    assert_eq!(
        o.cx.read_from_clipboard().and_then(|i| i.text()).as_deref(),
        Some("看图：\n码头旧照\n")
    );
}

#[gpui::test]
fn a_chapter_has_none_of_it(cx: &mut TestAppContext) {
    let e = env();
    let id = out(
        &e.ws,
        "chapter.create",
        json!({"book": e.book, "title": "一", "text": ""}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut o = open(cx, &e, &format!("node:{id}"));
    assert!(o.view.read_with(o.cx, |v, _| v.note_embeds().is_none()));
    assert_eq!(o.slash("表格"), [], "no table in a chapter's slash menu");
    o.type_text(" ==字==");
    assert_eq!(o.lines(), ["/表格 ==字=="], "== stays literal");
}
