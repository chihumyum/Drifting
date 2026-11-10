//! Real mounted v3 inputs, delayed accepted writes and the shell's ordinary
//! two-library/quit flow. All documents come from the shared synthetic seed.
use crate::{Fields, fields::v3::TypedFields, patches::Patches};
use dr_shell::{Services, SettingsFile, ShellInfo, book::Book};
use dr_ui::input::TextArea;
use dr_view_plot::{Field, PlannerHost, PlotPlanner};
use dr_workspace::{Actor, Workspace};
use gpui::{
    AnyView, App, Context, Entity, EntityInputHandler as _, Focusable as _, Render, TestAppContext,
    VisualTestContext, WeakEntity, Window, div, prelude::*, px, size,
};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug)]
enum Kind {
    Fields,
    Kv,
    Patches,
    Plot,
}
impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Fields => "fields",
            Self::Kv => "kv",
            Self::Patches => "patches",
            Self::Plot => "plot_grid",
        }
    }
    fn module(self) -> &'static str {
        if matches!(self, Self::Plot) {
            "mod-plot-grid"
        } else {
            "release-module"
        }
    }
}

struct Env {
    old: tempfile::TempDir,
    new: tempfile::TempDir,
    book: String,
    entry: String,
    faults: Arc<AtomicUsize>,
}
fn call(ws: &Workspace, name: &str, value: Value) -> Value {
    ws.call(&Actor::User, name, value).unwrap()["output"].clone()
}
fn module(kind: Kind) -> Value {
    json!({"id":kind.module(),"name":"Release fixture","kind":kind.name(),"config":{"defs":[{"id":"text","name":"Release text","field_type":"text"},{"id":"date","name":"Release date","field_type":"date"}]}})
}
fn seed(dir: &std::path::Path, kind: Kind) -> (String, String) {
    let store =
        dr_store::Library::open(dir, dr_workspace::library_options("g1-release-test")).unwrap();
    let data = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = data.books[0].book_id().to_string();
    data.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir, "g1-release-test").unwrap();
    let entries = call(&ws, "entry.list", json!({"book":book,"all":true}));
    let entry = entries
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == "tpl-chapter")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    if !matches!(kind, Kind::Plot) {
        call(
            &ws,
            "entry_template.put_module",
            json!({"book":book,"template":"tpl-chapter","module":module(kind)}),
        );
    }
    match kind {
        Kind::Fields => {
            call(
                &ws,
                "module.set_field",
                json!({"book":book,"entry":entry,"module":kind.module(),"field":"text","value":"original"}),
            );
        }
        Kind::Kv => {
            call(
                &ws,
                "module.put_kv",
                json!({"book":book,"entry":entry,"module":kind.module(),"row":{"id":"release-record","key":"original key","value":"original","pos":"a0"}}),
            );
        }
        Kind::Patches => {
            call(
                &ws,
                "module.put_patch",
                json!({"book":book,"entry":entry,"module":kind.module(),"id":"release-record","title":"original title","body":"original"}),
            );
        }
        Kind::Plot => {
            let g = dr_view_plot::v3::read(&ws, &book, &entry, kind.module()).unwrap();
            dr_view_plot::v3::write(
                &ws,
                &book,
                &entry,
                kind.module(),
                vec![dr_view_plot::Write::Cell {
                    row: g.rows[0].id.clone(),
                    col: g.columns[0].id.clone(),
                    text: "original".into(),
                }],
            )
            .unwrap();
        }
    }
    ws.shutdown().unwrap();
    (book, entry)
}

enum Input {
    Area(Entity<TextArea>),
}
impl Input {
    fn text(&self, cx: &App) -> String {
        match self {
            Self::Area(a) => a.read(cx).text(),
        }
    }
    fn edit(&self, text: &str, cx: &mut VisualTestContext) {
        match self {
            Self::Area(a) => a.update_in(cx, |a, w, cx| {
                a.focus_handle(cx).focus(w, cx);
                a.select_all_text(cx);
                a.replace_text_in_range(None, text, w, cx);
            }),
        }
    }
}
enum Form {
    Fields(Entity<TypedFields>),
    Kv(Entity<Fields>),
    Patches(Entity<Patches>),
    Plot(Entity<PlotPlanner>),
}
impl Form {
    fn input(&self, cx: &App) -> Option<Input> {
        match self {
            Self::Fields(v) => v.read(cx).input("text").map(Input::Area),
            Self::Kv(v) => v
                .read(cx)
                .rows()
                .first()
                .map(|(_, _, v)| Input::Area(v.clone())),
            Self::Patches(v) => v.read(cx).release_test_input().map(Input::Area),
            Self::Plot(v) => {
                let p = v.read(cx);
                if !p.is_loaded() {
                    return None;
                }
                p.field(&Field::Cell(
                    p.grid().rows[0].id.clone(),
                    p.grid().cols[0].id.clone(),
                ))
                .map(Input::Area)
            }
        }
    }
    fn retry(&self, w: &mut Window, cx: &mut App) {
        match self {
            Self::Fields(v) => v.update(cx, |v, cx| v.release_test_retry(cx)),
            Self::Kv(v) => v.update(cx, |v, cx| v.release_test_retry(w, cx)),
            Self::Patches(v) => v.update(cx, |v, cx| v.release_test_retry(cx)),
            Self::Plot(v) => v.update(cx, |v, cx| v.retry_save(cx)),
        }
    }
}
impl Render for Form {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let view: AnyView = match self {
            Self::Fields(v) => v.clone().into(),
            Self::Kv(v) => v.clone().into(),
            Self::Patches(v) => v.clone().into(),
            Self::Plot(v) => v.clone().into(),
        };
        div().p_4().h(px(500.)).child(view)
    }
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|w, cx| {
        w.simulate_next_frame(cx);
        w.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}
#[track_caller]
fn wait(cx: &mut VisualTestContext, test: impl Fn(&mut VisualTestContext) -> bool) {
    let until = Instant::now() + Duration::from_secs(20);
    loop {
        cx.executor().advance_clock(Duration::from_millis(10));
        draw(cx);
        if test(cx) {
            return;
        }
        assert!(
            Instant::now() < until,
            "G1 release did not settle at {}",
            std::panic::Location::caller()
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn open(cx: &mut TestAppContext, kind: Kind) -> (Env, WeakEntity<Form>, VisualTestContext) {
    cx.executor().allow_parking();
    let old = tempfile::tempdir().unwrap();
    let new = tempfile::tempdir().unwrap();
    let (book, entry) = seed(old.path(), kind);
    assert_eq!(seed(new.path(), kind), (book.clone(), entry.clone()));
    let faults = Arc::new(AtomicUsize::new(0));
    let mut options = dr_workspace::library_options("g1-release-test");
    options.append_faults = Some(faults.clone());
    let store = dr_store::Library::open(old.path(), options).unwrap();
    let ws = Workspace::open(store, dr_workspace::WorkspaceOptions::default()).unwrap();
    let made = Rc::new(RefCell::new(None));
    let output = made.clone();
    let b = book.clone();
    let e = entry.clone();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "g1-release-test",
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(dr_ui::Appearance::Light),
            },
            Services {
                library: Some(ws),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_page::settlement::init(cx);
        dr_shell::v3::add_module_view(cx, kind.name(), move |host, window, cx| {
            let lib = host.page.library.clone();
            let view = cx.new(|cx| match kind {
                Kind::Fields => Form::Fields(cx.new(|cx| TypedFields::new(host, window, cx))),
                Kind::Kv => Form::Kv(cx.new(|cx| Fields::for_module(host, cx))),
                Kind::Patches => Form::Patches(cx.new(|cx| Patches::new(host, window, cx))),
                Kind::Plot => Form::Plot(cx.new(|cx| {
                    PlotPlanner::for_module(
                        PlannerHost {
                            library: lib,
                            book: b.clone(),
                            node: e.clone(),
                            title: "Release fixture".into(),
                            mark: dr_ui::sand::Kind::Chapter(0),
                            color: None,
                        },
                        kind.module().into(),
                        window,
                        cx,
                    )
                })),
            });
            *output.borrow_mut() = Some(view.downgrade());
            let weak = view.downgrade();
            dr_shell::v3::Rendered::new(view).on_refresh(move |book, cx| {
                weak.update(cx, |v, cx| match v {
                    Form::Fields(v) => v.update(cx, |v, cx| v.refresh(book, cx)),
                    Form::Kv(v) => v.update(cx, |v, cx| v.refresh_module(book, cx)),
                    Form::Patches(v) => v.update(cx, |v, cx| v.release_test_refresh(book, cx)),
                    Form::Plot(_) => {}
                })
                .ok();
            })
        });
    });
    let window = cx.add_window(dr_shell::Workspace::new);
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    vcx.update(|w, _| w.activate_window());
    vcx.simulate_resize(size(px(1000.), px(850.)));
    let shell = window.root(cx).unwrap();
    wait(&mut vcx, |cx| {
        shell.read_with(cx, |s, _| s.book.v3().is_some())
    });
    let key = format!("entry:{entry}/{}", kind.module());
    shell.update(&mut vcx, |s, cx| {
        s.open(
            dr_shell::nav::Target::from_key(&key).unwrap(),
            dr_shell::nav::Open::KEEP,
            cx,
        )
    });
    wait(&mut vcx, |cx| {
        made.borrow().as_ref().is_some_and(|v: &WeakEntity<Form>| {
            v.read_with(cx, |v, cx| v.input(cx).is_some())
                .unwrap_or(false)
        })
    });
    let view = made.borrow().clone().unwrap();
    (
        Env {
            old,
            new,
            book,
            entry,
            faults,
        },
        view,
        vcx,
    )
}
fn value(ws: &Workspace, env: &Env, kind: Kind) -> String {
    let v = call(
        ws,
        "module.read",
        json!({"book":env.book,"entry":env.entry,"module":kind.module()}),
    );
    match kind {
        Kind::Fields => v["fields"]["text"].as_str().unwrap().into(),
        Kind::Kv => v["kv"][0]["value"].as_str().unwrap().into(),
        Kind::Patches => v["patches"][0]["body"].as_str().unwrap().into(),
        Kind::Plot => {
            let g = dr_view_plot::v3::read(ws, &env.book, &env.entry, kind.module()).unwrap();
            g.cells
                .iter()
                .find(|c| c.row == g.rows[0].id && c.column == g.columns[0].id)
                .unwrap()
                .text
                .clone()
        }
    }
}
fn durable_state(ws: &Workspace, env: &Env) -> Value {
    let doc = ws
        .library()
        .load_copy(&format!("book:{}", env.book))
        .unwrap();
    let book = dr_model::id::BookId::parse(&env.book).unwrap();
    let entry = dr_model::id::EntryId::parse(&env.entry).unwrap();
    dr_doc::v3::BorrowedBookV3::new(&doc, &book)
        .unwrap()
        .view()
        .entry_owned_raw_state(&entry)
        .unwrap()
}

fn remote(cx: &mut VisualTestContext, env: &Env, kind: Kind, text: &str) {
    cx.update(|_, cx| {
        let ws = cx.global::<Services>().library.as_ref().unwrap();
        let input = json!({"book":env.book,"entry":env.entry,"module":kind.module()});
        match kind {
            Kind::Fields => {
                let mut i = input;
                i["field"] = json!("text");
                i["value"] = json!(text);
                call(ws, "module.set_field", i);
            }
            Kind::Kv => {
                let mut i = input;
                i["row"] =
                    json!({"id":"release-record","key":"original key","value":text,"pos":"a0"});
                call(ws, "module.put_kv", i);
            }
            Kind::Patches => {
                let mut i = input;
                i["id"] = json!("release-record");
                i["title"] = json!("original title");
                i["body"] = json!(text);
                call(ws, "module.put_patch", i);
            }
            Kind::Plot => {
                let g = dr_view_plot::v3::read(ws, &env.book, &env.entry, kind.module()).unwrap();
                dr_view_plot::v3::write(
                    ws,
                    &env.book,
                    &env.entry,
                    kind.module(),
                    vec![dr_view_plot::Write::Cell {
                        row: g.rows[0].id.clone(),
                        col: g.columns[0].id.clone(),
                        text: text.into(),
                    }],
                )
                .unwrap();
            }
        }
    });
}
fn close(cx: &mut VisualTestContext) {
    cx.update(|_, cx| {
        if let Some(ws) = cx.global::<Services>().library.as_ref() {
            ws.close();
        }
    });
}

fn delayed(cx: &mut TestAppContext, kind: Kind, quitting: bool) {
    let (env, view, mut cx) = open(cx, kind);
    let input = view.read_with(&cx, |v, cx| v.input(cx).unwrap()).unwrap();
    let (unblock, entered) = cx.update(|_, cx| {
        let lib = cx.global::<Services>().library.clone().unwrap();
        dr_view_page::settlement::delay_next(&lib, cx)
    });
    input.edit("accepted earlier draft", &mut cx);
    cx.update(|w, cx| w.blur(cx));
    wait(&mut cx, |_| entered.load(Ordering::SeqCst));
    input.edit("accepted earlier draft", &mut cx);
    cx.simulate_keystrokes("escape");
    draw(&mut cx);
    cx.update(|_, cx| assert_eq!(input.text(cx), "accepted earlier draft"));
    input.edit("accepted author draft", &mut cx);
    draw(&mut cx);
    let outcome = Rc::new(RefCell::new(None));
    let done = outcome.clone();
    let target = env.new.path().to_owned();
    let quit = Rc::new(Cell::new(false));
    let quit_seen = quit.clone();
    cx.update(|_, cx| {
        if quitting {
            let (book, entry) = (env.book.clone(), env.entry.clone());
            dr_shell::quit::before_quit(cx, move |cx| {
                use dr_workspace::commands::v3::snapshots as api;
                let ws = cx.global::<Services>().library.as_ref().unwrap();
                let point = ws
                    .run::<api::Capture>(
                        &Actor::User,
                        api::CaptureIn {
                            target: api::EntryIn {
                                book: book.clone(),
                                entry: entry.clone(),
                            },
                            reason: api::CaptureReason::Close,
                        },
                    )
                    .unwrap()
                    .output;
                let preview = ws
                    .run::<api::Preview>(
                        &Actor::User,
                        api::PointIn {
                            target: api::EntryIn {
                                book: book.clone(),
                                entry: entry.clone(),
                            },
                            point: point.id,
                        },
                    )
                    .unwrap()
                    .output;
                assert!(
                    serde_json::to_string(&preview.raw_state)
                        .unwrap()
                        .contains("accepted author draft"),
                    "the final checkpoint must read the drained state"
                );
                quit_seen.set(true);
            });
            dr_shell::quit::request(cx);
        } else {
            dr_shell::library::replace(
                cx,
                move |_, options| {
                    dr_store::Library::open(&target, options).map_err(|e| e.to_string())
                },
                move |result, _| *done.borrow_mut() = Some(result),
            );
        }
    });
    wait(&mut cx, |_| entered.load(Ordering::SeqCst));
    assert!(outcome.borrow().is_none());
    assert!(!quit.get());
    let tick = Rc::new(Cell::new(false));
    let seen = tick.clone();
    cx.update(|_, cx| cx.spawn(async move |_| seen.set(true)).detach());
    draw(&mut cx);
    assert!(
        tick.get(),
        "a delayed durable write cannot block the foreground executor"
    );
    cx.simulate_input("must not enter");
    cx.update(|_, cx| assert_eq!(input.text(cx), "accepted author draft"));
    // A callback queued before the curtain must not create an untracked save.
    input.edit("late callback", &mut cx);
    draw(&mut cx);
    cx.update(|_, cx| assert_eq!(input.text(cx), "accepted author draft"));
    unblock.send(()).unwrap();
    if quitting {
        wait(&mut cx, |_| quit.get());
        cx.update(|_, cx| {
            assert_eq!(
                value(
                    cx.global::<Services>().library.as_ref().unwrap(),
                    &env,
                    kind
                ),
                "accepted author draft"
            )
        });
    } else {
        wait(&mut cx, |_| outcome.borrow().is_some());
        assert_eq!(*outcome.borrow(), Some(Ok(())));
        assert!(
            view.upgrade().is_none(),
            "old mounted form must be released"
        );
        cx.update(|_, cx| {
            let ws = cx.global::<Services>().library.as_ref().unwrap();
            assert_eq!(ws.library().paths().root, env.new.path());
            assert_eq!(
                value(ws, &env, kind),
                "original",
                "old writes cannot enter the newly installed library"
            );
        });
        let old = Workspace::open_dir(env.old.path(), "g1-release-test").unwrap();
        assert_eq!(value(&old, &env, kind), "accepted author draft");
        old.shutdown().unwrap();
    }
    close(&mut cx);
}
fn failed(cx: &mut TestAppContext, kind: Kind, conflict: bool) {
    let (env, view, mut cx) = open(cx, kind);
    let input = view.read_with(&cx, |v, cx| v.input(cx).unwrap()).unwrap();
    let before =
        cx.update(|_, cx| durable_state(cx.global::<Services>().library.as_ref().unwrap(), &env));
    input.edit("author draft", &mut cx);
    draw(&mut cx);
    if conflict {
        remote(&mut cx, &env, kind, "external same-count update");
        cx.update(|_, cx| {
            let lib = cx.global::<Services>().library.as_ref().unwrap();
            let book = Rc::new(Book::load(lib, &env.book).unwrap());
            view.update(cx, |v, cx| match v {
                Form::Fields(v) => v.update(cx, |v, cx| v.refresh(book, cx)),
                Form::Kv(v) => v.update(cx, |v, cx| v.refresh_module(book, cx)),
                _ => {}
            })
            .unwrap();
        });
        draw(&mut cx);
    } else {
        env.faults.store(usize::MAX, Ordering::Relaxed);
    }
    let outcome = Rc::new(RefCell::new(None));
    let done = outcome.clone();
    cx.update(|_, cx| {
        dr_shell::library::replace(
            cx,
            |_, _| unreachable!("unsaved draft must prevent disk replacement"),
            move |result, _| *done.borrow_mut() = Some(result),
        )
    });
    wait(&mut cx, |_| outcome.borrow().is_some());
    assert!(outcome.borrow().as_ref().unwrap().is_err());
    cx.update(|_, cx| {
        assert!(!dr_shell::release::is_releasing(cx));
        assert_eq!(input.text(cx), "author draft");
        let ws = cx.global::<Services>().library.as_ref().unwrap();
        assert_eq!(ws.library().paths().root, env.old.path());
        if conflict {
            assert_eq!(value(ws, &env, kind), "external same-count update");
        } else {
            // F2 deliberately retains an unpersisted single-document append
            // under its original origin. Reads of the live holder can see it;
            // compare the entire durable author state, without settling it.
            assert_eq!(durable_state(ws, &env), before);
        }
    });
    input.edit("author draft", &mut cx);
    cx.simulate_keystrokes("escape");
    draw(&mut cx);
    cx.update(|_, cx| assert_eq!(input.text(cx), "author draft"));
    // Failure resumes the input; ordinary blur still cannot authorize the old draft.
    input.edit("author retry", &mut cx);
    cx.update(|w, cx| w.blur(cx));
    draw(&mut cx);
    env.faults.store(0, Ordering::Relaxed);
    view.update_in(&mut cx, |v, w, cx| v.retry(w, cx)).unwrap();
    wait(&mut cx, |cx| {
        cx.update(|_, cx| {
            value(
                cx.global::<Services>().library.as_ref().unwrap(),
                &env,
                kind,
            ) == "author retry"
        })
    });
    let succeeded = Rc::new(Cell::new(false));
    let seen = succeeded.clone();
    cx.update(|_, cx| {
        dr_shell::quit::before_quit(cx, move |_| seen.set(true));
        dr_shell::quit::request(cx);
    });
    wait(&mut cx, |_| succeeded.get());
    close(&mut cx);
}
#[gpui::test]
fn fields_replace_waits_for_durable_save(cx: &mut TestAppContext) {
    delayed(cx, Kind::Fields, false)
}
#[gpui::test]
fn kv_replace_waits_for_durable_save(cx: &mut TestAppContext) {
    delayed(cx, Kind::Kv, false)
}
#[gpui::test]
fn patches_replace_waits_for_durable_save(cx: &mut TestAppContext) {
    delayed(cx, Kind::Patches, false)
}
#[gpui::test]
fn planner_replace_waits_for_durable_save(cx: &mut TestAppContext) {
    delayed(cx, Kind::Plot, false)
}
#[gpui::test]
fn fields_quit_waits_for_durable_save(cx: &mut TestAppContext) {
    delayed(cx, Kind::Fields, true)
}
#[gpui::test]
fn kv_quit_waits_for_durable_save(cx: &mut TestAppContext) {
    delayed(cx, Kind::Kv, true)
}
#[gpui::test]
fn patches_quit_waits_for_durable_save(cx: &mut TestAppContext) {
    delayed(cx, Kind::Patches, true)
}
#[gpui::test]
fn planner_quit_waits_for_durable_save(cx: &mut TestAppContext) {
    delayed(cx, Kind::Plot, true)
}
#[gpui::test]
fn fields_failed_release_preserves_draft(cx: &mut TestAppContext) {
    failed(cx, Kind::Fields, false)
}
#[gpui::test]
fn kv_failed_release_preserves_draft(cx: &mut TestAppContext) {
    failed(cx, Kind::Kv, false)
}
#[gpui::test]
fn patches_failed_release_preserves_draft(cx: &mut TestAppContext) {
    failed(cx, Kind::Patches, false)
}
#[gpui::test]
fn planner_failed_release_preserves_draft(cx: &mut TestAppContext) {
    failed(cx, Kind::Plot, false)
}
#[gpui::test]
fn fields_same_count_conflict_blocks_release(cx: &mut TestAppContext) {
    failed(cx, Kind::Fields, true)
}
#[gpui::test]
fn kv_same_count_conflict_blocks_release(cx: &mut TestAppContext) {
    failed(cx, Kind::Kv, true)
}
#[gpui::test]
fn patches_same_count_conflict_blocks_release(cx: &mut TestAppContext) {
    failed(cx, Kind::Patches, true)
}
#[gpui::test]
fn planner_same_count_conflict_blocks_release(cx: &mut TestAppContext) {
    failed(cx, Kind::Plot, true)
}

#[gpui::test]
fn invalid_field_blocks_replacement_and_recovers_without_discarding_input(cx: &mut TestAppContext) {
    let (env, view, mut cx) = open(cx, Kind::Fields);
    let input = view
        .read_with(&cx, |v, cx| match v {
            Form::Fields(v) => Input::Area(v.read(cx).input("date").unwrap()),
            _ => unreachable!(),
        })
        .unwrap();
    input.edit("2026-02-30", &mut cx);
    draw(&mut cx);
    let outcome = Rc::new(RefCell::new(None));
    let done = outcome.clone();
    cx.update(|_, cx| {
        dr_shell::library::replace(
            cx,
            |_, _| unreachable!("invalid input cannot be replaced"),
            move |result, _| *done.borrow_mut() = Some(result),
        )
    });
    wait(&mut cx, |_| outcome.borrow().is_some());
    assert!(outcome.borrow().as_ref().unwrap().is_err());
    cx.update(|_, cx| {
        assert_eq!(input.text(cx), "2026-02-30");
        let ws = cx.global::<Services>().library.as_ref().unwrap();
        assert_eq!(ws.library().paths().root, env.old.path());
        assert!(
            call(
                ws,
                "module.read",
                json!({"book":env.book,"entry":env.entry,"module":Kind::Fields.module()})
            )["fields"]
                .get("date")
                .is_none()
        );
    });
    input.edit("2026-02-28", &mut cx);
    cx.update(|w, cx| w.blur(cx));
    let quit = Rc::new(Cell::new(false));
    let seen = quit.clone();
    cx.update(|_, cx| {
        dr_shell::quit::before_quit(cx, move |_| seen.set(true));
        dr_shell::quit::request(cx);
    });
    wait(&mut cx, |_| quit.get());
    cx.update(|_, cx| {
        assert_eq!(
            call(
                cx.global::<Services>().library.as_ref().unwrap(),
                "module.read",
                json!({"book":env.book,"entry":env.entry,"module":Kind::Fields.module()})
            )["fields"]["date"],
            "2026-02-28"
        )
    });
    close(&mut cx);
}
