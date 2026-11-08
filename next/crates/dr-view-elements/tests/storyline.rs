//! The storyline page (M13) on GPUI's test platform over dr-testkit's
//! 《慢钟》 (through F3): opening a storyline puts its head and its fields
//! and chapter sequence around the text; the name and summary save as in
//! the 0.1 client; fields write to the storyline; the sequence lists its
//! chapters in reading order with the written / not started filter; the ⋯
//! menu's delete asks with the 0.1 confirmation and trashes it; the colour
//! swatch opens the picker and writes the colour once it is still; the
//! chapter template opens on a click and is what a new chapter starts with.

use std::time::{Duration, Instant};

use dr_shell::nav::{Open, Target};
use dr_shell::pages::PageMenuHost;
use dr_shell::workspace::page_actions::page_actions;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_elements::dialogs::{AskFor, Asking};
use dr_view_elements::storyline::{ChapterFilter, StorylineEnd, StorylineHead};
use dr_workspace::{
    Actor, Workspace as Library,
    commands::{ListIn, chapter::ChapterList, storyline::StorylineList},
    dto::StorylineInfo,
};
use gpui::{Entity, Focusable as _, Modifiers, TestAppContext, VisualTestContext};

const VERSION: &str = "0.2.0-dev";

fn library() -> (tempfile::TempDir, Library, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION)).unwrap();
    let book = dr_testkit::samples::slow_clock().unwrap();
    dr_testkit::seed::write_book(&lib, &book).unwrap();
    lib.close().unwrap();
    let id = book.book.book_id().to_string();
    (dir, Library::open_dir(&root, VERSION).unwrap(), id)
}

fn setup(cx: &mut TestAppContext, library: Library) -> (Entity<Workspace>, &mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: VERSION,
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(library),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_elements::init(cx);
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.update(|window, _| window.activate_window());
    cx.run_until_parked();
    (view, cx)
}

fn frame(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.run_until_parked();
}

fn wait_for(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        frame(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn storylines(lib: &Library, book: &str) -> Vec<StorylineInfo> {
    lib.run::<StorylineList>(
        &Actor::User,
        ListIn {
            book: book.to_owned(),
            trashed: false,
        },
    )
    .unwrap()
    .output
}

fn storyline(lib: &Library, book: &str, id: &str) -> StorylineInfo {
    storylines(lib, book)
        .into_iter()
        .find(|l| l.id == id)
        .unwrap()
}

fn open(
    view: &Entity<Workspace>,
    id: &str,
    cx: &mut VisualTestContext,
) -> (Entity<StorylineHead>, Entity<StorylineEnd>) {
    wait_for(cx, |cx| view.read_with(cx, |ws, _| !ws.book.is_empty()));
    let target = Target::Storyline(id.parse().unwrap());
    view.update(cx, |ws, cx| ws.open(target, Open::KEEP, cx));
    wait_for(cx, |cx| {
        cx.update(|_, cx| dr_view_elements::storyline_page(id, cx).is_some())
    });
    cx.update(|_, cx| dr_view_elements::storyline_page(id, cx).unwrap())
}

/// Types into a field with the caret in it, then leaves it.
fn type_and_leave(
    view: &Entity<Workspace>,
    field: &Entity<dr_ui::input::area::TextArea>,
    text: &str,
    cx: &mut VisualTestContext,
) {
    cx.update(|window, cx| field.focus_handle(cx).focus(window, cx));
    frame(cx);
    cx.update(|_, cx| field.update(cx, |f, cx| f.set_text(text, cx)));
    cx.update(|window, cx| view.read(cx).focus_handle().clone().focus(window, cx));
    frame(cx);
}

#[gpui::test]
fn the_storyline_page_saves_its_name_summary_and_fields(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    let tower = storylines(&lib, &book)
        .into_iter()
        .find(|l| l.name == "钟楼")
        .unwrap();
    let (head, end) = open(&view, &tower.id, cx);
    let (name, summary) = head.read_with(cx, |h, _| h.fields());
    wait_for(cx, |cx| name.read_with(cx, |f, _| f.text()) == "钟楼");
    assert_eq!(summary.read_with(cx, |f, _| f.text()), tower.summary);
    // The name and the summary save when the caret leaves.
    type_and_leave(&view, &name, "钟楼（主线）", cx);
    let id = tower.id.clone();
    wait_for(cx, |_| storyline(&lib, &book, &id).name == "钟楼（主线）");
    type_and_leave(&view, &summary, "钟停在四点十七分。\n三十二年。", cx);
    wait_for(cx, |_| {
        storyline(&lib, &book, &id).summary == "钟停在四点十七分。\n三十二年。"
    });
    // A field added under the text is the storyline's.
    let fields = end.read_with(cx, |e, _| e.fields.clone());
    let before = storyline(&lib, &book, &id).fields.len();
    cx.update(|window, cx| fields.update(cx, |f, cx| f.add_row(window, cx)));
    frame(cx);
    let (_, key, value) = fields.read_with(cx, |f, _| f.rows().pop().unwrap());
    cx.update(|_, cx| {
        key.update(cx, |f, cx| f.set_text("视角", cx));
        value.update(cx, |f, cx| f.set_text("知微", cx));
    });
    cx.update(|window, cx| view.read(cx).focus_handle().clone().focus(window, cx));
    frame(cx);
    wait_for(cx, |_| {
        let fields = storyline(&lib, &book, &id).fields;
        fields.len() == before + 1 && fields.iter().any(|f| f.key == "视角" && f.value == "知微")
    });
}

#[gpui::test]
fn the_chapter_sequence_lists_and_filters(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    let tower = storylines(&lib, &book)
        .into_iter()
        .find(|l| l.name == "钟楼")
        .unwrap();
    let (_, end) = open(&view, &tower.id, cx);
    let chapters = lib
        .run::<ChapterList>(
            &Actor::User,
            ListIn {
                book: book.clone(),
                trashed: false,
            },
        )
        .unwrap()
        .output;
    let on_tower: Vec<String> = chapters
        .iter()
        .filter(|c| c.storylines.contains(&tower.id))
        .map(|c| c.id.clone())
        .collect();
    assert!(!on_tower.is_empty());
    wait_for(cx, |cx| {
        end.read_with(cx, |e, _| e.listed().len()) == on_tower.len()
    });
    // In reading order, primary and secondary members alike.
    let listed: Vec<String> =
        end.read_with(cx, |e, _| e.listed().into_iter().map(|c| c.id).collect());
    assert_eq!(listed, on_tower);
    // Written and not started split them.
    end.update(cx, |e, cx| e.set_filter(ChapterFilter::Written, cx));
    let written = end.read_with(cx, |e, _| e.listed());
    assert!(written.iter().all(|c| c.words > 0));
    end.update(cx, |e, cx| e.set_filter(ChapterFilter::NotStarted, cx));
    let not_started = end.read_with(cx, |e, _| e.listed());
    assert!(not_started.iter().all(|c| c.words == 0));
    assert_eq!(written.len() + not_started.len(), on_tower.len());
}

#[gpui::test]
fn deleting_a_storyline_asks_then_trashes_it(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    let late = storylines(&lib, &book)
        .into_iter()
        .find(|l| l.name == "晚秋")
        .unwrap();
    open(&view, &late.id, cx);
    let target = Target::Storyline(late.id.parse().unwrap());
    // The ⋯ menu as the shell lists it: share, the snapshot history, then
    // 删除故事线 with what deletes.
    let host = view.read_with(cx, |ws, _| PageMenuHost {
        workspace: view.downgrade(),
        library: ws.library.clone(),
        book_id: ws.book_id.clone(),
        book: ws.book.clone(),
    });
    let sections = cx.update(|_, cx| page_actions(&view, &host, &target, cx));
    let ids: Vec<Vec<String>> = sections
        .iter()
        .map(|s| s.items.iter().map(|i| i.id.to_string()).collect())
        .collect();
    assert_eq!(
        ids,
        [
            vec!["page-share"],
            vec!["page-history"],
            vec!["storyline-delete"]
        ]
    );
    let row = &sections[2].items[0];
    assert!(row.danger);
    let run = row.run.clone();
    cx.update(|window, cx| run(window, cx));
    frame(cx);
    let dialogs = cx.update(|_, cx| dr_view_elements::dialogs::dialogs(cx).unwrap());
    assert_eq!(
        dialogs.read_with(cx, |d, _| d.asking()),
        Some(Asking::DeleteStoryline(late.id.clone()))
    );
    cx.update(|window, cx| dialogs.update(cx, |d, cx| d.confirm_delete(window, cx)));
    wait_for(cx, |cx| dialogs.read_with(cx, |d, _| d.asking().is_none()));
    assert!(storylines(&lib, &book).iter().all(|l| l.id != late.id));
    wait_for(cx, |cx| {
        view.read_with(cx, |ws, _| !ws.nav.is_selected(&target))
    });
    // Opening the dialog directly asks the same.
    let ws = view.downgrade();
    let other = storylines(&lib, &book)[0].id.clone();
    cx.update(|window, cx| {
        dr_view_elements::dialogs::open(AskFor::DeleteStoryline(other.clone()), ws, window, cx)
    });
    frame(cx);
    cx.simulate_keystrokes("escape");
    frame(cx);
    assert!(storylines(&lib, &book).iter().any(|l| l.id == other));
}

#[gpui::test]
fn the_swatch_picks_a_colour_and_writes_it_once_still(cx: &mut TestAppContext) {
    use std::cell::RefCell;
    use std::rc::Rc;

    use dr_ui::components::color::{self, OnPick};
    use dr_ui::tokens::Rgb;

    let (_dir, library, book) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    // The picker the swatch opens: it keeps the callback, as the system
    // panel would while the author drags across it.
    let opened: Rc<RefCell<Option<OnPick>>> = Rc::default();
    cx.update(|_, cx| {
        let opened = opened.clone();
        color::set_color_picker(cx, move |_, on_pick, _, _| {
            *opened.borrow_mut() = Some(on_pick);
        });
    });
    let tower = storylines(&lib, &book)
        .into_iter()
        .find(|l| l.name == "钟楼")
        .unwrap();
    let (_head, _) = open(&view, &tower.id, cx);
    frame(cx);
    let swatch = cx
        .debug_bounds("storyline-color")
        .expect("the swatch is drawn");
    cx.simulate_click(swatch.center(), Modifiers::none());
    let on_pick = opened.borrow().clone().expect("the picker opened");
    // Three colours in a row, as a drag across the panel gives them.
    for hex in [0x112233, 0x445566, 0x8a3b2c] {
        cx.update(|window, cx| on_pick(Rgb::hex(hex), window, cx));
        frame(cx);
    }
    // Shown at once, written only once the picker is still.
    let id = tower.id.clone();
    assert_eq!(storyline(&lib, &book, &id).color, tower.color);
    cx.executor()
        .advance_clock(dr_view_elements::swatch::SETTLE);
    wait_for(cx, |_| storyline(&lib, &book, &id).color == "#8a3b2c");
    // One pick, one undo step: the colour before it comes back.
    lib.undo(&Actor::User).unwrap();
    assert_eq!(storyline(&lib, &book, &id).color, tower.color);
}

#[gpui::test]
fn the_chapter_template_opens_on_a_click_and_new_chapters_start_from_it(cx: &mut TestAppContext) {
    use dr_workspace::commands::{
        chapter::{ChapterCreate, ChapterCreateIn},
        template::{ChapterTemplateBody, StorylineIn},
    };
    use gpui::EntityInputHandler as _;

    let (_dir, library, book) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    let tower = storylines(&lib, &book)
        .into_iter()
        .find(|l| l.name == "钟楼")
        .unwrap();
    assert!(!tower.has_chapter_template);
    let (_, end) = open(&view, &tower.id, cx);
    frame(cx);
    let template = end
        .read_with(cx, |e, _| e.template.clone())
        .expect("the section is drawn");
    // Opening the page wrote nothing: the placeholder, no document yet.
    assert!(!template.read_with(cx, |t, _| t.is_open()));
    let body = |lib: &Library| {
        lib.run::<ChapterTemplateBody>(
            &Actor::User,
            StorylineIn {
                book: book.clone(),
                storyline: tower.id.clone(),
            },
        )
        .unwrap()
        .output
    };
    assert!(body(&lib).is_empty());
    // A click on it makes the document and puts the caret in.
    let closed = cx
        .debug_bounds("storyline-template-closed")
        .expect("the placeholder is drawn");
    cx.simulate_click(closed.center(), Modifiers::none());
    wait_for(cx, |cx| template.read_with(cx, |t, _| t.is_open()));
    let editor = template.read_with(cx, |t, _| t.editor().unwrap());
    let prose = editor.read_with(cx, |e, _| e.editor().clone());
    assert!(cx.update(|window, cx| prose.focus_handle(cx).is_focused(window)));
    // An H1 typed as Markdown, then body text.
    for c in "# 起因".chars() {
        let s = c.to_string();
        prose.update_in(cx, |e, window, cx| {
            e.replace_text_in_range(None, &s, window, cx)
        });
    }
    frame(cx);
    wait_for(cx, |_| {
        body(&lib)
            .first()
            .is_some_and(|p| p.heading == Some(1) && p.text == "起因")
    });
    assert!(storyline(&lib, &book, &tower.id).has_chapter_template);
    // A new chapter on this storyline starts from it.
    let made = lib
        .run::<ChapterCreate>(
            &Actor::User,
            ChapterCreateIn {
                book: book.clone(),
                title: String::new(),
                place: None,
                summary: String::new(),
                storyline: Some(tower.id.clone()),
                text: None,
                narrative_order: None,
            },
        )
        .unwrap()
        .output;
    let first = lib
        .run::<dr_workspace::commands::prose::ProseRead>(
            &Actor::User,
            dr_workspace::commands::prose::ProseReadIn {
                doc: format!("node:{}", made.id),
                from: 0,
                limit: None,
            },
        )
        .unwrap()
        .output
        .paragraphs
        .into_iter()
        .next()
        .expect("a paragraph");
    assert_eq!((first.heading, first.text.as_str()), (1, "起因"));
}

#[gpui::test]
fn a_template_written_elsewhere_opens_when_it_arrives(cx: &mut TestAppContext) {
    use dr_workspace::commands::template::{
        ChapterTemplateSetBody, SetChapterTemplateIn, TemplateParagraph,
    };

    let (_dir, library, book) = library();
    let lib = library.clone();
    let tower = storylines(&lib, &book)
        .into_iter()
        .find(|l| l.name == "钟楼")
        .unwrap();
    let (view, cx) = setup(cx, library);
    let (_, end) = open(&view, &tower.id, cx);
    frame(cx);
    let template = end.read_with(cx, |e, _| e.template.clone().unwrap());
    assert!(!template.read_with(cx, |t, _| t.is_open()));
    // Written while the page is open (the Agent, another window): only the
    // template's own document changes, the book's facts do not.
    lib.run::<ChapterTemplateSetBody>(
        &Actor::User,
        SetChapterTemplateIn {
            book: book.clone(),
            storyline: tower.id.clone(),
            paragraphs: vec![
                TemplateParagraph {
                    heading: Some(2),
                    text: "钟楼里".into(),
                },
                TemplateParagraph {
                    heading: None,
                    text: "从钟声停下写起。".into(),
                },
            ],
        },
    )
    .unwrap();
    wait_for(cx, |cx| template.read_with(cx, |t, _| t.is_open()));
    let editor = template.read_with(cx, |t, _| t.editor().unwrap());
    wait_for(cx, |cx| {
        editor
            .read_with(cx, |e, cx| e.plain_text(cx))
            .contains("钟楼里")
    });
}
