//! T1 (`kernel-v5.md` §8, §16 「条目页」): an entry page has one head, its
//! mark and its title, where every entry is renamed; a lane's page is the
//! shell's own entry page, its body found, counted and commented like any.
use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace,
    nav::{Open, Target},
};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{Entity, TestAppContext, VisualTestContext};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn call(lib: &Library, name: &str, input: Value) -> Value {
    lib.call(&Actor::User, name, input).unwrap()["output"].clone()
}
fn fixture() -> (tempfile::TempDir, Library, String) {
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
    (dir, lib, book)
}
fn of_template(lib: &Library, book: &str, template: &str) -> String {
    call(lib, "entry.list", json!({"book":book,"all":true}))
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == template)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
fn target(entry: &str, module: Option<&str>) -> Target {
    Target::Entry {
        id: entry.parse().unwrap(),
        module: module.map(|m| m.parse().unwrap()),
    }
}
fn wait(
    cx: &mut VisualTestContext,
    what: &str,
    mut done: impl FnMut(&mut VisualTestContext) -> bool,
) {
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
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
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
        dr_shell::strings::Strings::install(dr_i18n::Locale::ZhCn, cx);
        dr_view_page::init(cx);
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.update(|w, _| w.activate_window());
    wait(cx, "the book", |cx| {
        view.read_with(cx, |w, _| w.book.v3().is_some())
    });
    (view, cx)
}

#[gpui::test]
fn a_chapter_page_has_one_title_and_the_whole_book_titles_each_chapter(cx: &mut TestAppContext) {
    let (_dir, lib, book) = fixture();
    let chapter = of_template(&lib, &book, "tpl-chapter");
    let manuscript = of_template(&lib, &book, "tpl-manuscript");
    let (view, cx) = setup(cx, &lib, &book);
    let page = target(&chapter, Some("mod-prose"));
    view.update(cx, |w, cx| w.open(page.clone(), Open::KEEP, cx));
    wait(cx, "the chapter's body", |cx| {
        view.read_with(cx, |w, _| w.editor_of(&page).is_some())
    });
    let doc = format!("body:{chapter}/mod-prose");
    wait(cx, "the chapter's heads", |cx| {
        cx.update(|_, cx| {
            dr_view_page::entry_head::head_of(&chapter, cx).is_some()
                && dr_view_page::page_views(&doc, cx).is_some()
        })
    });
    cx.update(|_, cx| {
        let (body_head, _) = dr_view_page::page_views(&doc, cx).unwrap();
        assert!(
            !body_head.read(cx).shows_title(),
            "the body draws no title of its own on the entry's page"
        );
        let head = dr_view_page::entry_head::head_of(&chapter, cx).unwrap();
        let title = head.read(cx).title().read(cx).text();
        assert!(!title.is_empty(), "the page's head is the title");
    });
    // The whole book: each chapter titled in the scroll.
    let whole = Target::Book(manuscript.parse().unwrap());
    view.update(cx, |w, cx| w.open(whole.clone(), Open::KEEP, cx));
    wait(cx, "the whole book's heads", |cx| {
        cx.update(|_, cx| {
            dr_view_page::page_views(&doc, cx).is_some_and(|(h, _)| h.read(cx).shows_title())
        })
    });
}

#[gpui::test]
fn a_category_a_group_and_a_storyline_are_renamed_in_their_page_head(cx: &mut TestAppContext) {
    let (_dir, lib, book) = fixture();
    let category = of_template(&lib, &book, "tpl-category");
    let storyline = of_template(&lib, &book, "tpl-storyline");
    let ideas = of_template(&lib, &book, "tpl-ideas");
    let group = call(
        &lib,
        "entry.create",
        json!({"book":book,"parent":ideas,"template":"tpl-idea-group","title":"Synthetic group"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (view, cx) = setup(cx, &lib, &book);
    for (entry, name) in [
        (&category, "改名的分类"),
        (&group, "改名的分组"),
        (&storyline, "改名的故事线"),
    ] {
        view.update(cx, |w, cx| w.open(target(entry, None), Open::KEEP, cx));
        wait(cx, "the page head", |cx| {
            cx.update(|_, cx| dr_view_page::entry_head::head_of(entry, cx).is_some())
        });
        let head = cx.update(|_, cx| dr_view_page::entry_head::head_of(entry, cx).unwrap());
        head.update(cx, |h, cx| {
            h.title().update(cx, |f, cx| f.set_text(name, cx));
            h.store_title(cx);
        });
        wait(cx, "the rename", |cx| {
            view.read_with(cx, |w, _| {
                w.book.v3().unwrap().entry(entry).unwrap().title == name
            })
        });
    }
    // The storyline's page is the shell's entry page (no page of its own).
    view.read_with(cx, |w, _| {
        assert!(w.editors[&target(&storyline, None).key()].v3.is_some());
    });
}

#[gpui::test]
fn a_storyline_page_body_is_found_counted_and_commented_like_any(cx: &mut TestAppContext) {
    let (_dir, lib, book) = fixture();
    let (view, cx) = setup(cx, &lib, &book);
    // A storyline in the view (its colour shows), opened from the left
    // column (no module named).
    let (lane, module) = view.read_with(cx, |w, _| {
        let v = w.book.v3().unwrap();
        let lane = v
            .entries
            .iter()
            .find(|e| e.template.as_deref() == Some("tpl-storyline") && v.is_lane(&e.id))
            .unwrap();
        let module = v
            .template_of(&lane.id)
            .unwrap()
            .modules
            .iter()
            .find(|m| m.kind == "prose")
            .unwrap()
            .id
            .clone();
        (lane.id.clone(), module)
    });
    call(
        &lib,
        "module.set_prose",
        json!({"book":book,"owner":lane,"module":module,"paragraphs":[{"text":"Synthetic storyline words"}]}),
    );
    let page = target(&lane, None);
    let body = target(&lane, Some(&module));
    view.update(cx, |w, cx| w.open(page.clone(), Open::KEEP, cx));
    wait(cx, "the storyline's body", |cx| {
        view.read_with(cx, |w, _| w.editor_of(&body).is_some())
    });
    let editor = view.read_with(cx, |w, _| {
        assert!(w.editors[&page.key()].v3.is_some(), "the shell's own page");
        w.editor_of(&body).unwrap().clone()
    });
    let doc = format!("body:{lane}/{module}");
    // Live count.
    wait(cx, "the live count", |cx| {
        cx.update(|_, cx| dr_view_stats::LiveWords::read(cx).docs.contains_key(&doc))
    });
    // Find.
    editor.update_in(cx, |e, w, cx| {
        let p = e.editor().clone();
        p.update(cx, |p, cx| {
            use gpui::Focusable as _;
            p.focus_handle(cx).focus(w, cx);
            p.select(0, 0..9, w, cx);
        });
    });
    view.update_in(cx, |w, window, cx| w.open_find(window, cx));
    let find = view.read_with(cx, |w, _| w.find.clone().unwrap());
    assert_eq!(
        find.read_with(cx, |f, _| f.prose.entity_id()),
        editor.read_with(cx, |e, _| e.editor().entity_id())
    );
    view.update_in(cx, |w, window, cx| w.close_find(window, cx));
    // A comment on the selection.
    cx.simulate_keystrokes("secondary-alt-m");
    wait(cx, "the composer", |cx| {
        view.read_with(cx, |w, _| w.composer.is_some())
    });
    let composer = view.read_with(cx, |w, _| w.composer.as_ref().unwrap().view().clone());
    composer.update(cx, |c, cx| {
        c.set_text("Synthetic storyline comment", cx);
        c.save(cx);
    });
    wait(cx, "the comment", |cx| {
        view.read_with(cx, |w, _| w.composer.is_none())
    });
    let comments = dr_editor::v3::read(&lib, &book, |v| v.comments()).unwrap();
    assert!(comments.iter().any(|c| {
        c.target_module
            .as_ref()
            .is_some_and(|m| m.as_str() == module)
            && c.body == "Synthetic storyline comment"
    }));
}

// The entry page's title keeps the page-head drafts' rules (moved here from
// `tests/v3.rs` with the title itself, kernel v5 T1).

/// The head of `entry`'s page on its own in a window, as the entry page
/// mounts it.
fn standalone_head(
    cx: &mut TestAppContext,
    lib: &Library,
    book: &str,
    entry: &str,
) -> (
    Entity<dr_view_page::entry_head::EntryHead>,
    VisualTestContext,
) {
    use dr_shell::{book::Book, pages::PageViewHost, v3::EntryHost};
    cx.executor().allow_parking();
    cx.update(|cx| {
        if cx.try_global::<dr_shell::strings::Strings>().is_none() {
            dr_shell::init(
                ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "test",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: Some(dr_ui::Appearance::Light),
                },
                Services::default(),
                SettingsFile::in_memory(),
                cx,
            );
        }
    });
    let host = EntryHost {
        page: PageViewHost {
            workspace: gpui::WeakEntity::new_invalid(),
            library: lib.clone(),
            book_id: book.to_owned(),
            book: std::rc::Rc::new(Book::load(lib, book).unwrap()),
        },
        entry: entry.to_owned(),
    };
    let window =
        cx.add_window(|window, cx| dr_view_page::entry_head::EntryHead::new(host, window, cx));
    let head = window.root(cx).unwrap();
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    vcx.update(|window, _| window.activate_window());
    vcx.simulate_resize(gpui::size(gpui::px(900.), gpui::px(600.)));
    wait(&mut vcx, "the head", |_| true);
    (head, vcx)
}

fn type_title(
    head: &Entity<dr_view_page::entry_head::EntryHead>,
    text: &str,
    cx: &mut VisualTestContext,
) -> Entity<dr_ui::input::TextArea> {
    use gpui::{EntityInputHandler as _, Focusable as _};
    let input = head.read_with(cx, |h, _| h.title().clone());
    input.update_in(cx, |a, w, cx| {
        a.focus_handle(cx).focus(w, cx);
        a.select_all_text(cx);
        a.replace_text_in_range(None, text, w, cx);
    });
    input
}

fn title_of(lib: &Library, book: &str, entry: &str) -> Value {
    call(lib, "entry.get", json!({"book":book,"id":entry}))["title"].clone()
}

/// The title being typed is stored before the app quits.
#[gpui::test]
fn a_title_being_typed_is_stored_before_quit(cx: &mut TestAppContext) {
    use std::{cell::Cell, rc::Rc};
    let (_dir, lib, book) = fixture();
    let entry = of_template(&lib, &book, "tpl-chapter");
    let (head, mut cx) = standalone_head(cx, &lib, &book, &entry);
    cx.update(|_, cx| cx.global_mut::<Services>().library = Some(lib.clone()));
    type_title(&head, "accepted head draft", &mut cx);
    let quit = Rc::new(Cell::new(false));
    let seen = quit.clone();
    cx.update(|_, cx| {
        dr_shell::quit::before_quit(cx, move |_| seen.set(true));
        dr_shell::quit::request(cx);
    });
    let until = Instant::now() + Duration::from_secs(15);
    while !quit.get() {
        cx.executor().advance_clock(Duration::from_millis(10));
        cx.run_until_parked();
        cx.update(|w, cx| w.draw(cx).clear(cx));
        assert!(Instant::now() < until);
    }
    assert_eq!(title_of(&lib, &book, &entry), "accepted head draft");
}

/// A title set elsewhere while the author types is not overwritten: the
/// library swap is refused, the typed title stays (Esc cannot drop it).
#[gpui::test]
fn a_title_set_elsewhere_keeps_the_typed_one_and_blocks_replacement(cx: &mut TestAppContext) {
    use std::{cell::RefCell, rc::Rc};
    let (_dir, lib, book) = fixture();
    let entry = of_template(&lib, &book, "tpl-chapter");
    let (head, mut cx) = standalone_head(cx, &lib, &book, &entry);
    cx.update(|_, cx| cx.global_mut::<Services>().library = Some(lib.clone()));
    let input = type_title(&head, "accepted head draft", &mut cx);
    call(
        &lib,
        "entry.update",
        json!({"book":book,"id":entry,"title":"external metadata"}),
    );
    let result = Rc::new(RefCell::new(None));
    let seen = result.clone();
    cx.update(|_, cx| {
        dr_shell::library::replace(
            cx,
            |_, _| unreachable!("a conflicting title must block replacement"),
            move |r, _| *seen.borrow_mut() = Some(r),
        )
    });
    let until = Instant::now() + Duration::from_secs(15);
    while result.borrow().is_none() {
        cx.executor().advance_clock(Duration::from_millis(10));
        cx.run_until_parked();
        cx.update(|w, cx| w.draw(cx).clear(cx));
        assert!(Instant::now() < until);
    }
    assert!(result.borrow().as_ref().unwrap().is_err());
    assert!(head.read_with(&cx, |h, _| h.failed()));
    input.update_in(&mut cx, |a, w, cx| {
        use gpui::Focusable as _;
        a.focus_handle(cx).focus(w, cx)
    });
    cx.simulate_keystrokes("escape");
    cx.run_until_parked();
    assert_eq!(input.read_with(&cx, |a, _| a.text()), "accepted head draft");
    assert_eq!(title_of(&lib, &book, &entry), "external metadata");
    cx.update(|_, cx| assert!(!dr_shell::release::is_releasing(cx)));
}

/// Once stored, an older snapshot never puts the old title back, nor does
/// Esc.
#[gpui::test]
fn cancelling_after_save_never_rewrites_old_page_facts(cx: &mut TestAppContext) {
    let (_dir, lib, book) = fixture();
    let entry = of_template(&lib, &book, "tpl-chapter");
    let old = std::rc::Rc::new(dr_shell::book::Book::load(&lib, &book).unwrap());
    let (head, mut cx) = standalone_head(cx, &lib, &book, &entry);
    let input = type_title(&head, "acknowledged title", &mut cx);
    cx.update(|w, cx| w.blur(cx));
    wait(&mut cx, "the stored title", |_| {
        title_of(&lib, &book, &entry) == "acknowledged title"
    });
    head.update(&mut cx, |h, cx| h.refresh(old, cx));
    input.update_in(&mut cx, |a, w, cx| {
        use gpui::Focusable as _;
        a.focus_handle(cx).focus(w, cx)
    });
    let displayed = input.read_with(&cx, |a, _| a.text());
    assert_eq!(displayed, "acknowledged title");
    cx.simulate_keystrokes("escape");
    cx.run_until_parked();
    assert_eq!(input.read_with(&cx, |a, _| a.text()), displayed);
    assert_eq!(title_of(&lib, &book, &entry), "acknowledged title");
}

/// A chapter just made opens with its page's title taking the caret,
/// selected; its body, loading meanwhile, leaves the keyboard alone.
#[gpui::test]
fn a_new_chapter_opens_with_its_title_selected_and_the_body_waits(cx: &mut TestAppContext) {
    use gpui::Focusable as _;
    let (_dir, lib, book) = fixture();
    let chapter = of_template(&lib, &book, "tpl-chapter");
    let (view, cx) = setup(cx, &lib, &book);
    let doc = format!("body:{chapter}/mod-prose");
    cx.update(|_, cx| dr_view_page::focus_new_title(doc.clone(), cx));
    let page = target(&chapter, Some("mod-prose"));
    view.update(cx, |w, cx| w.open(page.clone(), Open::KEEP.at_title(), cx));
    wait(cx, "the title's caret", |cx| {
        cx.update(|window, cx| {
            dr_view_page::entry_head::head_of(&chapter, cx)
                .is_some_and(|h| h.read(cx).title().focus_handle(cx).is_focused(window))
        })
    });
    wait(cx, "the body", |cx| {
        view.read_with(cx, |w, _| w.editor_of(&page).is_some())
    });
    for _ in 0..3 {
        cx.run_until_parked();
        cx.update(|w, cx| w.draw(cx).clear(cx));
    }
    let editor = view.read_with(cx, |w, _| w.editor_of(&page).unwrap().clone());
    cx.update(|window, cx| {
        assert!(!editor.read(cx).editor().focus_handle(cx).is_focused(window));
        let head = dr_view_page::entry_head::head_of(&chapter, cx).unwrap();
        let title = head.read(cx).title().read(cx);
        assert!(title.focus_handle(cx).is_focused(window));
        assert_eq!(title.composer().selection(), 0..title.text().len());
    });
}
