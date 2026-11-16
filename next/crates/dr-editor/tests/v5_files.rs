//! Format-5 file embeds, slash file picker, drag/paste into prose, and
//! file-target inline links (`kernel-v5.md` §6, `v5-tracks.md` §T5).

use std::time::Duration;

use dr_doc::prose::FileEmbedLook;
use dr_editor::assist::{MenuKind, MenuRow, NoteChoice};
use dr_editor::decor::DecorLooks;
use dr_editor::entity_links::NameGroup;
use dr_editor::link_card::card_facts;
use dr_editor::{BookEditor, ChapterEditor, EditorSettings};
use dr_model::kind::EntityKind;
use dr_model::pos::{PosKey, cmp_pos};
use dr_model::v3::{EmbedAlign, EmbedSize};
use dr_store::Library;
use dr_text::autolink::LinkTarget;
use dr_ui::tokens::Palette;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{
    ClipboardItem, Entity, EntityInputHandler, Focusable, Image, ImageFormat, TestAppContext,
    VisualTestContext, hsla, px, size,
};
use gpui_prose::input::actions::{Copy, Cut, Newline, Paste, Undo};
use gpui_prose::render::RunStyle;
use gpui_prose::style::ProseStyle;
use gpui_prose::{ProseEditor, ProseExtension as _};
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
    let book = out(&ws, "project.create", json!({ "name": "航行集" }))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Env { dir, ws, book }
}

fn chapter(e: &Env, text: &str) -> (String, String, String) {
    let root = dr_testkit::seed::acceptance::novel_root(&e.ws, &e.book, "tpl-manuscript");
    let id = out(
        &e.ws,
        "entry.create",
        json!({
            "book": e.book,
            "parent": root,
            "template": "tpl-chapter",
            "title": "第一章",
            "bodies": { "mod-prose": text },
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = format!("body:{id}/mod-prose");
    (id, "mod-prose".to_owned(), doc)
}

fn png_with_seed(width: u32, height: u32, seed: u8) -> Vec<u8> {
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
                        seed.wrapping_add((x * 7) as u8),
                        seed.wrapping_add((y * 11) as u8),
                        seed.wrapping_add(((x + y) * 5) as u8),
                    ]
                })
            })
            .collect();
        writer.write_image_data(&data).unwrap();
    }
    bytes
}

fn put_image(e: &Env, title: &str, folder: Option<&str>, seed: u8) -> String {
    let bytes = png_with_seed(48, 36, seed);
    let file = e.dir.path().join(format!("{title}-{seed}.png"));
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
                dimensions: Some((48, 36)),
                limit: 1 << 20,
            })
            .unwrap();
    out(
        &e.ws,
        "asset.put",
        json!({
            "book": e.book,
            "id": asset,
            "name": title,
            "kind": "image",
            "mime": "image/png",
            "size": bytes.len(),
            "sha256": record.sha256,
            "width": 48,
            "height": 36,
            "folder": folder,
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn put_pdf(e: &Env, title: &str, folder: Option<&str>) -> String {
    let bytes = b"%PDF-1.4\n1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n2 0 obj<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>endobj\n3 0 obj<< /Type /Page /Parent 2 0 R >>endobj\n4 0 obj<< /Type /Page /Parent 2 0 R >>endobj\n%%EOF\n";
    let file = e.dir.path().join(format!("{title}.pdf"));
    std::fs::write(&file, bytes).unwrap();
    let asset = dr_model::id::new_uuid_v7();
    let record =
        e.ws.library()
            .import_asset(&dr_store::asset::SourceImport {
                book_id: &e.book,
                asset_id: &asset,
                source: &file,
                mime: "application/pdf",
                ext: "pdf",
                dimensions: None,
                limit: 1 << 20,
            })
            .unwrap();
    out(
        &e.ws,
        "asset.put",
        json!({
            "book": e.book,
            "id": asset,
            "name": title,
            "kind": "pdf",
            "mime": "application/pdf",
            "size": bytes.len(),
            "sha256": record.sha256,
            "folder": folder,
        }),
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
        let mut editor =
            ChapterEditor::open(ws, &book, &doc, EditorSettings::default(), window, cx).unwrap();
        editor.set_decor_looks(
            DecorLooks::new(&Palette::LIGHT, hsla(0.58, 0.7, 0.42, 1.), false),
            cx,
        );
        editor
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

    fn type_text(&mut self, text: &str) {
        for c in text.chars() {
            let s = c.to_string();
            self.editor.update_in(self.cx, |e, window, cx| {
                e.replace_text_in_range(None, &s, window, cx)
            });
        }
        draw(self.cx);
    }

    fn action(&mut self, action: impl gpui::Action) {
        self.cx.dispatch_action(action);
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
}

#[gpui::test]
fn chapter_slash_picker_loads_assets_once_and_filters_by_folder_and_query(cx: &mut TestAppContext) {
    let e = env();
    let maps = out(
        &e.ws,
        "asset_folder.create",
        json!({ "book": e.book, "name": "地图" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let sub = out(
        &e.ws,
        "asset_folder.create",
        json!({ "book": e.book, "name": "港口分卷", "parent": maps }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let _loose = put_image(&e, "人物草图", None, 10);
    let chart = put_image(&e, "北港海图", Some(&sub), 20);
    let log_pdf = put_pdf(&e, "航海日志", Some(&maps));

    let (_, _, doc) = chapter(&e, "");
    let mut o = open(cx, &e, &doc);
    o.type_text("/图片");
    let assist = o.view.read_with(o.cx, |v, _| v.assist().clone());
    let slash_rows = assist.read_with(o.cx, |a, _| a.menu().unwrap().rows.clone());
    assert_eq!(slash_rows, [MenuRow::Note(NoteChoice::Material)]);

    o.action(Newline);
    assert_eq!(
        assist.read_with(o.cx, |a, _| (
            a.menu().map(|m| m.kind),
            a.material_list_calls
        )),
        (Some(MenuKind::Material), 1),
        "opening the slash file picker calls asset.list once"
    );
    assert!(
        o.cx.update(|window, cx| !o.editor.read(cx).focus_handle(cx).is_focused(window)),
        "opening the slash file picker moves keyboard focus into its search field"
    );

    // Multiple renders and folder/query filters never call `asset.list` again.
    draw(o.cx);
    draw(o.cx);
    assist.update(o.cx, |a, cx| {
        a.set_material_picker_folder(Some(maps.clone()), cx)
    });
    draw(o.cx);
    let folder_ids: Vec<String> = assist.read_with(o.cx, |a, _| {
        a.menu()
            .unwrap()
            .rows
            .iter()
            .filter_map(|r| match r {
                MenuRow::Material { id, .. } => Some(id.clone()),
                _ => None,
            })
            .collect()
    });
    assert_eq!(
        folder_ids.len(),
        2,
        "selecting parent folder includes nested subfolder assets"
    );
    assert!(folder_ids.contains(&chart) && folder_ids.contains(&log_pdf));

    assist.update(o.cx, |a, cx| a.set_material_picker_query("海图", cx));
    draw(o.cx);
    assert_eq!(
        assist.read_with(o.cx, |a, _| (
            a.material_list_calls,
            a.menu().unwrap().rows.clone()
        )),
        (
            1,
            vec![MenuRow::Material {
                id: chart.clone(),
                title: "北港海图".into(),
                pdf: false,
            }]
        ),
        "filtering in memory never re-runs asset.list"
    );

    o.action(Newline);
    assert_eq!(o.lines(), [OBJ, ""]);
    assert!(
        o.cx.update(|window, cx| o.editor.read(cx).focus_handle(cx).is_focused(window)),
        "choosing a file returns keyboard focus to the prose editor"
    );
}

#[gpui::test]
fn image_embed_size_align_and_caption_persist_and_undo(cx: &mut TestAppContext) {
    let e = env();
    let img_id = put_image(&e, "栈桥暮色", None, 31);
    let (_, _, doc) = chapter(&e, "");
    {
        let mut o = open(cx, &e, &doc);
        assert!(
            o.view
                .update_in(o.cx, |v, window, cx| v.insert_material(&img_id, window, cx))
        );
        draw(o.cx);
        let embed_id = o
            .editor
            .read_with(o.cx, |ed, _| ed.embed_at(0, 0).unwrap().0);
        let block = o.view.read_with(o.cx, |v, _| {
            v.note_embeds().unwrap().material_block(&embed_id).unwrap()
        });
        assert_eq!(
            block.read_with(o.cx, |b, _| b.look().clone()),
            FileEmbedLook::default()
        );

        block.update(o.cx, |b, cx| b.set_size(EmbedSize::Small, cx));
        block.update(o.cx, |b, cx| b.set_align(EmbedAlign::Right, cx));
        block.update(o.cx, |b, cx| b.set_caption("黄昏涨潮前", cx));
        draw(o.cx);

        assert_eq!(
            block.read_with(o.cx, |b, _| b.look().clone()),
            FileEmbedLook {
                size: Some(EmbedSize::Small),
                align: Some(EmbedAlign::Right),
                caption: "黄昏涨潮前".into(),
            }
        );

        // Undo takes back caption first, keeping size & align.
        o.action(Undo);
        assert_eq!(
            block.read_with(o.cx, |b, _| b.look().clone()),
            FileEmbedLook {
                size: Some(EmbedSize::Small),
                align: Some(EmbedAlign::Right),
                caption: String::new(),
            }
        );
        // Set caption again and verify persistence across reopen.
        block.update(o.cx, |b, cx| b.set_caption("雾中灯塔", cx));
        draw(o.cx);
    }

    let o2 = open(cx, &e, &doc);
    let embed_id = o2
        .editor
        .read_with(o2.cx, |ed, _| ed.embed_at(0, 0).unwrap().0);
    let block = o2.view.read_with(o2.cx, |v, _| {
        v.note_embeds().unwrap().material_block(&embed_id).unwrap()
    });
    assert_eq!(
        block.read_with(o2.cx, |b, _| b.look().clone()),
        FileEmbedLook {
            size: Some(EmbedSize::Small),
            align: Some(EmbedAlign::Right),
            caption: "雾中灯塔".into(),
        }
    );
}

#[gpui::test]
fn same_file_embedded_twice_shares_one_asset_and_removing_one_keeps_the_other(
    cx: &mut TestAppContext,
) {
    let e = env();
    let img_id = put_image(&e, "老怀表", None, 44);
    let (_, _, doc) = chapter(&e, "上段\n下段");
    let mut o = open(cx, &e, &doc);
    o.caret(2);
    o.view
        .update_in(o.cx, |v, window, cx| v.insert_material(&img_id, window, cx));
    draw(o.cx);
    let end = o
        .editor
        .read_with(o.cx, |ed, _| ed.book().chapters[0].doc.max_cursor());
    o.caret(end);
    o.view
        .update_in(o.cx, |v, window, cx| v.insert_material(&img_id, window, cx));
    draw(o.cx);

    let listed = out(
        &e.ws,
        "asset.list",
        json!({ "book": e.book, "trashed": false }),
    );
    assert_eq!(
        listed.as_array().unwrap().len(),
        1,
        "still a single asset in library"
    );
    let got = out(
        &e.ws,
        "asset.get",
        json!({ "book": e.book, "id": img_id, "usages": true }),
    );
    assert_eq!(
        got["usages"].as_array().unwrap().len(),
        2,
        "two prose embed usages"
    );

    // Remove the first embed via `remove_from_prose`; the second embed and library asset stay.
    let first_embed = o.editor.read_with(o.cx, |ed, _| {
        (0..ed.book().chapters[0].doc.visible_lines())
            .find_map(|ix| ed.embed_at(0, ix))
            .unwrap()
            .0
    });
    let first_block = o.view.read_with(o.cx, |v, _| {
        v.note_embeds()
            .unwrap()
            .material_block(&first_embed)
            .unwrap()
    });
    first_block.update_in(o.cx, |b, window, cx| b.remove_from_prose(window, cx));
    draw(o.cx);

    assert_eq!(o.lines().iter().filter(|l| l.as_str() == OBJ).count(), 1);
    let got_after = out(
        &e.ws,
        "asset.get",
        json!({ "book": e.book, "id": img_id, "usages": true }),
    );
    assert_eq!(got_after["usages"].as_array().unwrap().len(), 1);
}

#[gpui::test]
fn folder_trash_marks_prose_embed_gone_and_restore_recovers_folder_and_file(
    cx: &mut TestAppContext,
) {
    let e = env();
    let folder = out(
        &e.ws,
        "asset_folder.create",
        json!({ "book": e.book, "name": "旧档" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let img_id = put_image(&e, "封存底片", Some(&folder), 55);
    let (_entry_id, _mod_id, doc) = chapter(&e, "");
    let o = open(cx, &e, &doc);
    o.view
        .update_in(o.cx, |v, window, cx| v.insert_material(&img_id, window, cx));
    draw(o.cx);

    let embed_id = o
        .editor
        .read_with(o.cx, |ed, _| ed.embed_at(0, 0).unwrap().0);
    let block = o.view.read_with(o.cx, |v, _| {
        v.note_embeds().unwrap().material_block(&embed_id).unwrap()
    });
    assert!(!block.update(o.cx, |b, _| b.is_missing()));

    // Trash the folder (not the file directly).
    out(
        &e.ws,
        "asset_folder.trash",
        json!({ "book": e.book, "id": folder }),
    );
    draw(o.cx);

    let shape = out(&e.ws, "prose.shape", json!({ "book": e.book, "doc": doc }));
    assert_eq!(shape["missing_embeds"].as_array().unwrap().len(), 1);
    assert!(
        block.update(o.cx, |b, _| b.is_missing()),
        "prose embed agrees with prose.shape when ancestor folder is trashed"
    );
    assert_eq!(
        block.update(o.cx, |b, _| b.missing_title()),
        Some("封存底片".into())
    );

    // Clicking `恢复` on the `.gone` placeholder restores the folder and makes the embed live again.
    block.update(o.cx, |b, cx| b.restore_missing(cx));
    draw(o.cx);
    draw(o.cx);

    assert!(!block.update(o.cx, |b, _| b.is_missing()));
    let shape_after = out(&e.ws, "prose.shape", json!({ "book": e.book, "doc": doc }));
    assert!(
        shape_after["missing_embeds"]
            .as_array()
            .is_none_or(|a| a.is_empty())
    );
}

#[gpui::test]
fn pasting_and_dropping_files_into_prose_import_reuse_and_place_at_paragraph_gap(
    cx: &mut TestAppContext,
) {
    let e = env();
    let (_, _, doc) = chapter(&e, "第一段\n第二段");
    let mut o = open(cx, &e, &doc);

    // Drop an external PNG file at paragraph gap `1` (between 第一段 and 第二段).
    let ext_file = e.dir.path().join("dropped-chart.png");
    std::fs::write(&ext_file, png_with_seed(40, 30, 77)).unwrap();
    o.view.update(o.cx, |v, cx| {
        v.drop_external_paths(vec![ext_file], Some(1), cx)
    });
    draw(o.cx);
    draw(o.cx);
    assert_eq!(o.lines(), ["第一段", OBJ, "第二段"]);

    // Paste a clipboard image at the end: lands at index 0 of `asset.list` as `粘贴的图片 ...`.
    let end = o
        .editor
        .read_with(o.cx, |ed, _| ed.book().chapters[0].doc.max_cursor());
    o.caret(end);
    let pasted_bytes = png_with_seed(32, 32, 99);
    o.cx.write_to_clipboard(ClipboardItem::new_image(&Image::from_bytes(
        ImageFormat::Png,
        pasted_bytes.clone(),
    )));
    o.action(Paste);
    draw(o.cx);

    let list1 = out(
        &e.ws,
        "asset.list",
        json!({ "book": e.book, "trashed": false }),
    );
    let mut arr1 = list1.as_array().unwrap().clone();
    arr1.sort_by(|a, b| {
        let pa = a["pos"].as_str().and_then(|s| PosKey::parse(s).ok());
        let pb = b["pos"].as_str().and_then(|s| PosKey::parse(s).ok());
        let ida = a["id"].as_str().unwrap_or("");
        let idb = b["id"].as_str().unwrap_or("");
        cmp_pos((pa.as_ref(), ida), (pb.as_ref(), idb))
    });
    assert_eq!(arr1.len(), 2);
    assert!(
        arr1[0]["name"].as_str().unwrap().starts_with("粘贴的图片"),
        "newly pasted image sits at manual-order index 0 of library: {:?}",
        arr1[0]["name"]
    );

    // Pasting the exact same bytes reuses the existing asset instead of duplicating it.
    let end2 = o
        .editor
        .read_with(o.cx, |ed, _| ed.book().chapters[0].doc.max_cursor());
    o.caret(end2);
    o.cx.write_to_clipboard(ClipboardItem::new_image(&Image::from_bytes(
        ImageFormat::Png,
        pasted_bytes,
    )));
    o.action(Paste);
    draw(o.cx);

    let list2 = out(
        &e.ws,
        "asset.list",
        json!({ "book": e.book, "trashed": false }),
    );
    assert_eq!(
        list2.as_array().unwrap().len(),
        2,
        "identical bytes reuse existing asset"
    );
    assert_eq!(o.lines().iter().filter(|l| l.as_str() == OBJ).count(), 3);
}

#[gpui::test]
fn prose_file_links_from_mention_menu_degrade_when_trashed_and_never_autolink(
    cx: &mut TestAppContext,
) {
    let e = env();
    let folder = out(
        &e.ws,
        "asset_folder.create",
        json!({ "book": e.book, "name": "地图册" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let chart_id = put_image(&e, "海图", Some(&folder), 12);
    let _pdf_id = put_pdf(&e, "航志", None);

    let (_, _, doc) = chapter(&e, "");
    let mut o = open(cx, &e, &doc);

    // Typing filenames directly never auto-links them (`v5-tracks.md` §T5).
    o.type_text("桌上放着海图与航志。");
    o.cx.executor().advance_clock(Duration::from_secs(1));
    draw(o.cx);
    let has_any_entity = o.editor.read_with(o.cx, |ed, _| {
        let line = ed.book().chapters[0].doc.line(0);
        line.spans
            .iter()
            .any(|s| s.marks.entities().next().is_some())
    });
    assert!(!has_any_entity, "asset filenames must never auto-link");

    // `@` menu includes live file candidates under `NameGroup::Asset`.
    o.type_text("@海图");
    let assist = o.view.read_with(o.cx, |v, _| v.assist().clone());
    let mention_rows = assist.read_with(o.cx, |a, _| a.menu().unwrap().rows.clone());
    assert_eq!(
        mention_rows,
        [MenuRow::Link {
            name: "海图".into(),
            target: LinkTarget::new(EntityKind::Asset, &chart_id),
            group: NameGroup::Asset,
        }]
    );
    o.action(Newline);
    o.cx.executor().advance_clock(Duration::from_millis(200));
    draw(o.cx);

    let target = LinkTarget::new(EntityKind::Asset, &chart_id);
    assert!(
        card_facts(&e.ws, &e.book, &target).is_some_and(|f| f.title == "海图" && f.asset.is_some()),
        "live file link has preview card facts"
    );
    assert!(
        o.editor.read_with(o.cx, |ed, _| ed
            .decoration_range(0, "links", "f0")
            .is_some()),
        "live file link paints file-link decoration f0"
    );

    // Check run styling while live vs after trashing parent folder.
    let ext = dr_editor::DriftingExtension::new(Some(Box::new(dr_editor::v3::LinkTargets {
        workspace: e.ws.clone(),
        book: e.book.clone(),
    })));
    let marks = o.editor.update(o.cx, |ed, _| ed.marks_at(0, 11));
    let style = ProseStyle::default();
    let mut live_run = RunStyle::from_marks(&marks, &style);
    ext.style_run(&marks, &mut live_run, &style);
    assert_eq!(live_run.color, style.link);
    assert!(live_run.underline.is_some());

    // Trashing the folder degrades the file link to ordinary prose text.
    out(
        &e.ws,
        "asset_folder.trash",
        json!({ "book": e.book, "id": folder }),
    );
    ext.invalidate();
    o.cx.executor().advance_clock(Duration::from_millis(200));
    draw(o.cx);
    draw(o.cx);

    assert!(
        card_facts(&e.ws, &e.book, &target).is_none(),
        "trashed file link has no hover card and is not clickable"
    );
    assert!(
        o.editor.read_with(o.cx, |ed, _| {
            ed.decoration_range(0, "links", "f0").is_none()
                && ed.decoration_range(0, "links", "l0").is_none()
        }),
        "trashed file link has no link underline decoration"
    );
    let mut dead_run = RunStyle::from_marks(&marks, &style);
    ext.style_run(&marks, &mut dead_run, &style);
    assert_eq!(
        dead_run.color, style.text,
        "trashed file link degrades to ordinary text color (not muted dead-entry color)"
    );
    assert!(
        dead_run.underline.is_none(),
        "trashed file link has no underline"
    );
    assert!(
        o.lines()[0].contains("海图"),
        "the linked words remain intact in the sentence"
    );

    // Restoring the folder brings the link right back.
    out(
        &e.ws,
        "asset_folder.restore",
        json!({ "book": e.book, "id": folder }),
    );
    ext.invalidate();
    o.cx.executor().advance_clock(Duration::from_millis(200));
    draw(o.cx);
    draw(o.cx);

    assert!(card_facts(&e.ws, &e.book, &target).is_some());
    assert!(o.editor.read_with(o.cx, |ed, _| {
        ed.decoration_range(0, "links", "f0").is_some()
    }));
}

// ----- the whole-book view takes files as a chapter editor does (`v5-tracks.md` §T5b)

/// An entry `title` from `template` under `parent` whose prose reads `text`:
/// its id and its prose document.
fn entry_in(e: &Env, parent: &str, template: &str, title: &str, text: &str) -> (String, String) {
    let id = out(
        &e.ws,
        "entry.create",
        json!({
            "book": e.book,
            "parent": parent,
            "template": template,
            "title": title,
            "bodies": { "mod-prose": text },
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = format!("body:{id}/mod-prose");
    (id, doc)
}

fn manuscript(e: &Env) -> String {
    dr_testkit::seed::acceptance::novel_root(&e.ws, &e.book, "tpl-manuscript")
}

/// The entries whose prose embeds `asset`, as the library counts them.
fn embedded_in(e: &Env, asset: &str) -> Vec<String> {
    out(
        &e.ws,
        "asset.get",
        json!({ "book": e.book, "id": asset, "usages": true }),
    )["usages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|u| u["kind"] == "embed")
        .map(|u| u["entry"].as_str().unwrap().to_owned())
        .collect()
}

/// The library's files (not in Recently Deleted): `(id, name)`.
fn library(e: &Env) -> Vec<(String, String)> {
    out(
        &e.ws,
        "asset.list",
        json!({ "book": e.book, "trashed": false }),
    )
    .as_array()
    .unwrap()
    .iter()
    .map(|a| {
        (
            a["id"].as_str().unwrap().to_owned(),
            a["name"].as_str().unwrap().to_owned(),
        )
    })
    .collect()
}

struct OpenBook<'a> {
    view: Entity<BookEditor>,
    editor: Entity<ProseEditor>,
    cx: &'a mut VisualTestContext,
}

fn open_book<'a>(cx: &'a mut TestAppContext, e: &Env, from: &str) -> OpenBook<'a> {
    let (ws, book, from) = (e.ws.clone(), e.book.clone(), from.to_owned());
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        let mut editor =
            BookEditor::open(ws, &book, &from, EditorSettings::default(), window, cx).unwrap();
        editor.set_decor_looks(
            DecorLooks::new(&Palette::LIGHT, hsla(0.58, 0.7, 0.42, 1.), false),
            cx,
        );
        editor
    });
    cx.simulate_resize(size(px(900.), px(800.)));
    draw(cx);
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    let mut o = OpenBook { view, editor, cx };
    o.focus_body();
    o
}

impl OpenBook<'_> {
    fn focus_body(&mut self) {
        let focus = self.editor.read_with(self.cx, |e, cx| e.focus_handle(cx));
        self.cx.update(|window, cx| window.focus(&focus, cx));
        draw(self.cx);
    }

    fn chapter(&mut self, doc: &str) -> usize {
        self.view
            .read_with(self.cx, |v, _| v.chapter_of(doc))
            .unwrap()
    }

    fn caret_end(&mut self, chapter: usize) {
        self.editor.update_in(self.cx, |e, window, cx| {
            let end = e.book().chapters[chapter].doc.max_cursor();
            e.select(chapter, end..end, window, cx)
        });
        draw(self.cx);
    }

    /// The caret `chars` characters into paragraph `line` of `chapter`.
    fn caret_in(&mut self, chapter: usize, line: usize, chars: usize) {
        self.editor.update_in(self.cx, |e, window, cx| {
            let at = e.book().chapters[chapter].doc.line_start(line) + chars;
            e.select(chapter, at..at, window, cx)
        });
        draw(self.cx);
    }

    fn type_text(&mut self, text: &str) {
        for c in text.chars() {
            let s = c.to_string();
            self.editor.update_in(self.cx, |e, window, cx| {
                e.replace_text_in_range(None, &s, window, cx)
            });
        }
        draw(self.cx);
    }

    fn action(&mut self, action: impl gpui::Action) {
        self.cx.dispatch_action(action);
        draw(self.cx);
    }

    fn lines(&mut self, chapter: usize) -> Vec<String> {
        self.editor.read_with(self.cx, |e, _| {
            let doc = &e.book().chapters[chapter].doc;
            (0..doc.visible_lines())
                .map(|l| doc.line(l).text.to_string())
                .collect()
        })
    }

    fn assist(&mut self) -> Entity<dr_editor::assist::Assist> {
        self.view.read_with(self.cx, |v, _| v.assist().clone())
    }

    fn menu(&mut self) -> Option<(MenuKind, usize, Vec<MenuRow>)> {
        let assist = self.assist();
        assist.read_with(self.cx, |a, _| {
            a.menu().map(|m| (m.kind, m.chapter, m.rows.clone()))
        })
    }

    /// The file picker's row for `asset`, chosen.
    fn choose_file(&mut self, asset: &str) {
        let assist = self.assist();
        let ix = assist.read_with(self.cx, |a, _| {
            a.menu()
                .unwrap()
                .rows
                .iter()
                .position(|r| matches!(r, MenuRow::Material { id, .. } if id == asset))
                .unwrap()
        });
        assist.update_in(self.cx, |a, window, cx| a.choose(Some(ix), window, cx));
        draw(self.cx);
    }

    /// Where paragraph `line` of `chapter` was drawn.
    fn line_bounds(&mut self, chapter: usize, line: usize) -> gpui::Bounds<gpui::Pixels> {
        self.editor.read_with(self.cx, |e, _| {
            let doc = &e.book().chapters[chapter].doc;
            let start = doc.line_start(line);
            e.range_bounds(chapter, start..start + doc.line(line).chars)
                .unwrap()
        })
    }

    /// The computer's `file` dragged over the window to `at` and dropped.
    fn drop_file_at(&mut self, file: &std::path::Path, at: gpui::Point<gpui::Pixels>) {
        let paths = gpui::ExternalPaths(vec![file.to_path_buf()].into());
        self.cx.simulate_event(gpui::FileDropEvent::Entered {
            position: at,
            paths,
        });
        self.cx
            .simulate_event(gpui::FileDropEvent::Pending { position: at });
        draw(self.cx);
        self.cx
            .simulate_event(gpui::FileDropEvent::Submit { position: at });
        draw(self.cx);
        draw(self.cx);
    }
}

#[gpui::test]
fn whole_book_slash_embeds_an_image_and_a_pdf_in_the_caret_chapter_undone_in_one_step(
    cx: &mut TestAppContext,
) {
    let e = env();
    let chart = put_image(&e, "北港海图", None, 61);
    let log_pdf = put_pdf(&e, "航海日志", None);
    let root = manuscript(&e);
    let (first, first_doc) = entry_in(&e, &root, "tpl-chapter", "第一章", "启航");
    let (second, second_doc) = entry_in(&e, &root, "tpl-chapter", "第二章", "靠岸");
    let mut o = open_book(cx, &e, &root);
    let (c1, c2) = (o.chapter(&first_doc), o.chapter(&second_doc));

    // An image from the slash menu's picker goes into the chapter the caret is in.
    o.caret_end(c2);
    o.type_text("/图片");
    let (_, _, rows) = o.menu().unwrap();
    assert_eq!(rows, [MenuRow::Note(NoteChoice::Material)]);
    o.action(Newline);
    let (kind, chapter, _) = o.menu().unwrap();
    assert_eq!((kind, chapter), (MenuKind::Material, c2));
    let before = o.lines(c2);
    assert_eq!(before, ["靠岸"], "the slash query went");
    o.choose_file(&chart);
    assert_eq!(o.lines(c1), ["启航"], "the other chapter is untouched");
    assert_eq!(o.lines(c2).iter().filter(|l| *l == OBJ).count(), 1);
    assert_eq!(embedded_in(&e, &chart), [second.as_str()]);
    assert_eq!(
        library(&e).len(),
        2,
        "embedding adds no file to the library"
    );
    assert!(
        o.cx.update(|window, cx| o.editor.read(cx).focus_handle(cx).is_focused(window)),
        "choosing a file returns the keyboard to the text"
    );
    o.action(Undo);
    assert_eq!(o.lines(c2), before, "one ⌘Z takes the image back");
    assert!(embedded_in(&e, &chart).is_empty());

    // A PDF into the first chapter, the same way.
    o.caret_end(c1);
    o.type_text("/图片");
    o.action(Newline);
    let before = o.lines(c1);
    o.choose_file(&log_pdf);
    assert_eq!(o.lines(c2), ["靠岸"]);
    assert_eq!(o.lines(c1).iter().filter(|l| *l == OBJ).count(), 1);
    assert_eq!(embedded_in(&e, &log_pdf), [first.as_str()]);
    o.action(Undo);
    assert_eq!(o.lines(c1), before, "one ⌘Z takes the PDF back");
    assert!(embedded_in(&e, &log_pdf).is_empty());

    // 「从电脑选…」: the file goes into the library and into the menu's chapter.
    o.caret_end(c2);
    o.type_text("/图片");
    o.action(Newline);
    let file = e.dir.path().join("灯塔.png");
    std::fs::write(&file, png_with_seed(30, 20, 88)).unwrap();
    let assist = o.assist();
    assist.update_in(o.cx, |a, window, cx| {
        a.pick_material_from_computer(c2, window, cx)
    });
    o.cx.simulate_path_prompt_response(|_| Some(vec![file.clone()]));
    draw(o.cx);
    draw(o.cx);
    let added: Vec<String> = library(&e)
        .into_iter()
        .map(|(id, _)| id)
        .filter(|id| *id != chart && *id != log_pdf)
        .collect();
    assert_eq!(added.len(), 1, "the chosen file is in the library");
    assert_eq!(embedded_in(&e, &added[0]), [second.as_str()]);
    assert_eq!(o.lines(c1), ["启航"]);
}

/// `kernel-v5.md` §15 item 49: the system's file window of 「从电脑选…」 is
/// open while the author clicks into another chapter; the chosen file goes
/// to the caret there, below its paragraph, as in a chapter editor.
#[gpui::test]
fn whole_book_file_picked_from_the_computer_follows_the_caret_into_another_chapter(
    cx: &mut TestAppContext,
) {
    let e = env();
    let root = manuscript(&e);
    let (first, first_doc) = entry_in(&e, &root, "tpl-chapter", "第一章", "启航\n远洋");
    let (second, second_doc) = entry_in(&e, &root, "tpl-chapter", "第二章", "靠岸\n归港");
    let mut o = open_book(cx, &e, &root);
    let (c1, c2) = (o.chapter(&first_doc), o.chapter(&second_doc));
    let assist = o.assist();
    let picture = |name: &str, width: u32| {
        let file = e.dir.path().join(name);
        std::fs::write(&file, dr_testkit::media::png(width, 30)).unwrap();
        file
    };
    let added = |known: &[String]| -> String {
        let new: Vec<String> = library(&e)
            .into_iter()
            .map(|(id, _)| id)
            .filter(|id| !known.contains(id))
            .collect();
        assert_eq!(new.len(), 1, "the chosen file is in the library");
        new[0].clone()
    };

    // The menu opens at the end of the first chapter's first paragraph; the
    // caret moves into the second chapter's first paragraph meanwhile.
    o.caret_in(c1, 0, 2);
    o.type_text("/图片");
    o.action(Newline);
    let (kind, chapter, _) = o.menu().unwrap();
    assert_eq!((kind, chapter), (MenuKind::Material, c1));
    assert_eq!(o.lines(c1), ["启航", "远洋"], "the slash query went");
    let lighthouse = picture("灯塔.png", 40);
    assist.update_in(o.cx, |a, window, cx| {
        a.pick_material_from_computer(c1, window, cx)
    });
    o.caret_in(c2, 0, 1);
    o.cx.simulate_path_prompt_response(|_| Some(vec![lighthouse.clone()]));
    draw(o.cx);
    draw(o.cx);
    let moved = added(&[]);
    assert_eq!(
        o.lines(c2),
        ["靠岸", OBJ, "", "归港"],
        "the file is below the caret's paragraph in the caret's chapter, then a paragraph to go on"
    );
    assert_eq!(embedded_in(&e, &moved), [second.as_str()]);
    assert_eq!(
        o.lines(c1),
        ["启航", "远洋"],
        "the menu's chapter is untouched"
    );
    o.action(Undo);
    assert_eq!(
        o.lines(c2),
        ["靠岸", "归港"],
        "one ⌘Z in that chapter takes it back"
    );
    assert!(embedded_in(&e, &moved).is_empty());
    assert_eq!(o.lines(c1), ["启航", "远洋"]);

    // The caret still in the menu's chapter: the file goes there, at the caret.
    o.caret_in(c1, 0, 2);
    o.type_text("/图片");
    o.action(Newline);
    let chart = picture("海图.png", 44);
    assist.update_in(o.cx, |a, window, cx| {
        a.pick_material_from_computer(c1, window, cx)
    });
    o.cx.simulate_path_prompt_response(|_| Some(vec![chart.clone()]));
    draw(o.cx);
    draw(o.cx);
    let stayed = added(std::slice::from_ref(&moved));
    assert_eq!(o.lines(c1), ["启航", OBJ, "", "远洋"]);
    assert_eq!(embedded_in(&e, &stayed), [first.as_str()]);
    assert_eq!(o.lines(c2), ["靠岸", "归港"]);
    o.action(Undo);
    assert_eq!(o.lines(c1), ["启航", "远洋"], "one ⌘Z takes it back");
    assert!(embedded_in(&e, &stayed).is_empty());

    // The caret left the menu's chapter and then the text lost the keyboard
    // (the author went on outside the prose): the file still goes where the
    // caret was left, not to the end of the menu's chapter.
    o.caret_in(c1, 0, 2);
    o.type_text("/图片");
    o.action(Newline);
    let tide = picture("潮汐.png", 48);
    assist.update_in(o.cx, |a, window, cx| {
        a.pick_material_from_computer(c1, window, cx)
    });
    o.caret_in(c2, 0, 1);
    o.cx.update(|window, cx| window.blur(cx));
    o.cx.simulate_path_prompt_response(|_| Some(vec![tide.clone()]));
    draw(o.cx);
    draw(o.cx);
    let unfocused = added(&[moved, stayed]);
    assert_eq!(embedded_in(&e, &unfocused), [second.as_str()]);
    assert_eq!(o.lines(c2), ["靠岸", OBJ, "", "归港"]);
    assert_eq!(o.lines(c1), ["启航", "远洋"], "the menu's chapter is untouched");
}

#[gpui::test]
fn whole_book_drops_library_files_and_folders_into_the_dropped_chapter(cx: &mut TestAppContext) {
    let e = env();
    let harbour = out(
        &e.ws,
        "asset_folder.create",
        json!({ "book": e.book, "name": "海港" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let chart = put_image(&e, "北港海图", None, 62);
    let south = put_image(&e, "南港", Some(&harbour), 63);
    let root = manuscript(&e);
    let (first, first_doc) = entry_in(&e, &root, "tpl-chapter", "第一章", "启航\n远洋");
    let (second, second_doc) = entry_in(&e, &root, "tpl-chapter", "第二章", "靠岸\n归港");
    let mut o = open_book(cx, &e, &root);
    let (c1, c2) = (o.chapter(&first_doc), o.chapter(&second_doc));
    o.caret_end(c1);

    // A library file dragged between the second chapter's paragraphs.
    let book = e.book.clone();
    let drag = |assets: Vec<String>, folders: Vec<String>| dr_ui::AssetDrag {
        book: book.clone(),
        assets,
        folders,
        label: "海图".into(),
    };
    o.view.update(o.cx, |v, cx| {
        v.drop_asset_drag(&drag(vec![chart.clone()], Vec::new()), Some((c2, 1)), cx)
    });
    draw(o.cx);
    assert_eq!(o.lines(c1), ["启航", "远洋"]);
    assert_eq!(o.lines(c2), ["靠岸", OBJ, "归港"]);
    assert_eq!(embedded_in(&e, &chart), [second.as_str()]);
    assert_eq!(library(&e).len(), 2, "a library file is not copied");
    assert_eq!(
        o.editor.read_with(o.cx, |ed, _| ed.selection().chapter),
        c2,
        "the caret followed the drop into its chapter"
    );
    o.action(Undo);
    assert_eq!(o.lines(c2), ["靠岸", "归港"], "one ⌘Z takes the drop back");
    assert!(embedded_in(&e, &chart).is_empty());

    // A folder dragged in brings its files, into the first chapter.
    o.view.update(o.cx, |v, cx| {
        v.drop_asset_drag(&drag(Vec::new(), vec![harbour.clone()]), Some((c1, 1)), cx)
    });
    draw(o.cx);
    draw(o.cx);
    assert_eq!(o.lines(c1), ["启航", OBJ, "远洋"]);
    assert_eq!(embedded_in(&e, &south), [first.as_str()]);
    assert_eq!(o.lines(c2), ["靠岸", "归港"]);
}

#[gpui::test]
fn whole_book_file_dropped_at_a_chapter_boundary_lands_in_the_chapter_under_the_pointer(
    cx: &mut TestAppContext,
) {
    let e = env();
    let root = manuscript(&e);
    let (first, first_doc) = entry_in(&e, &root, "tpl-chapter", "第一章", "启航\n远洋");
    let (second, second_doc) = entry_in(&e, &root, "tpl-chapter", "第二章", "靠岸\n归港");
    let mut o = open_book(cx, &e, &root);
    let (c1, c2) = (o.chapter(&first_doc), o.chapter(&second_doc));

    // Just under the first chapter's last paragraph: the end of the first chapter.
    let last = o.line_bounds(c1, 1);
    let at = gpui::point(last.center().x, last.bottom() + px(2.));
    let lighthouse = e.dir.path().join("灯塔.png");
    std::fs::write(&lighthouse, png_with_seed(30, 20, 91)).unwrap();
    o.drop_file_at(&lighthouse, at);
    let ids: Vec<String> = library(&e).into_iter().map(|(id, _)| id).collect();
    assert_eq!(ids.len(), 1, "the dropped file is in the library");
    assert_eq!(embedded_in(&e, &ids[0]), [first.as_str()]);
    assert_eq!(o.lines(c1)[..3], ["启航", "远洋", OBJ]);
    assert_eq!(o.lines(c2), ["靠岸", "归港"]);
    o.action(Undo);
    assert!(
        !o.lines(c1).iter().any(|l| l == OBJ),
        "one ⌘Z takes the drop back"
    );

    // Just over the second chapter's first paragraph: the start of the second.
    let top = o.line_bounds(c2, 0);
    let at = gpui::point(top.center().x, top.top() - px(2.));
    let pier = e.dir.path().join("栈桥.png");
    std::fs::write(&pier, png_with_seed(30, 20, 92)).unwrap();
    o.drop_file_at(&pier, at);
    let pier_id = library(&e)
        .into_iter()
        .map(|(id, _)| id)
        .find(|id| !ids.contains(id))
        .expect("the second file is in the library");
    assert_eq!(embedded_in(&e, &pier_id), [second.as_str()]);
    assert_eq!(o.lines(c2), [OBJ, "靠岸", "归港"]);
    assert!(!o.lines(c1).iter().any(|l| l == OBJ));

    // The same bytes again give back the file already there.
    let again = e.dir.path().join("栈桥-副本.png");
    std::fs::write(&again, png_with_seed(30, 20, 92)).unwrap();
    let top = o.line_bounds(c2, 1);
    o.drop_file_at(&again, gpui::point(top.center().x, top.bottom() + px(2.)));
    assert_eq!(library(&e).len(), 2, "identical bytes add no file");
    assert_eq!(
        embedded_in(&e, &pier_id),
        [second.as_str(), second.as_str()]
    );
}

#[gpui::test]
fn whole_book_paste_puts_an_image_in_the_caret_chapter_and_reuses_the_same_bytes(
    cx: &mut TestAppContext,
) {
    let e = env();
    let root = manuscript(&e);
    let (first, first_doc) = entry_in(&e, &root, "tpl-chapter", "第一章", "启航");
    let (second, second_doc) = entry_in(&e, &root, "tpl-chapter", "第二章", "靠岸");
    let mut o = open_book(cx, &e, &root);
    let (c1, c2) = (o.chapter(&first_doc), o.chapter(&second_doc));

    let bytes = png_with_seed(32, 32, 99);
    o.caret_end(c1);
    o.cx.write_to_clipboard(ClipboardItem::new_image(&Image::from_bytes(
        ImageFormat::Png,
        bytes.clone(),
    )));
    o.action(Paste);
    draw(o.cx);
    let files = library(&e);
    assert_eq!(files.len(), 1);
    assert!(
        files[0].1.starts_with("粘贴的图片"),
        "a pasted image is named as one: {:?}",
        files[0].1
    );
    assert_eq!(embedded_in(&e, &files[0].0), [first.as_str()]);
    assert_eq!(o.lines(c1).iter().filter(|l| *l == OBJ).count(), 1);
    assert_eq!(o.lines(c2), ["靠岸"]);
    o.action(Undo);
    assert_eq!(o.lines(c1), ["启航"], "one ⌘Z takes the paste back");
    assert_eq!(library(&e).len(), 1, "the file stays in the library");

    // The same bytes into the second chapter: no second file.
    o.caret_end(c2);
    o.cx.write_to_clipboard(ClipboardItem::new_image(&Image::from_bytes(
        ImageFormat::Png,
        bytes,
    )));
    o.action(Paste);
    draw(o.cx);
    assert_eq!(library(&e).len(), 1, "identical bytes reuse the file");
    assert_eq!(embedded_in(&e, &files[0].0), [second.as_str()]);
    assert_eq!(o.lines(c1), ["启航"]);
}

#[gpui::test]
fn whole_book_copies_cuts_and_pastes_tables_as_a_chapter_editor_does(cx: &mut TestAppContext) {
    let e = env();
    let root = manuscript(&e);
    let (_, first_doc) = entry_in(&e, &root, "tpl-chapter", "第一章", "启航");
    let (_, second_doc) = entry_in(&e, &root, "tpl-chapter", "第二章", "靠岸");
    let mut o = open_book(cx, &e, &root);
    let (c1, c2) = (o.chapter(&first_doc), o.chapter(&second_doc));
    let grid = |s: &[&[&str]]| -> Vec<Vec<String>> {
        s.iter()
            .map(|r| r.iter().map(|c| c.to_string()).collect())
            .collect()
    };
    let embed_line = |o: &mut OpenBook<'_>, chapter: usize| {
        o.lines(chapter).iter().position(|l| l == OBJ).unwrap()
    };

    // Tab-separated text of 2 × 2 pasted in the first chapter: a table there.
    o.caret_end(c1);
    o.cx.write_to_clipboard(ClipboardItem::new_string("甲\t乙\n丙\t丁".into()));
    o.action(Paste);
    let line = embed_line(&mut o, c1);
    assert_eq!(o.lines(c2), ["靠岸"]);
    let cells = |o: &mut OpenBook<'_>, doc: &str, chapter: usize, line: usize| {
        let embed = o
            .editor
            .read_with(o.cx, |ed, _| ed.embed_at(chapter, line).unwrap().0);
        o.view.read_with(o.cx, |v, _| {
            v.note_embeds(doc).unwrap().table_cells(&embed).unwrap()
        })
    };
    assert_eq!(
        cells(&mut o, &first_doc, c1, line),
        grid(&[&["甲", "乙"], &["丙", "丁"]])
    );

    // The table selected in the text copies as a table…
    o.editor
        .update_in(o.cx, |ed, window, cx| ed.select_embed(c1, line, window, cx));
    o.action(Copy);
    let item = o.cx.read_from_clipboard().unwrap();
    assert_eq!(
        dr_editor::table::clip::table_from_clipboard(&item),
        Some(grid(&[&["甲", "乙"], &["丙", "丁"]]))
    );
    assert_eq!(item.text().as_deref(), Some("甲\t乙\n丙\t丁"));

    // …and pastes as a new one in the second chapter.
    o.focus_body();
    o.caret_end(c2);
    o.action(Paste);
    let line2 = embed_line(&mut o, c2);
    assert_eq!(
        cells(&mut o, &second_doc, c2, line2),
        grid(&[&["甲", "乙"], &["丙", "丁"]])
    );
    assert_eq!(o.lines(c1).iter().filter(|l| *l == OBJ).count(), 1);

    // Cut takes the second chapter's table out and puts it on the clipboard.
    o.cx.write_to_clipboard(ClipboardItem::new_string(String::new()));
    o.editor.update_in(o.cx, |ed, window, cx| {
        ed.select_embed(c2, line2, window, cx)
    });
    o.action(Cut);
    assert!(!o.lines(c2).iter().any(|l| l == OBJ), "the cut table went");
    assert_eq!(o.lines(c1).iter().filter(|l| *l == OBJ).count(), 1);
    let item = o.cx.read_from_clipboard().unwrap();
    assert_eq!(
        dr_editor::table::clip::table_from_clipboard(&item),
        Some(grid(&[&["甲", "乙"], &["丙", "丁"]]))
    );
}

#[gpui::test]
fn whole_book_slash_menu_matches_each_chapters_own_editor(cx: &mut TestAppContext) {
    use dr_editor::assist::SlashAction;

    let e = env();
    let root = manuscript(&e);
    // A volume whose format shortcuts are on, and a chapter in it; another
    // chapter right under the manuscript, whose shortcuts stay off.
    let volume = out(
        &e.ws,
        "entry.create",
        json!({ "book": e.book, "parent": root, "template": "tpl-group", "title": "第一卷" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &e.ws,
        "entry.update",
        json!({ "book": e.book, "id": volume, "overrides": { "format_shortcuts": "full" } }),
    );
    let (_, noted_doc) = entry_in(&e, &volume, "tpl-chapter", "卷中章", "");
    let (_, plain_doc) = entry_in(&e, &root, "tpl-chapter", "卷外章", "");

    let mut alone = |doc: &str| {
        let mut o = open(cx, &e, doc);
        o.type_text("/");
        let assist = o.view.read_with(o.cx, |v, _| v.assist().clone());
        let rows = assist.read_with(o.cx, |a, _| a.menu().unwrap().rows.clone());
        o.cx.update(|window, _| window.remove_window());
        o.cx.run_until_parked();
        rows
    };
    let noted = alone(&noted_doc);
    let plain = alone(&plain_doc);
    let todo = MenuRow::Action(SlashAction::Todo);
    let position = MenuRow::Action(SlashAction::PositionLink);
    assert!(!noted.contains(&todo) && !noted.contains(&position));
    assert!(plain.contains(&todo) && plain.contains(&position));

    let mut o = open_book(cx, &e, &root);
    for (doc, rows) in [(&noted_doc, &noted), (&plain_doc, &plain)] {
        let chapter = o.chapter(doc);
        o.caret_end(chapter);
        o.type_text("/");
        let (kind, at, got) = o.menu().unwrap();
        assert_eq!((kind, at), (MenuKind::Slash, chapter));
        assert_eq!(
            &got, rows,
            "{doc}: the whole book's slash menu is the chapter's own"
        );
        o.action(Undo);
    }
}

#[gpui::test]
fn whole_book_draws_the_file_mark_after_a_link_to_a_file(cx: &mut TestAppContext) {
    let e = env();
    let chart = put_image(&e, "海图", None, 64);
    let root = manuscript(&e);
    let (_, first_doc) = entry_in(&e, &root, "tpl-chapter", "第一章", "启航");
    let (_, second_doc) = entry_in(&e, &root, "tpl-chapter", "第二章", "");
    let mut o = open_book(cx, &e, &root);
    let (c1, c2) = (o.chapter(&first_doc), o.chapter(&second_doc));
    assert!(o.cx.debug_bounds("dr-editor-file-link-badge").is_none());

    o.caret_end(c2);
    o.type_text("@海图");
    let (kind, _, rows) = o.menu().unwrap();
    assert_eq!(kind, MenuKind::Mention);
    assert_eq!(
        rows,
        [MenuRow::Link {
            name: "海图".into(),
            target: LinkTarget::new(EntityKind::Asset, &chart),
            group: NameGroup::Asset,
        }]
    );
    o.action(Newline);
    o.cx.executor().advance_clock(Duration::from_millis(200));
    draw(o.cx);
    draw(o.cx);
    assert!(
        o.editor.read_with(o.cx, |ed, _| ed
            .decoration_range(c2, "links", "f0")
            .is_some()),
        "the file link is painted in its chapter"
    );
    assert!(o.lines(c1) == ["启航"]);
    assert!(
        o.cx.debug_bounds("dr-editor-file-link-badge").is_some(),
        "the small file mark follows the link, as in a chapter editor"
    );
}
