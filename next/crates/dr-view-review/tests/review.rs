//! The Review tab and the composer on a real workspace (GPUI's test
//! platform): filters, scope and groups; completing a TODO; editing in
//! place; jumping to the text; a comment written from the selection.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_editor::decor::ReviewFocus;
use dr_editor::{ChapterEditor, EditorSettings};
use dr_i18n::{Locale, Platform};

use dr_store::Library;
use dr_view_review::{
    CommentComposer, OriginFilter, ReviewView, StatusFilter,
    agent_bridge::{self, CommentAgentRequest, CompanionFocusRequest, ConversationPinwheel},
};
use dr_workspace::{Actor, NavTarget, Workspace, WorkspaceOptions, library_options};
use gpui::{
    Context, Entity, IntoElement, ParentElement, Render, Styled, TestAppContext, VisualTestContext,
    Window, div,
};
use serde_json::{Value, json};

struct Env {
    _dir: tempfile::TempDir,
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
    let book = out(&ws, "project.create", json!({"name": "审阅"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Env {
        _dir: dir,
        ws,
        book,
    }
}

fn chapter(e: &Env, title: &str, text: &str) -> String {
    out(
        &e.ws,
        "entry.create", json!({"book": e.book, "parent": dr_testkit::seed::acceptance::novel_root(&e.ws, &e.book, "tpl-manuscript"), "template": "tpl-chapter", "title": title, "bodies": {"mod-prose": text}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn comment(e: &Env, on: Option<&str>, kind: &str, body: &str) -> String {
    // Written by hand whatever the kind: marker and checklist comments are
    // only projected from prose (`comment.create` refuses those origins).
    let _ = kind;
    let mut input = json!({"book": e.book, "origin": "manual", "body": body});
    if let Some(id) = on {
        input["target"] = json!({"kind": "entry", "id": id});
        input["range"] = json!([0, 2]);
        input["module"] = json!("mod-prose");
    }
    out(&e.ws, "comment.create", input)["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// The TODO marker that opens chapter `id`'s prose, projected (as the editor
/// does when the caret leaves it).
fn project_marker(e: &Env, id: &str, task: &str) {
    let doc = format!("body:{id}/mod-prose");
    let block = out(&e.ws, "prose.read", json!({"doc": doc}))["paragraphs"][0]["block_id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &e.ws,
        "comment.project",
        json!({"doc": doc, "markers": [{"block": block, "task": task}]}),
    );
}

fn listed(e: &Env) -> Vec<Value> {
    out(&e.ws, "comment.list", json!({"book": e.book}))
        .as_array()
        .unwrap()
        .clone()
}

struct Root {
    book: String,
    target: Option<dr_view_review::v3::Target>,
    opened: Rc<RefCell<Vec<String>>>,
}

impl Render for Root {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let opened = self.opened.clone();
        let open: dr_view_review::v3_panel::Open = Rc::new(move |target, _, _| {
            let key = match target {
                dr_view_review::v3::Target::Entry { id, module } => NavTarget::Entry {
                    id: id.parse().unwrap(),
                    module: module.map(|m| m.parse().unwrap()),
                }
                .key(),
                dr_view_review::v3::Target::Material(id) => format!("material:{id}"),
            };
            opened.borrow_mut().push(key);
        });
        div().size_full().child(dr_view_review::v3_panel::panel(
            "review-test",
            &self.book,
            self.target.clone(),
            Locale::ZhCn,
            Platform::Mac,
            open,
            Rc::new(|_| None),
            cx,
        ))
    }
}

fn wait_for(
    cx: &mut VisualTestContext,
    mut done: impl FnMut(&mut VisualTestContext) -> bool,
) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        cx.executor().advance_clock(Duration::from_millis(20));
        cx.run_until_parked();
        if done(cx) {
            return true;
        }
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn redraw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.run_until_parked();
}

fn open_tab<'a>(
    cx: &'a mut TestAppContext,
    e: &Env,
    target: Option<dr_view_review::v3::Target>,
) -> (
    Entity<ReviewView>,
    Rc<RefCell<Vec<String>>>,
    &'a mut VisualTestContext,
) {
    cx.executor().allow_parking();
    let ws = e.ws.clone();
    cx.update(|cx| dr_view_review::init(Some(ws), cx));
    let opened: Rc<RefCell<Vec<String>>> = Rc::default();
    let (book, o) = (e.book.clone(), opened.clone());
    let (_root, cx) = cx.add_window_view(move |_, _| Root {
        book,
        target,
        opened: o,
    });
    redraw(cx);
    let view = cx
        .update(|_, cx| dr_view_review::view("review-test", cx))
        .unwrap();
    (view, opened, cx)
}

fn ids(view: &Entity<ReviewView>, cx: &mut VisualTestContext) -> Vec<Vec<String>> {
    view.read_with(cx, |v, _| {
        v.listing()
            .open
            .iter()
            .map(|g| g.items.iter().map(|i| i.body.text.clone()).collect())
            .collect()
    })
}

#[gpui::test]
fn the_tab_filters_scopes_and_groups_by_place(cx: &mut TestAppContext) {
    let e = env();
    let one = chapter(&e, "一", "雨夜，钟楼停了。");
    // A TODO comes from the prose (a marker projects it); nobody writes one
    // by hand any more.
    let two = chapter(&e, "二", "TODO: 二的待办");
    comment(&e, Some(&one), "note", "一的批注");
    project_marker(&e, &two, "二的待办");
    comment(&e, None, "note", "浮动批注");
    let target = dr_view_review::v3::Target::Entry {
        id: one.clone(),
        module: Some("mod-prose".into()),
    };
    let (view, _, cx) = open_tab(cx, &e, Some(target));
    assert!(wait_for(cx, |cx| ids(&view, cx).concat().len() == 3));
    // Grouped by place, the floating one last.
    let groups = ids(&view, cx);
    assert_eq!(groups.last().unwrap(), &vec!["浮动批注".to_owned()]);
    view.update(cx, |v, cx| v.set_origin_filter(OriginFilter::Marker, cx));
    let todos = ids(&view, cx).concat();
    assert_eq!(todos, ["二的待办"]);
    view.update(cx, |v, cx| v.set_origin_filter(OriginFilter::Manual, cx));
    assert_eq!(ids(&view, cx).concat().len(), 2);
    // 当前: only the open tab's chapter.
    view.update(cx, |v, cx| {
        v.set_origin_filter(OriginFilter::All, cx);
        v.set_current_only(true, cx);
    });
    assert_eq!(ids(&view, cx), vec![vec!["一的批注".to_owned()]]);
    redraw(cx);
    // A comment written elsewhere shows up.
    view.update(cx, |v, cx| v.set_current_only(false, cx));
    comment(&e, Some(&one), "note", "后来的");
    assert!(wait_for(cx, |cx| ids(&view, cx).concat().len() == 4));
}

#[gpui::test]
fn a_todo_is_completed_and_a_body_edited_in_place(cx: &mut TestAppContext) {
    let e = env();
    let one = chapter(&e, "一", "雨夜，钟楼停了。");
    let todo = comment(&e, Some(&one), "todo", "查钟楼的年代");
    let note = comment(&e, Some(&one), "note", "这里太快");
    let (view, _, cx) = open_tab(cx, &e, None);
    assert!(wait_for(cx, |cx| ids(&view, cx).concat().len() == 2));
    view.update(cx, |v, cx| v.set_done(&todo, true, cx));
    assert!(wait_for(cx, |_| listed(&e)
        .iter()
        .any(|c| c["id"] == todo.as_str() && c["status"] == "resolved")));
    // The resolved TODO moves to the folded section.
    assert!(wait_for(cx, |cx| view
        .read_with(cx, |v, _| v.listing().resolved_count)
        == 1));
    redraw(cx);
    // Double-click to edit; Enter saves.
    cx.update(|window, cx| view.update(cx, |v, cx| v.edit(&note, window, cx)));
    view.update(cx, |v, cx| {
        v.finish_edit(&note, Some("这里写得太快".into()), cx)
    });
    assert!(wait_for(cx, |_| listed(&e).iter().any(|c| c["id"]
        == note.as_str()
        && c["body"]["text"] == "这里写得太快")));
    redraw(cx);
}

#[gpui::test]
fn the_arrow_opens_the_chapter_and_chooses_the_comment(cx: &mut TestAppContext) {
    let e = env();
    let one = chapter(&e, "一", "雨夜，钟楼停了。");
    let note = comment(&e, Some(&one), "note", "这里");
    let (view, opened, cx) = open_tab(cx, &e, None);
    assert!(wait_for(cx, |cx| ids(&view, cx).concat().len() == 1));
    cx.update(|window, cx| view.update(cx, |v, cx| v.jump(&note, window, cx)));
    cx.run_until_parked();
    assert_eq!(
        opened.borrow().as_slice(),
        [format!("entry:{one}/mod-prose")]
    );
    let jump = cx.update(|_, cx| ReviewFocus::get(cx).jump.map(|j| j.comment));
    assert_eq!(jump.as_deref(), Some(note.as_str()));
}

#[gpui::test]
fn the_composer_writes_a_comment_on_the_selection(cx: &mut TestAppContext) {
    let e = env();
    let one = chapter(&e, "一", "雨夜，钟楼停了。");
    cx.executor().allow_parking();
    let (ws, book, doc) = (
        e.ws.clone(),
        e.book.clone(),
        format!("body:{one}/mod-prose"),
    );
    let (editor, cx) = cx.add_window_view(move |window, cx| {
        ChapterEditor::open(ws, &book, &doc, EditorSettings::default(), window, cx).unwrap()
    });
    cx.run_until_parked();
    // No selection, no composer.
    let ws = e.ws.clone();
    let none = cx.update(|window, cx| {
        CommentComposer::for_selection(&editor, ws.clone(), Locale::ZhCn, window, cx)
    });
    assert!(none.is_none());
    let prose = editor.read_with(cx, |e, _| e.editor().clone());
    prose.update_in(cx, |p, window, cx| p.select(0, 3..5, window, cx));
    redraw(cx);
    let composer = cx
        .update(|window, cx| CommentComposer::for_selection(&editor, ws, Locale::ZhCn, window, cx))
        .expect("a composer for the selection");
    composer.update(cx, |c, cx| {
        c.set_text("钟楼要写清楚", cx);
        c.save(cx);
    });
    assert!(wait_for(cx, |_| listed(&e).len() == 1));
    let made = &listed(&e)[0];
    assert_eq!(made["origin"], "manual", "written in the composer: by hand");
    assert_eq!(made["body"]["text"], "钟楼要写清楚");
    assert_eq!(made["anchored"], true);
    // Written: chosen, so the editor draws its sand along its rows.
    let jump = cx.update(|_, cx| ReviewFocus::get(cx).jump.map(|j| j.comment));
    assert_eq!(jump.as_deref(), made["id"].as_str());
}

#[gpui::test]
fn the_shortcut_is_a_keystroke_gpui_takes(cx: &mut TestAppContext) {
    // `KeyBinding::new` panics on a keystroke it cannot read.
    cx.update(|cx| cx.bind_keys(dr_view_review::bindings()));
}

#[gpui::test]
fn the_source_card_says_where_and_its_rows_act(cx: &mut TestAppContext) {
    let e = env();
    let one = chapter(&e, "一", "雨夜，钟楼停了。");
    let note = comment(&e, Some(&one), "note", "这里");
    let floating = comment(&e, None, "todo", "浮动待办");
    let (view, _, cx) = open_tab(cx, &e, None);
    assert!(wait_for(cx, |cx| ids(&view, cx).concat().len() == 2));
    let (place, quote) = view.read_with(cx, |v, _| v.source_summary(&note)).unwrap();
    assert_eq!(place.as_ref(), "一 · 正文");
    assert_eq!(quote.as_deref(), Some("雨夜"));
    let (place, quote) = view
        .read_with(cx, |v, _| v.source_summary(&floating))
        .unwrap();
    assert_eq!(place.as_ref(), "项目级 · 未关联对象");
    assert_eq!(quote, None);
    // Its card reads the passage it was written on (原文) when it opens.
    view.update(cx, |v, cx| v.want_original(&note, cx));
    assert!(wait_for(cx, |cx| view
        .read_with(cx, |v, _| v.original_of(&note).is_some())));
    let original = view.read_with(cx, |v, _| v.original_of(&note).cloned().unwrap());
    assert_eq!(original.text, "雨夜");
    assert_eq!(original.changed, Some(false));
    // 解决, then 删除 (`kind` conversion is retired in schema v5).
    view.update(cx, |v, cx| v.set_done(&note, true, cx));
    assert!(wait_for(cx, |_| listed(&e)
        .iter()
        .any(|c| c["id"] == note.as_str() && c["status"] == "resolved")));
    view.update(cx, |v, cx| v.delete(&floating, cx));
    assert!(wait_for(cx, |_| listed(&e).len() == 1));
    redraw(cx);
}

fn sample_env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), library_options("test")).unwrap();
    let sample = dr_testkit::samples::slow_clock().unwrap();
    dr_testkit::seed::write_book_v3(&lib, &dr_testkit::seed::book_to_v3(&sample).unwrap()).unwrap();
    let book = sample.book.book_id().to_string();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    Env {
        _dir: dir,
        ws,
        book,
    }
}

fn listed_ids(view: &Entity<ReviewView>, cx: &mut VisualTestContext) -> Vec<String> {
    view.read_with(cx, |v, _| {
        v.listing()
            .open
            .iter()
            .flat_map(|g| g.items.iter().map(|i| i.id.clone()))
            .collect()
    })
}

#[gpui::test]
fn current_scope_stays_direct_and_follows_source_changes(cx: &mut TestAppContext) {
    let e = sample_env();
    let chapters = serde_json::json!(dr_testkit::seed::acceptance::entries_by_template(
        &e.ws,
        &e.book,
        "tpl-chapter"
    ));
    let one = chapters[0]["id"].as_str().unwrap();
    let two = chapters[1]["id"].as_str().unwrap();
    let direct = comment(
        &e,
        Some(one),
        "note",
        chapters[0]["title"].as_str().unwrap(),
    );
    let floating = comment(&e, None, "todo", chapters[1]["title"].as_str().unwrap());
    let from_two = comment(
        &e,
        Some(two),
        "note",
        chapters[2]["title"].as_str().unwrap(),
    );
    let (view, _, cx) = open_tab(
        cx,
        &e,
        Some(dr_view_review::v3::Target::Entry {
            id: one.into(),
            module: Some("mod-prose".into()),
        }),
    );
    assert!(wait_for(cx, |cx| listed_ids(&view, cx).contains(&direct)));
    view.update(cx, |v, cx| v.set_current_only(true, cx));
    assert!(!listed_ids(&view, cx).contains(&floating));
    assert!(!listed_ids(&view, cx).contains(&from_two));
    out(
        &e.ws,
        "relation_row.create_pair",
        json!({
            "book":e.book,"left":one,"right":two,"new_type":{"name":"章节相连"},
        }),
    );
    let ids = listed_ids(&view, cx);
    assert_eq!(ids.iter().filter(|id| **id == direct).count(), 1);
    assert!(!ids.contains(&floating));
    assert!(!ids.contains(&from_two));
    view.update(cx, |v, cx| v.set_current_only(false, cx));
    let renamed = format!(
        "{} · {}",
        chapters[1]["title"].as_str().unwrap(),
        chapters[0]["title"].as_str().unwrap()
    );
    out(
        &e.ws,
        "entry.update",
        json!({"book": e.book, "id": two, "title": renamed}),
    );
    assert!(wait_for(cx, |cx| view.read_with(cx, |v, _| v
        .source_summary(&from_two)
        .is_some_and(|s| s.0.as_ref() == format!("{renamed} · 正文")))));
    out(&e.ws, "entry.trash", json!({"book": e.book, "id": two}));
    assert!(wait_for(cx, |cx| view.read_with(cx, |v, _| v
        .listing()
        .open
        .iter()
        .any(
            |g| g.place == dr_view_review::Place::Gone && g.items.iter().any(|i| i.id == from_two)
        ))));
}

#[gpui::test]
fn material_comment_sources_are_named_opened_and_refreshed(cx: &mut TestAppContext) {
    let e = sample_env();
    out(
        &e.ws,
        "entry_template.put",
        json!({
            "book": e.book,
            "template": {
                "id": "tpl-custom-media",
                "name": "自定义媒体",
                "modules": [{"id": "mod-media", "kind": "media", "name": "附件"}]
            }
        }),
    );
    let asset = "00000000-0000-7000-8000-000000000071";
    out(
        &e.ws,
        "asset.put",
        json!({
            "book": e.book,
            "id": asset,
            "kind": "image",
            "mime": "image/png",
            "size": 68,
            "sha256": "0000000000000000000000000000000000000000000000000000000000000071",
            "width": 16,
            "height": 16
        }),
    );
    let title = "海港平面图";
    let entry_id = out(
        &e.ws,
        "entry.create",
        json!({"book": e.book, "template": "tpl-custom-media", "title": title}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let id = "00000000-0000-7000-8000-000000000072";
    out(
        &e.ws,
        "module.put_media",
        json!({"book": e.book, "entry": entry_id, "module": "mod-media", "item": {"id": id, "asset": asset}}),
    );
    let comment = out(
        &e.ws,
        "comment.create",
        json!({
            "book": e.book,
            "body": title,
            "target": {"kind": "entry", "id": entry_id},
            "module": "mod-media",
            "part": {"kind": "media", "asset": asset}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (view, opened, cx) = open_tab(
        cx,
        &e,
        Some(dr_view_review::v3::Target::Material(id.into())),
    );
    assert!(wait_for(cx, |cx| view.read_with(cx, |v, _| v
        .source_summary(&comment)
        .is_some_and(|s| s.0.as_ref() == format!("{title} · 附件")))));
    assert_eq!(view.read_with(cx, |v, _| v.where_label(&comment)), "附件");
    view.update(cx, |v, cx| v.set_current_only(true, cx));
    assert!(listed_ids(&view, cx).contains(&comment));
    cx.update(|window, cx| view.update(cx, |v, cx| v.jump(&comment, window, cx)));
    assert_eq!(opened.borrow().as_slice(), [format!("material:{id}")]);
    let renamed = format!("{title} · {title}");
    out(
        &e.ws,
        "entry.update",
        json!({"book": e.book, "id": entry_id, "title": renamed}),
    );
    assert!(wait_for(cx, |cx| view.read_with(cx, |v, _| v
        .source_summary(&comment)
        .is_some_and(|s| s.0.as_ref() == format!("{renamed} · 附件")))));
}

#[gpui::test]
fn entry_only_grouping_merges_all_modules_and_formats_each_where_label(cx: &mut TestAppContext) {
    let e = env();
    out(
        &e.ws,
        "entry_template.put",
        json!({
            "book": e.book,
            "template": {
                "id": "tpl-all-places",
                "name": "全模块条目",
                "modules": [
                    {"id": "mod-prose", "kind": "prose", "name": "正文"},
                    {
                        "id": "mod-fields",
                        "kind": "fields",
                        "name": "设定",
                        "config": {
                            "defs": [{"id": "f-role", "name": "身份", "field_type": "text"}]
                        }
                    },
                    {"id": "mod-kv", "kind": "kv", "name": "属性"},
                    {"id": "mod-patches", "kind": "patches", "name": "补丁"},
                    {"id": "mod-plot", "kind": "plot_grid", "name": "情节"}
                ]
            }
        }),
    );
    let eid = out(
        &e.ws,
        "entry.create",
        json!({
            "book": e.book,
            "template": "tpl-all-places",
            "title": "钟楼守夜人",
            "bodies": {"mod-prose": "TODO: 核对钟声\n雨夜铜铃。"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &e.ws,
        "module.set_field",
        json!({"book": e.book, "entry": eid, "module": "mod-fields", "field": "f-role", "value": "守钟人"}),
    );
    let kv_id = "00000000-0000-7000-8000-000000000081";
    out(
        &e.ws,
        "module.put_kv",
        json!({
            "book": e.book,
            "entry": eid,
            "module": "mod-kv",
            "row": {"id": kv_id, "key": "兵器", "value": "铜锤"}
        }),
    );
    let patch_id = out(
        &e.ws,
        "module.put_patch",
        json!({
            "book": e.book,
            "entry": eid,
            "module": "mod-patches",
            "title": "断桥",
            "body": "第三幕断桥重修"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let row_id = "00000000-0000-7000-8000-000000000082";
    let col_id = "00000000-0000-7000-8000-000000000083";
    out(
        &e.ws,
        "module.put_grid",
        json!({
            "book": e.book,
            "entry": eid,
            "module": "mod-plot",
            "grid": {
                "cell_w": 180.0,
                "cell_h": 110.0,
                "rows": [{"id": row_id, "pos": "a0", "label": "伏笔"}],
                "columns": [{"id": col_id, "pos": "a0", "label": "第一章"}],
                "cells": [{"row": row_id, "column": col_id, "text": "停摆"}]
            }
        }),
    );

    let mk = |module: Option<&str>, part: Option<Value>, body: &str| -> String {
        let mut input = json!({
            "book": e.book,
            "target": {"kind": "entry", "id": eid},
            "body": body,
        });
        if let Some(m) = module {
            input["module"] = json!(m);
        }
        if let Some(p) = part {
            input["part"] = p;
        }
        out(&e.ws, "comment.create", input)["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };

    let c_entry = mk(None, None, "整体结构再紧一点");
    let c_module = mk(Some("mod-fields"), None, "设定模块还要补");
    let c_field = mk(
        Some("mod-fields"),
        Some(json!({"kind": "field", "field": "f-role"})),
        "身份称呼统一",
    );
    let c_kv = mk(
        Some("mod-kv"),
        Some(json!({"kind": "kv_row", "row": kv_id})),
        "兵器太重",
    );
    let c_patch = mk(
        Some("mod-patches"),
        Some(json!({"kind": "patch", "patch": patch_id})),
        "断桥时机延后",
    );
    let c_plot = mk(
        Some("mod-plot"),
        Some(json!({"kind": "plot_cell", "row": row_id, "col": col_id})),
        "停摆细节补齐",
    );
    project_marker(&e, &eid, "核对钟声");
    let c_marker = listed(&e)
        .into_iter()
        .find(|c| c["origin"] == "marker")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let (view, opened, cx) = open_tab(cx, &e, None);
    assert!(wait_for(cx, |cx| listed_ids(&view, cx).len() == 7));
    redraw(cx);

    // Every comment on this entry belongs to a single entry group (`entry:{eid}`).
    view.read_with(cx, |v, _| {
        let listing = v.listing();
        assert_eq!(listing.open.len(), 1);
        assert_eq!(listing.open[0].key(), format!("entry:{eid}"));
        assert_eq!(listing.open[0].items.len(), 7);

        assert_eq!(v.where_label(&c_entry).as_ref(), "");
        assert_eq!(v.where_label(&c_module).as_ref(), "设定");
        assert_eq!(v.where_label(&c_field).as_ref(), "设定 · 身份");
        assert_eq!(v.where_label(&c_kv).as_ref(), "属性 · 兵器");
        assert_eq!(v.where_label(&c_patch).as_ref(), "补丁 · 断桥");
        assert_eq!(v.where_label(&c_plot).as_ref(), "情节 · 伏笔 × 第一章");
        assert_eq!(v.where_label(&c_marker).as_ref(), "正文");

        assert_eq!(
            v.source_summary(&c_field).and_then(|s| s.1).as_deref(),
            Some("守钟人")
        );
        assert_eq!(
            v.source_summary(&c_kv).and_then(|s| s.1).as_deref(),
            Some("铜锤")
        );
        assert_eq!(
            v.source_summary(&c_patch).and_then(|s| s.1).as_deref(),
            Some("第三幕断桥重修")
        );
        assert_eq!(
            v.source_summary(&c_plot).and_then(|s| s.1).as_deref(),
            Some("停摆")
        );
        assert_eq!(
            v.source_summary(&c_marker).and_then(|s| s.1),
            None,
            "marker-projected cards never quote original text"
        );
    });

    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.jump(&c_entry, window, cx);
            v.jump(&c_field, window, cx);
            v.jump(&c_plot, window, cx);
        });
    });
    assert_eq!(
        opened.borrow().as_slice(),
        [
            format!("entry:{eid}"),
            format!("entry:{eid}/mod-fields"),
            format!("entry:{eid}/mod-plot"),
        ]
    );
}

#[gpui::test]
fn standalone_asset_comments_group_under_file_and_jump_to_material(cx: &mut TestAppContext) {
    let e = env();
    let asset = "00000000-0000-7000-8000-000000000091";
    out(
        &e.ws,
        "asset.put",
        json!({
            "book": e.book,
            "id": asset,
            "name": "钟楼图纸.pdf",
            "kind": "pdf",
            "mime": "application/pdf",
            "size": 128,
            "sha256": "0000000000000000000000000000000000000000000000000000000000000091",
            "page_count": 3
        }),
    );
    let whole = out(
        &e.ws,
        "comment.create",
        json!({
            "book": e.book,
            "target": {"kind": "asset", "id": asset},
            "body": "整份图纸比例偏小"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let paged = out(
        &e.ws,
        "comment.create",
        json!({
            "book": e.book,
            "target": {"kind": "asset", "id": asset},
            "part": {"kind": "region", "region": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4, "page": 2}},
            "body": "第二页齿轮标号重复"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let (view, opened, cx) = open_tab(cx, &e, None);
    assert!(wait_for(cx, |cx| listed_ids(&view, cx).len() == 2));
    redraw(cx);

    view.read_with(cx, |v, _| {
        let listing = v.listing();
        assert_eq!(listing.open.len(), 1);
        let group = &listing.open[0];
        assert_eq!(group.key(), format!("material:{asset}"));
        assert_eq!(v.group_header(group).1.as_ref(), "钟楼图纸.pdf");
        assert!(group.items.iter().all(|i| !i.unlocated));
        assert_eq!(v.where_label(&whole).as_ref(), "整个文件");
        assert_eq!(v.where_label(&paged).as_ref(), "第 2 页");
    });

    cx.update(|window, cx| view.update(cx, |v, cx| v.jump(&paged, window, cx)));
    assert_eq!(opened.borrow().as_slice(), [format!("material:{asset}")]);
}

#[gpui::test]
fn missing_field_and_deleted_prose_embed_stay_in_entry_group_as_unlocated_and_jump_to_entry(
    cx: &mut TestAppContext,
) {
    use dr_doc::prose::EmbedKind;
    use dr_model::id::{AssetId, EmbedId};

    let e = env();
    out(
        &e.ws,
        "entry_template.put",
        json!({
            "book": e.book,
            "template": {
                "id": "tpl-embed-field",
                "name": "图文设定",
                "modules": [
                    {"id": "mod-prose", "kind": "prose", "name": "正文"},
                    {
                        "id": "mod-fields",
                        "kind": "fields",
                        "name": "设定",
                        "config": {
                            "defs": [{"id": "f-era", "name": "年代", "field_type": "text"}]
                        }
                    }
                ]
            }
        }),
    );
    let eid = out(
        &e.ws,
        "entry.create",
        json!({
            "book": e.book,
            "template": "tpl-embed-field",
            "title": "旧钟楼",
            "bodies": {"mod-prose": "北塔。"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &e.ws,
        "module.set_field",
        json!({"book": e.book, "entry": eid, "module": "mod-fields", "field": "f-era", "value": "民国初年"}),
    );
    let asset = "00000000-0000-7000-8000-000000000095";
    out(
        &e.ws,
        "asset.put",
        json!({
            "book": e.book,
            "id": asset,
            "name": "北塔立面.png",
            "kind": "image",
            "mime": "image/png",
            "size": 64,
            "sha256": "0000000000000000000000000000000000000000000000000000000000000095",
            "width": 32,
            "height": 32
        }),
    );
    let doc = format!("body:{eid}/mod-prose");
    let embed_id = EmbedId::new_v7();
    let embed_for_edit = embed_id.clone();
    let session = e.ws.prose_session(&doc).unwrap();
    session
        .edit(move |t| {
            t.split(3)?;
            t.insert_embed(
                4,
                &embed_for_edit,
                &EmbedKind::Asset(AssetId::parse(asset).unwrap()),
            )?;
            Ok(())
        })
        .unwrap();

    let c_field = out(
        &e.ws,
        "comment.create",
        json!({
            "book": e.book,
            "target": {"kind": "entry", "id": eid},
            "module": "mod-fields",
            "part": {"kind": "field", "field": "f-era"},
            "body": "核对具体年份"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let c_embed = out(
        &e.ws,
        "comment.create",
        json!({
            "book": e.book,
            "target": {"kind": "entry", "id": eid},
            "module": "mod-prose",
            "part": {"kind": "embed", "embed": embed_id.as_str()},
            "body": "立面窗户数量不对"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let (view, opened, cx) = open_tab(cx, &e, None);
    assert!(wait_for(cx, |cx| listed_ids(&view, cx).len() == 2));
    view.read_with(cx, |v, _| {
        assert!(v.listing().open[0].items.iter().all(|i| !i.unlocated));
    });

    // Remove the field definition from the template and delete the embed from prose.
    out(
        &e.ws,
        "entry_template.put",
        json!({
            "book": e.book,
            "template": {
                "id": "tpl-embed-field",
                "name": "图文设定",
                "modules": [
                    {"id": "mod-prose", "kind": "prose", "name": "正文"},
                    {"id": "mod-fields", "kind": "fields", "name": "设定", "config": {"defs": []}}
                ]
            }
        }),
    );
    session
        .edit(|t| {
            let len = t.view().len();
            t.delete(3..len - 1)
        })
        .unwrap();
    view.update(cx, |v, cx| v.reload_now(cx));
    assert!(wait_for(cx, |cx| {
        view.read_with(cx, |v, _| {
            let open = &v.listing().open;
            open.len() == 1
                && open[0].key() == format!("entry:{eid}")
                && open[0].items.len() == 2
                && open[0].items.iter().all(|i| i.unlocated)
        })
    }));
    redraw(cx);

    // Jumping from a `找不到原处` card falls back to opening the whole entry.
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.jump(&c_field, window, cx);
            v.jump(&c_embed, window, cx);
        });
    });
    assert_eq!(
        opened.borrow().as_slice(),
        [format!("entry:{eid}"), format!("entry:{eid}")]
    );
}

#[gpui::test]
fn two_row_filters_checklist_fold_task_guards_and_prose_tick_undo(cx: &mut TestAppContext) {
    let e = env();
    let ch = chapter(&e, "一", "TODO: 查潮汐\n普通正文。\n核查海图\n清点缆绳");
    let doc = format!("body:{ch}/mod-prose");
    let session = e.ws.prose_session(&doc).unwrap();
    // Paragraph 0: "TODO: 查潮汐" (len 9, nl at 9); Paragraph 1: "普通正文。" (starts 10, nl 15);
    // Paragraph 2: "核查海图" (starts 16, nl 20); Paragraph 3: "清点缆绳" (starts 21).
    for pos in [16, 21] {
        session
            .edit(move |t| {
                t.set_block_attrs(
                    pos,
                    &dr_model::prose::BlockAttrs {
                        list: Some(dr_model::kind::ListKind::Task),
                        ..Default::default()
                    },
                )
            })
            .unwrap();
    }
    let p0 = out(&e.ws, "prose.read", json!({"doc": doc}))["paragraphs"][0]["block_id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &e.ws,
        "comment.project",
        json!({
            "doc": doc,
            "markers": [{"block": p0, "task": "查潮汐"}],
            "tasks": []
        }),
    );
    let c_manual = comment(&e, Some(&ch), "note", "手写批注");
    let c_reader = out(
        &e.ws,
        "comment.create",
        json!({
            "book": e.book,
            "origin": "reader",
            "author_name": "林读者",
            "target": {"kind": "entry", "id": ch},
            "module": "mod-prose",
            "body": "读者感想"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let c_agent =
        e.ws.call(
            &Actor::agent("s-1", 1, "comment.create"),
            "comment.create",
            json!({
                "book": e.book,
                "origin": "agent",
                "target": {"kind": "entry", "id": ch},
                "module": "mod-prose",
                "body": "Agent 巡检"
            }),
        )
        .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();

    let (view, _, cx) = open_tab(cx, &e, None);
    assert!(wait_for(cx, |cx| listed_ids(&view, cx).len() == 6));
    let group_key = format!("entry:{ch}");

    // Row 2 origin filters.
    for (origin, expected_len) in [
        (OriginFilter::All, 6),
        (OriginFilter::Manual, 1),
        (OriginFilter::Marker, 1),
        (OriginFilter::Task, 2),
        (OriginFilter::Agent, 1),
        (OriginFilter::Reader, 1),
    ] {
        view.update(cx, |v, cx| v.set_origin_filter(origin, cx));
        assert_eq!(listed_ids(&view, cx).len(), expected_len, "{origin:?}");
    }
    view.update(cx, |v, cx| v.set_origin_filter(OriginFilter::All, cx));
    assert!(!view.read_with(cx, |v, _| v.is_task_fold_open(&group_key)));
    view.update(cx, |v, cx| v.toggle_task_fold(&group_key, cx));
    assert!(view.read_with(cx, |v, _| v.is_task_fold_open(&group_key)));
    redraw(cx);

    let task_id = listed(&e)
        .into_iter()
        .find(|c| c["origin"] == "task" && c["body"]["text"] == "核查海图")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Checklist (`task`) cards refuse inline edit and delete in ReviewView.
    cx.update(|window, cx| view.update(cx, |v, cx| v.edit(&task_id, window, cx)));
    assert_eq!(
        view.read_with(cx, |v, _| v.editing_id().map(str::to_owned)),
        None
    );
    view.update(cx, |v, cx| v.delete(&task_id, cx));
    cx.run_until_parked();
    assert!(listed(&e).iter().any(|c| c["id"] == task_id.as_str()));
    let _ = (&c_manual, &c_reader, &c_agent);

    let is_ticked = || {
        let parsed = dr_model::DocId::parse(&doc).unwrap();
        e.ws.library()
            .open_doc(&doc, dr_store::OpenDoc::Existing)
            .unwrap()
            .read(move |d| {
                dr_doc::prose::BorrowedProse::new(d, &parsed)
                    .unwrap()
                    .view()
                    .paragraphs()
                    .nth(2)
                    .is_some_and(|p| p.attrs.checked)
            })
            .unwrap()
    };

    // Resolving a checklist card ticks its prose line, and one Undo restores both.
    view.update(cx, |v, cx| v.set_done(&task_id, true, cx));
    assert!(wait_for(cx, |_| {
        listed(&e)
            .iter()
            .any(|c| c["id"] == task_id.as_str() && c["status"] == "resolved")
    }));
    assert!(is_ticked());
    view.update(cx, |v, cx| v.set_status_filter(StatusFilter::Resolved, cx));
    assert!(wait_for(cx, |cx| {
        view.read_with(cx, |v, _| v.listing().resolved_count == 1)
    }));
    redraw(cx);

    e.ws.undo(&Actor::User).unwrap().expect("undo step");
    assert!(!is_ticked());
    assert!(
        listed(&e)
            .iter()
            .any(|c| c["id"] == task_id.as_str() && c["status"] == "open")
    );
}

#[gpui::test]
fn handoff_to_agent_tracks_pinwheel_states_and_reuses_conversation(cx: &mut TestAppContext) {
    let e = env();
    let ch = chapter(&e, "一", "雨夜，钟楼停了。");
    let cid = comment(&e, Some(&ch), "note", "钟声太突兀");

    let opened_agent: Rc<RefCell<Vec<CompanionFocusRequest>>> = Rc::default();
    let (view, _, cx) = open_tab(cx, &e, None);
    assert!(wait_for(cx, |cx| listed_ids(&view, cx).contains(&cid)));

    let dispatched: Rc<RefCell<Vec<CommentAgentRequest>>> = Rc::default();
    let d_clone = dispatched.clone();
    let tracker = cx.update(|_, cx| {
        agent_bridge::register(
            Box::new(move |req, _| {
                d_clone.borrow_mut().push(req);
                Ok("conv-review-1".to_owned())
            }),
            Box::new(|_, _| false),
            cx,
        )
    });

    // First handoff without extra note.
    view.update(cx, |v, cx| v.hand_to_agent(&cid, String::new(), cx));
    {
        let reqs = dispatched.borrow();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].comment_id, cid);
        assert_eq!(reqs[0].existing_conversation, None);
        assert_eq!(reqs[0].extra_note, "");
        assert_eq!(reqs[0].header, "批注 · 正文");
        assert_eq!(reqs[0].quote.as_deref(), Some("雨夜"));
        assert_eq!(reqs[0].body, "钟声太突兀");
    }

    // Running -> UnviewedDone -> viewed clears pinwheel.
    let conv_id = "conv-review-1";
    out(
        &e.ws,
        "comment.update",
        json!({"book": e.book, "id": cid, "agent_conversation": conv_id}),
    );
    view.update(cx, |v, cx| v.reload_now(cx));
    assert!(wait_for(cx, |cx| {
        view.read_with(cx, |v, _| {
            v.listing().open[0].items[0].agent_conversation.as_deref() == Some(conv_id)
        })
    }));

    cx.update(|_, cx| {
        tracker.update(cx, |t, cx| t.set_running(&e.book, conv_id, true, false, cx));
        assert_eq!(
            agent_bridge::pinwheel_state(&e.book, conv_id, cx),
            ConversationPinwheel::Running
        );

        tracker.update(cx, |t, cx| {
            t.set_running(&e.book, conv_id, false, false, cx)
        });
        assert_eq!(
            agent_bridge::pinwheel_state(&e.book, conv_id, cx),
            ConversationPinwheel::UnviewedDone
        );
    });
    redraw(cx);

    // Second handoff with extra note reuses `agent_conversation`.
    view.update(cx, |v, cx| {
        v.hand_to_agent(&cid, "  顺便统一前后语气  ".into(), cx)
    });
    {
        let reqs = dispatched.borrow();
        assert_eq!(reqs.len(), 2);
        assert_eq!(reqs[1].existing_conversation.as_deref(), Some(conv_id));
        assert_eq!(reqs[1].extra_note, "顺便统一前后语气");
    }

    // Opening the conversation marks it viewed and hides the pinwheel.
    let oa_clone = opened_agent.clone();
    cx.update(|window, cx| {
        view.update(cx, |v, cx| v.open_agent_conversation(&cid, window, cx));
        if let Some(req) = tracker.update(cx, |t, _| t.take_pending_open(&e.book)) {
            oa_clone.borrow_mut().push(req);
        }
        assert_eq!(
            agent_bridge::pinwheel_state(&e.book, conv_id, cx),
            ConversationPinwheel::Hidden
        );
    });
    assert_eq!(opened_agent.borrow().len(), 1);
    assert_eq!(opened_agent.borrow()[0].conversation_id, conv_id);
    assert_eq!(opened_agent.borrow()[0].return_title, "一 · 正文");
}

/// A card's comment wraps by the writing rules: a 「。」 that does not fit
/// hangs at the end of its line instead of opening a line of its own, so a
/// comment and the same comment with a full stop take the same rows. The
/// cards broke lines anywhere before (GPUI's own wrapping), and a lone 「。」
/// opened a line.
#[gpui::test]
fn a_full_stop_never_opens_a_line_in_a_card(cx: &mut TestAppContext) {
    let e = env();
    let lengths: Vec<usize> = (4..=60).collect();
    let pairs: Vec<(String, String)> = lengths
        .iter()
        .map(|&n| {
            let words = "一".repeat(n);
            (
                comment(&e, None, "note", &words),
                comment(&e, None, "note", &format!("{words}。")),
            )
        })
        .collect();
    let (view, _, cx) = open_tab(cx, &e, None);
    cx.simulate_resize(gpui::size(gpui::px(320.0), gpui::px(14000.0)));
    assert!(wait_for(cx, |cx| ids(&view, cx).concat().len() == pairs.len() * 2));
    redraw(cx);
    redraw(cx);
    let height = |cx: &mut VisualTestContext, id: &str| {
        cx.debug_bounds(Box::leak(
            format!("review-test-comment-{id}").into_boxed_str(),
        ))
        .unwrap_or_else(|| panic!("card {id} drawn"))
        .size
        .height
    };
    let mut grew = Vec::new();
    for ((plain, stopped), n) in pairs.iter().zip(&lengths) {
        if height(cx, stopped) != height(cx, plain) {
            grew.push(*n);
        }
    }
    assert!(
        grew.is_empty(),
        "a full stop took a row of its own after {grew:?} characters"
    );
}
