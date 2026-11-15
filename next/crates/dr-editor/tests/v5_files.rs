//! Format-5 file embeds, slash file picker, drag/paste into prose, and
//! file-target inline links (`kernel-v5.md` §6, `v5-tracks.md` §T5).

use std::time::Duration;

use dr_doc::prose::FileEmbedLook;
use dr_editor::assist::{MenuKind, MenuRow, NoteChoice};
use dr_editor::decor::DecorLooks;
use dr_editor::entity_links::NameGroup;
use dr_editor::link_card::card_facts;
use dr_editor::{ChapterEditor, EditorSettings};
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
use gpui_prose::input::actions::{Newline, Paste, Undo};
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
