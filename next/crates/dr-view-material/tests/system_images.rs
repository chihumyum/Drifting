//! HEIC and AVIF materials on GPUI's test platform, on real libraries with
//! the test kit's synthetic pictures (`dr_testkit::media::{HEIC, AVIF}`,
//! 600 × 400 in four solid quadrants):
//!
//! - added to the material library, the file is kept byte for byte and gets
//!   a JPEG display copy and thumbnail through the system's codec; the
//!   library's thumbnail and the viewer show it;
//! - imported from a 0.1 library that kept its `display.jpg` and
//!   `thumbnail.jpg`, those come with it: a prose embed, a link card and the
//!   manuscript export show it at once, with the material library never
//!   opened and nothing decoded;
//! - imported from a 0.1 library without those copies (the import then
//!   carries the source alone), the picture shows in the library and the
//!   viewer and its copies are made and kept the first time it is shown, so
//!   every other view has them too;
//! - a damaged HEIC and a damaged PNG are left out, as a damaged PNG always
//!   was; an imported HEIC the system cannot decode shows as an image that
//!   cannot be decoded.
//!
//! The pictures are decoded by ImageIO, so these run on macOS (on Windows the
//! codec needs the Store's extensions, which CI does not install).
#![cfg(target_os = "macos")]

#[path = "../../dr-import-v1/tests/common/mod.rs"]
mod common;

use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_shell::book::Book;
use dr_shell::pages::PageViewHost;
use dr_shell::{Services, SettingsFile, ShellInfo};
use dr_store::asset::Variant;
use dr_ui::Appearance;
use dr_view_material::library::LibraryPanel;
use dr_view_material::media::{Picture, Trouble};
use dr_view_material::{MediaKind, MediaPage, previews};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{Entity, TestAppContext, VisualTestContext, WeakEntity, px, size};
use serde_json::json;

fn info() -> ShellInfo {
    ShellInfo {
        app_name: "Drifting Next",
        bundle_id: "cc.drifting.next.dev",
        version: "0.2.0-dev",
        url_scheme: "drifting-next-dev",
        forced_appearance: Some(Appearance::Light),
    }
}

/// The shell over `ws`, so the previews read its asset library.
fn shell(cx: &mut TestAppContext, ws: &Workspace) {
    cx.executor().allow_parking();
    let ws = ws.clone();
    cx.update(|cx| {
        let mut file = SettingsFile::in_memory();
        file.set(
            dr_shell::settings::registry::UI_LOCALE,
            "zh-CN".into(),
            None,
        )
        .ok();
        dr_shell::init(
            info(),
            Services {
                library: Some(ws),
                ..Default::default()
            },
            file,
            cx,
        );
    });
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

fn wait_for(cx: &mut VisualTestContext, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        cx.executor().advance_clock(Duration::from_millis(40));
        draw(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// The material library panel on `book`, in a 320 × 700 window.
fn panel(
    cx: &mut TestAppContext,
    ws: &Workspace,
    book: &str,
) -> (Entity<LibraryPanel>, VisualTestContext) {
    let loaded = Rc::new(Book::load(ws, book).unwrap());
    let lib = ws.clone();
    let window = cx.add_window(move |window, cx| {
        LibraryPanel::new(WeakEntity::new_invalid(), Some(lib), loaded, window, cx)
    });
    let panel = window.root(cx).unwrap();
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    vcx.update(|window, _| window.activate_window());
    vcx.simulate_resize(size(px(320.), px(700.)));
    draw(&mut vcx);
    (panel, vcx)
}

/// The library's thumbnail of `asset`, asked for as a row does. The test
/// platform runs the background work while drawing, so once the work has
/// settled a `None` means none could be made (the row keeps its stand-in).
fn thumbnail(cx: &mut VisualTestContext, asset: &str) -> Option<Picture> {
    let ask = |cx: &mut VisualTestContext| {
        cx.update(|_, cx| previews::thumbnail(asset, MediaKind::Image, cx))
    };
    if let Some(pic) = ask(cx) {
        return Some(pic);
    }
    let settled = Instant::now() + Duration::from_secs(3);
    while Instant::now() < settled {
        cx.executor().advance_clock(Duration::from_millis(40));
        draw(cx);
        if let Some(pic) = ask(cx) {
            return Some(pic);
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    None
}

/// The viewer of material `id`, once its picture is loaded (or refused).
fn viewer(
    cx: &mut TestAppContext,
    ws: &Workspace,
    book: &str,
    id: &str,
) -> (Entity<MediaPage>, VisualTestContext) {
    let host = PageViewHost {
        workspace: WeakEntity::new_invalid(),
        library: ws.clone(),
        book_id: book.to_owned(),
        book: Rc::new(Book::load(ws, book).unwrap()),
    };
    let id = id.to_owned();
    let window =
        cx.add_window(move |window, cx| MediaPage::new(id, MediaKind::Image, host, window, cx));
    let page = window.root(cx).unwrap();
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    vcx.update(|window, _| window.activate_window());
    vcx.simulate_resize(size(px(1000.), px(760.)));
    wait_for(&mut vcx, |cx| {
        page.read_with(cx, |p, _| p.ready() || p.trouble().is_some())
    });
    (page, vcx)
}

/// The quadrants' order in a BGRA picture: red top left, white bottom right.
fn shows_the_quadrants(pic: &Picture) {
    let bytes = pic.image.as_bytes(0).unwrap();
    let px = |x: u32, y: u32| {
        let i = ((y * pic.width + x) * 4) as usize;
        [bytes[i + 2], bytes[i + 1], bytes[i]]
    };
    let (w, h) = (pic.width, pic.height);
    let [r, g, b] = px(w / 4, h / 4);
    assert!(r > 150 && g < 90 && b < 90, "top left {r} {g} {b}");
    let [r, g, b] = px(3 * w / 4, 3 * h / 4);
    assert!(r > 200 && g > 200 && b > 200, "bottom right {r} {g} {b}");
}

fn new_library() -> (tempfile::TempDir, Workspace, String) {
    let dir = tempfile::tempdir().unwrap();
    let lib = dr_store::Library::open(dir.path().join("lib"), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let book = ws
        .call(&Actor::User, "project.create", json!({"name": "相册"}))
        .unwrap()["output"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    (dir, ws, book)
}

#[gpui::test]
fn heic_and_avif_added_to_the_library_keep_their_bytes_and_show(cx: &mut TestAppContext) {
    let (dir, ws, book) = new_library();
    shell(cx, &ws);
    let (panel, mut vcx) = panel(cx, &ws, &book);
    let file = |name: &str, bytes: &[u8]| {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    };
    let mut broken_heic = b"\0\0\0\x18ftypheic\0\0\0\0mif1heic".to_vec();
    broken_heic.extend_from_slice(&[0u8; 64]);
    let paths = vec![
        file("IMG_0001.HEIC", dr_testkit::media::HEIC),
        file("网页存图.avif", dr_testkit::media::AVIF),
        file("坏的.heic", &broken_heic),
        file("坏的.png", b"\x89PNG\r\n\x1a\nnot really"),
        file("提纲.docx", b"not a picture"),
    ];
    panel.update(&mut vcx, |p, cx| p.import_paths(paths, None, cx));
    wait_for(&mut vcx, |cx| !panel.read_with(cx, |p, _| p.importing()));
    let made = Book::load(&ws, &book).unwrap().material_items().to_vec();
    let titles: Vec<&str> = made.iter().map(|m| m.title.as_str()).collect();
    // The damaged HEIC is left out as the damaged PNG is (the library takes
    // no image without its size), and so is the Word file.
    assert_eq!(made.len(), 2, "the HEIC and the AVIF: {titles:?}");
    // Nothing of the files left out stays in the store.
    let sources = ws
        .library()
        .assets_of_book(&book)
        .unwrap()
        .into_iter()
        .filter(|r| r.variant == Variant::Source)
        .count();
    assert_eq!(sources, 2);
    let asset_of = |title: &str| {
        made.iter()
            .find(|m| m.title == title)
            .unwrap_or_else(|| panic!("{title} in {titles:?}"))
            .asset
            .clone()
            .unwrap()
    };
    let store = ws.library();
    for (title, bytes, mime) in [
        ("IMG_0001", dr_testkit::media::HEIC, "image/heic"),
        ("网页存图", dr_testkit::media::AVIF, "image/avif"),
    ] {
        let asset = asset_of(title);
        // The source is the file as it was.
        let source = store.asset(&asset, Variant::Source).unwrap().unwrap();
        assert_eq!(source.mime, mime);
        assert_eq!((source.width, source.height), (Some(600), Some(400)));
        assert_eq!(std::fs::read(&source.path).unwrap(), bytes, "{title}");
        // Beside it, JPEG copies the system decoded.
        let display = store.asset(&asset, Variant::Display).unwrap().unwrap();
        assert_eq!(display.mime, "image/jpeg");
        assert_eq!((display.width, display.height), (Some(600), Some(400)));
        let thumb = store.asset(&asset, Variant::Thumbnail).unwrap().unwrap();
        assert_eq!(thumb.width, Some(256));
        // The library's thumbnail and the viewer show the picture.
        let pic = thumbnail(&mut vcx, &asset).expect("a thumbnail");
        assert_eq!(pic.width, 256);
        shows_the_quadrants(&pic);
        let id = made.iter().find(|m| m.title == title).unwrap().id.clone();
        let (page, vcx) = viewer(cx, &ws, &book, &id);
        assert!(page.read_with(&vcx, |p, _| p.ready()), "{title}");
        let frame = page.read_with(&vcx, |p, _| p.frame().unwrap());
        assert!((frame.w / frame.h - 1.5).abs() < 0.01, "{frame:?}");
    }
}

/// The 0.1 test library with its image turned into a HEIC of `bytes`: the
/// rows 0.1 writes for one (`image/heic`, 600 × 400, its size and hash) and
/// the bytes at `assets/<book>/<asset>/source.heic`, without the
/// `display.jpg` and `thumbnail.jpg` 0.1 usually keeps beside it (a library
/// that received the file by sync, before 0.1 showed it).
fn legacy_library_with_a_heic(bytes: &[u8]) -> common::Old {
    let old = common::build_v3(true);
    let dir = old
        .root
        .join("assets")
        .join(common::BOOK)
        .join(common::ASSET);
    std::fs::remove_file(dir.join("source.png")).unwrap();
    std::fs::write(dir.join("source.heic"), bytes).unwrap();
    rusqlite::Connection::open(&old.db)
        .unwrap()
        .execute(
            "UPDATE project_asset SET source_mime = 'image/heic', source_size_bytes = ?1, source_sha256 = ?2, width = 600, height = 400 WHERE id = ?3",
            rusqlite::params![bytes.len() as i64, common::sha256_bytes(bytes), common::ASSET],
        )
        .unwrap();
    old
}

/// A JPEG of the quadrants at `width × height`, as 0.1's display and
/// thumbnail copies are.
fn quadrants_jpeg(width: u32, height: u32) -> Vec<u8> {
    let picture = image::load_from_memory(&dr_testkit::media::quadrants(600, 400))
        .unwrap()
        .resize_exact(width, height, image::imageops::FilterType::Triangle)
        .to_rgb8();
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(picture)
        .write_to(
            &mut std::io::Cursor::new(&mut out),
            image::ImageFormat::Jpeg,
        )
        .unwrap();
    out
}

/// Imported with 0.1's copies, a HEIC embedded in prose shows at once: the
/// note that embeds it (the fixture's note embeds its image) draws the
/// display copy, a link to the file shows it on its card, and the
/// manuscript export takes it, with the material library and the viewer
/// never opened and nothing decoded (the copies are 0.1's bytes).
#[gpui::test]
fn a_heic_imported_with_its_0_1_copies_shows_in_prose_cards_and_export_at_once(
    cx: &mut TestAppContext,
) {
    let old = legacy_library_with_a_heic(dr_testkit::media::HEIC);
    let dir = old
        .root
        .join("assets")
        .join(common::BOOK)
        .join(common::ASSET);
    let (display, thumbnail) = (quadrants_jpeg(600, 400), quadrants_jpeg(512, 341));
    std::fs::write(dir.join("display.jpg"), &display).unwrap();
    std::fs::write(dir.join("thumbnail.jpg"), &thumbnail).unwrap();
    let (_target, ws) = import(&old);
    let store = ws.library();
    let held = |variant: Variant| {
        let record = store.asset(common::ASSET, variant).unwrap().unwrap();
        (record.path.clone(), std::fs::read(&record.path).unwrap())
    };
    let (display_path, display_bytes) = held(Variant::Display);
    let (thumbnail_path, thumbnail_bytes) = held(Variant::Thumbnail);
    assert_eq!(display_bytes, display, "0.1's copy, not one made here");
    assert_eq!(thumbnail_bytes, thumbnail);
    assert_eq!(held(Variant::Source).1, dr_testkit::media::HEIC);

    // The note's prose: its embed draws the display copy, a JPEG the
    // `image` crate (GPUI's `img`) reads.
    cx.executor().allow_parking();
    let (book, note) = (common::BOOK.to_owned(), common::NOTE.to_owned());
    let doc = format!("body:{note}/mod-prose");
    let editor_ws = ws.clone();
    let (view, vcx) = cx.add_window_view(move |window, cx| {
        dr_editor::ChapterEditor::open(
            editor_ws,
            &book,
            &doc,
            dr_editor::EditorSettings::default(),
            window,
            cx,
        )
        .unwrap()
    });
    vcx.simulate_resize(size(px(900.), px(800.)));
    draw(vcx);
    let block = view.read_with(vcx, |v, cx| {
        let editor = v.editor().read(cx);
        let id = (0..64)
            .find_map(|line| editor.embed_at(0, line))
            .expect("the note embeds its image")
            .0;
        v.note_embeds().unwrap().material_block(&id).expect("drawn")
    });
    let facts = block.update(vcx, |b, _| b.facts().cloned()).unwrap();
    assert_eq!(facts.kind, "image");
    assert_eq!(facts.picture.as_deref(), Some(display_path.as_path()));
    assert_eq!(facts.thumb.as_deref(), Some(thumbnail_path.as_path()));
    let shown = image::open(facts.picture.unwrap()).unwrap();
    assert_eq!((shown.width(), shown.height()), (600, 400));

    // A link to the file: its card shows the same copy.
    let card = dr_editor::link_card::card_facts(
        &ws,
        common::BOOK,
        &dr_text::autolink::LinkTarget::new(dr_model::kind::EntityKind::Asset, common::ASSET),
    )
    .expect("a card");
    assert_eq!(
        card.asset.and_then(|a| a.picture).as_deref(),
        Some(display_path.as_path())
    );

    // The manuscript: the note exported takes the picture.
    let manuscript = dr_export::read_manuscript(
        &ws,
        common::BOOK,
        &dr_export::Options {
            chapters: Some(vec![common::NOTE.to_owned()]),
            ..Default::default()
        },
        &dr_export::Labels {
            untitled_chapter: "未命名".into(),
            untitled_act: "未命名".into(),
            options: Default::default(),
        },
        "zh-CN",
        None,
        std::time::SystemTime::now(),
    )
    .unwrap();
    let images: Vec<(String, u32, u32)> = manuscript
        .sections
        .iter()
        .flat_map(|s| match s {
            dr_export::Section::Chapter { blocks, .. } => blocks.clone(),
            _ => Vec::new(),
        })
        .filter_map(|b| match b {
            dr_export::Block::Image {
                media_type,
                width,
                height,
                ..
            } => Some((media_type, width, height)),
            _ => None,
        })
        .collect();
    assert_eq!(images, vec![("image/jpeg".to_owned(), 600, 400)]);
}

/// `old` imported into a new library, opened as the app opens it.
fn import(old: &common::Old) -> (tempfile::TempDir, Workspace) {
    let target = tempfile::tempdir().unwrap();
    let root = target.path().join("library");
    let mut options = dr_import_v1::run::Options::new("test");
    options.v3 = common::v3_choices();
    options.old_root = Some(old.root.clone());
    options.index = false;
    options.accept = dr_import_v1::gate::Accept::EVERYTHING;
    let (outcome, _) = dr_import_v1::run::import(&old.db, &root, &options).unwrap();
    assert!(matches!(outcome, dr_import_v1::run::Outcome::Imported(_)));
    let ws = Workspace::open_dir(&root, "test").unwrap();
    (target, ws)
}

fn imported_material(ws: &Workspace) -> String {
    Book::load(ws, common::BOOK)
        .unwrap()
        .material_items()
        .iter()
        .find(|m| m.asset.as_deref() == Some(common::ASSET))
        .unwrap()
        .id
        .clone()
}

#[gpui::test]
fn a_heic_imported_from_0_1_shows_and_keeps_its_copies(cx: &mut TestAppContext) {
    let old = legacy_library_with_a_heic(dr_testkit::media::HEIC);
    let (_target, ws) = import(&old);
    let store = ws.library();
    // 0.1 had no copies: the import carries the source alone, as it was.
    let source = store
        .asset(common::ASSET, Variant::Source)
        .unwrap()
        .unwrap();
    assert_eq!(source.mime, "image/heic");
    assert_eq!(
        std::fs::read(&source.path).unwrap(),
        dr_testkit::media::HEIC
    );
    assert!(
        store
            .asset(common::ASSET, Variant::Display)
            .unwrap()
            .is_none()
    );
    let material = imported_material(&ws);
    let kind = Book::load(&ws, common::BOOK)
        .unwrap()
        .material_info(&material)
        .unwrap()
        .kind
        .clone();
    assert_eq!(kind, "image");

    shell(cx, &ws);
    let (_panel, mut vcx) = panel(cx, &ws, common::BOOK);
    // Shown in the library: the thumbnail is decoded by the system, and the
    // copies are made and kept for every other view.
    let pic = thumbnail(&mut vcx, common::ASSET).expect("a thumbnail");
    assert_eq!(pic.width, 256);
    shows_the_quadrants(&pic);
    let display = store
        .asset(common::ASSET, Variant::Display)
        .unwrap()
        .unwrap();
    assert_eq!(display.mime, "image/jpeg");
    assert_eq!((display.width, display.height), (Some(600), Some(400)));
    assert!(
        store
            .asset(common::ASSET, Variant::Thumbnail)
            .unwrap()
            .is_some()
    );
    // The source is untouched: the same row, the same bytes.
    assert_eq!(
        store.asset(common::ASSET, Variant::Source).unwrap(),
        Some(source.clone())
    );
    assert_eq!(
        std::fs::read(&source.path).unwrap(),
        dr_testkit::media::HEIC
    );
    // And the viewer shows it.
    let (page, vcx) = viewer(cx, &ws, common::BOOK, &material);
    assert!(page.read_with(&vcx, |p, _| p.ready()));
    let frame = page.read_with(&vcx, |p, _| p.frame().unwrap());
    assert!((frame.w / frame.h - 1.5).abs() < 0.01, "{frame:?}");
}

/// Opened in the viewer first (no library panel), an imported HEIC is
/// decoded and its copies made there too.
#[gpui::test]
fn a_heic_imported_from_0_1_opens_in_the_viewer(cx: &mut TestAppContext) {
    let old = legacy_library_with_a_heic(dr_testkit::media::HEIC);
    let (_target, ws) = import(&old);
    let material = imported_material(&ws);
    shell(cx, &ws);
    let (page, vcx) = viewer(cx, &ws, common::BOOK, &material);
    assert!(page.read_with(&vcx, |p, _| p.ready()));
    let store = ws.library();
    assert!(
        store
            .asset(common::ASSET, Variant::Display)
            .unwrap()
            .is_some()
    );
    assert!(
        store
            .asset(common::ASSET, Variant::Thumbnail)
            .unwrap()
            .is_some()
    );
}

/// Imported from 0.1, a HEIC the system cannot decode here (damaged, or on
/// Windows without the Store's extensions) is kept and shows as an image
/// that cannot be decoded: the row keeps its stand-in, the viewer says so,
/// no copies are made, nothing crashes.
#[gpui::test]
fn an_imported_heic_this_system_cannot_decode_stays_an_undecodable_image(cx: &mut TestAppContext) {
    let mut damaged = b"\0\0\0\x18ftypheic\0\0\0\0mif1heic".to_vec();
    damaged.extend_from_slice(&[7u8; 96]);
    let old = legacy_library_with_a_heic(&damaged);
    let (_target, ws) = import(&old);
    let material = imported_material(&ws);
    shell(cx, &ws);
    let (_panel, mut vcx) = panel(cx, &ws, common::BOOK);
    assert!(thumbnail(&mut vcx, common::ASSET).is_none());
    let (page, vcx) = viewer(cx, &ws, common::BOOK, &material);
    assert!(matches!(
        page.read_with(&vcx, |p, _| p.trouble().cloned()),
        Some(Trouble::Image(_))
    ));
    let store = ws.library();
    assert!(
        store
            .asset(common::ASSET, Variant::Display)
            .unwrap()
            .is_none()
    );
    let source = store
        .asset(common::ASSET, Variant::Source)
        .unwrap()
        .unwrap();
    assert_eq!(std::fs::read(source.path).unwrap(), damaged);
}
