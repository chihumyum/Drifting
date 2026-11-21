//! 「0.1 的旧对话」 (2026-11-21, 三甲 四甲 五甲) in the real companion views:
//! a synthetic 0.1 library with conversations (dr-import-v1's test library)
//! imported through the importer, the library opened as the App opens it,
//! a scripted model for the one new conversation. No network, no real key.

#[allow(clippy::all, unused)]
#[path = "../../dr-import-v1/tests/common/mod.rs"]
mod legacy;

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use dr_agent::{
    DriverEvent, FinishReason, State,
    driver::scripted::{ScriptedDriver, Step},
};
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, credentials::Credentials,
    oauth::OAuthEndpoints,
};
use dr_import_v1::agent_archive::Turn;
use dr_import_v1::run::{self, Options, Outcome};
use dr_model::id::BookId;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace as ShellWorkspace};
use dr_testkit::seed::{self, Preset};
use dr_view_agent::{
    connection::PROVIDERS,
    hub::AgentHub,
    panel::{AgentPanel, EYEBROW, PanelHead},
    tools::CompanionTools,
};
use dr_workspace::Workspace;
use futures::executor::block_on;
use gpui::{Entity, Focusable as _, TestAppContext, VisualTestContext};
use legacy::conversations as c;

/// What the author asks the Agent in the one new conversation; 「精神胜利法」
/// is in it and in a 0.1 conversation's title.
const ASKED: &str = "精神胜利法还要再写一次吗？";
const ANSWERED: &str = "可以，换成被人打了以后的那一次。";

struct Fixture {
    _dir: tempfile::TempDir,
    _old: Option<legacy::Old>,
    ws: Workspace,
    book: BookId,
}

/// The synthetic 0.1 library with conversations, imported.
fn imported() -> Fixture {
    let old = c::build_v3(true);
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let mut o = Options::new("m31-old-test");
    o.v3 = legacy::v3_choices();
    o.old_root = Some(old.root.clone());
    o.device_dir = Some(dir.path().join("device"));
    match run::import(&old.db, &root, &o).unwrap().0 {
        Outcome::Imported(_) => {}
        Outcome::Blocked(g) => panic!("blocked: {:?}", g.reasons),
        Outcome::Cancelled => panic!("cancelled"),
    }
    let ws = Workspace::open_dir(&root, "m31-old-test").unwrap();
    ws.set_auto_links(false);
    Fixture {
        _dir: dir,
        _old: Some(old),
        ws,
        book: BookId::parse(legacy::BOOK).unwrap(),
    }
}

/// A seeded library no import wrote: no archive.
fn seeded() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "m31-old-test").unwrap();
    ws.set_auto_links(false);
    let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    let book = seeded.books[0].book_id().clone();
    seeded.write_to(ws.library()).unwrap();
    Fixture {
        _dir: dir,
        _old: None,
        ws,
        book,
    }
}

struct Views {
    panel: Entity<AgentPanel>,
    hub: Entity<AgentHub>,
    shell: Entity<ShellWorkspace>,
}

fn provider() -> ProviderDriver {
    let local = "http://127.0.0.1:9";
    ProviderDriver::with_endpoints(
        HttpClient::new().unwrap(),
        Credentials::candidate(dr_agent::Provider::Deepseek, "synthetic-old-key").unwrap(),
        Endpoints {
            deepseek: local.into(),
            anthropic: local.into(),
            openai: local.into(),
            chatgpt: local.into(),
        },
        OAuthEndpoints::at(local).unwrap(),
        RetryPolicy {
            max_attempts: 1,
            ..Default::default()
        },
    )
}

fn answer() -> Arc<ScriptedDriver> {
    Arc::new(ScriptedDriver::new(vec![vec![
        Step::Event(DriverEvent::TextDelta {
            index: 0,
            text: ANSWERED.into(),
        }),
        Step::Event(DriverEvent::Finish(FinishReason::Complete)),
    ]]))
}

fn open<'a>(
    cx: &'a mut TestAppContext,
    fixture: &Fixture,
    driver: Arc<ScriptedDriver>,
) -> (Views, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    let (hub, connections) = cx.update(|cx| {
        let mut settings = SettingsFile::in_memory();
        settings.set_last_book(fixture.book.as_str());
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "m31-old-test",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(fixture.ws.clone()),
                ..Services::default()
            },
            settings,
            cx,
        );
        dr_view_agent::init_with(provider(), driver, Arc::new(CompanionTools::default()), cx);
        let views = cx.global::<dr_view_agent::AgentViews>();
        let (hub, connections) = (views.hub.clone(), views.connections.clone());
        for provider in PROVIDERS {
            connections.update(cx, |connections, _| {
                connections.set_catalog_endpoint(provider, "http://127.0.0.1:9/models".into())
            });
        }
        (hub, connections)
    });
    let shell_window = cx.add_window(ShellWorkspace::new);
    let shell = shell_window.root(cx).unwrap();
    let (weak, view_hub, view_connections) = (shell.downgrade(), hub.clone(), connections.clone());
    let (panel, cx) = cx.add_window_view(move |window, cx| {
        AgentPanel::new(weak, view_hub, view_connections, window, cx)
    });
    let views = Views { panel, hub, shell };
    let book = fixture.book.clone();
    wait(cx, "the panel follows the book", |cx| {
        views.shell.read_with(cx, |ws, _| {
            ws.book_id == book.as_str() && !ws.book.is_empty()
        }) && connections.read_with(cx, |c, _| c.usable() == Some(true))
            && views.hub.read_with(cx, |hub, _| hub.controller.is_some())
            && views.panel.read_with(cx, |panel, _| panel.is_settled())
    });
    (views, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

fn wait(
    cx: &mut VisualTestContext,
    what: &str,
    mut done: impl FnMut(&mut VisualTestContext) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        draw(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let at = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} is not drawn"))
        .center();
    cx.simulate_click(at, gpui::Modifiers::none());
    draw(cx);
}

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

fn history(views: &Views, cx: &mut VisualTestContext) {
    views
        .panel
        .update(cx, |panel, cx| panel.show_history(true, cx));
    wait(cx, "the 0.1 conversations are read", |cx| {
        views.panel.read_with(cx, |p, _| {
            p.is_settled() && p.history_shown() && p.old_conversations().is_some()
        })
    });
}

fn close(views: &Views, fixture: &Fixture, cx: &mut VisualTestContext) {
    let close = views.hub.update(cx, |hub, cx| hub.prepare_close(cx));
    block_on(close).unwrap();
    cx.run_until_parked();
    fixture.ws.close();
}

#[gpui::test]
fn the_history_has_the_0_1_section_and_an_old_conversation_opens_read_only(
    cx: &mut TestAppContext,
) {
    let fixture = imported();
    let driver = answer();
    let (views, cx) = open(cx, &fixture, driver.clone());
    history(&views, cx);
    let listed: Vec<String> = views.panel.read_with(cx, |p, _| {
        p.old_conversations()
            .unwrap()
            .iter()
            .map(|c| c.id.clone())
            .collect()
    });
    assert_eq!(
        listed,
        c::LISTED,
        "this book's, newest first, as 0.1 listed them"
    );
    assert_eq!(EYEBROW, "Drifting 0.1");
    assert!(
        cx.debug_bounds("agent-history-old").is_some(),
        "the section"
    );
    let row = |id: &str| leak(format!("agent-history-old-{id}"));
    for id in c::LISTED {
        assert!(cx.debug_bounds(row(id)).is_some(), "{id} is listed");
    }
    for id in [c::DELETED, c::ROOT, c::MCP, c::OTHER] {
        assert!(cx.debug_bounds(row(id)).is_none(), "{id} is not");
    }
    // The section folds and opens again.
    click(cx, "agent-history-old");
    assert!(cx.debug_bounds(row(c::TITLED)).is_none());
    click(cx, "agent-history-old");
    assert!(cx.debug_bounds(row(c::TITLED)).is_some());
    assert!(
        cx.debug_bounds("agent-send").is_some(),
        "「历史」 keeps the input block"
    );

    // Opened: read only, the head says which, no input block at all.
    let head_window = cx.add_window({
        let panel = views.panel.clone();
        move |_, cx| PanelHead::new_observed(panel, cx)
    });
    let mut head = VisualTestContext::from_window(head_window.into(), cx);
    click(cx, row(c::TOOLS));
    wait(cx, "the old conversation is read", |cx| {
        views.panel.read_with(cx, |p, _| {
            p.old_conversation().is_some_and(|(_, t)| t.is_some())
        })
    });
    let turns = views.panel.read_with(cx, |p, _| {
        let (conversation, turns) = p.old_conversation().unwrap();
        assert_eq!(conversation.id, c::TOOLS);
        turns.unwrap().to_vec()
    });
    assert_eq!(turns.len(), 6);
    assert_eq!(turns[2], Turn::Tool("read_chapter".into()));
    draw(cx);
    assert!(cx.debug_bounds("agent-old-eyebrow").is_some());
    for gone in ["agent-send", "agent-context-usage", "agent-continuity"] {
        assert!(
            cx.debug_bounds(gone).is_none(),
            "{gone} is not in an old conversation"
        );
    }
    draw(&mut head);
    assert!(head.debug_bounds("agent-old-back").is_some());
    assert!(head.debug_bounds("agent-old-title").is_some());
    assert!(head.debug_bounds("agent-chat-list").is_none());
    assert!(head.debug_bounds("agent-new-chat").is_none());

    // No key and no action continues it.
    let composer = views.panel.read_with(cx, |p, _| p.composer());
    cx.update(|window, cx| composer.focus_handle(cx).focus(window, cx));
    cx.simulate_keystrokes("a enter");
    composer.update(cx, |field, cx| field.set_text(ASKED, cx));
    views.panel.update(cx, |panel, cx| panel.send(cx));
    draw(cx);
    assert!(driver.requests().is_empty(), "nothing was sent");
    assert!(
        views
            .panel
            .read_with(cx, |p, _| p.snapshot().is_none_or(|s| s.runs.is_empty()))
    );

    // A tool line is not pressable: pressing it changes nothing.
    let nav = views.shell.read_with(cx, |ws, _| ws.nav.current().cloned());
    click(cx, "agent-old-turn-2");
    assert_eq!(
        views.shell.read_with(cx, |ws, _| ws.nav.current().cloned()),
        nav
    );
    assert_eq!(
        views
            .panel
            .read_with(cx, |p, _| p.old_conversation().map(|(c, _)| c.id.clone())),
        Some(c::TOOLS.to_owned())
    );
    // Its reasoning folds as a new conversation's does.
    assert!(
        cx.debug_bounds("old:01900000-0000-7000-8000-00000000c004:thinking:1")
            .is_some()
    );

    // Back: 「历史」 as it was.
    let back = head.debug_bounds("agent-old-back").unwrap().center();
    head.simulate_click(back, gpui::Modifiers::none());
    draw(cx);
    assert!(views.panel.read_with(cx, |p, _| p.history_shown()
        && p.old_conversation().is_none()));
    assert!(cx.debug_bounds(row(c::TITLED)).is_some());
    assert!(cx.debug_bounds("agent-send").is_some());
    close(&views, &fixture, cx);
}

#[gpui::test]
fn without_an_archive_the_history_has_no_0_1_section(cx: &mut TestAppContext) {
    let fixture = seeded();
    let (views, cx) = open(cx, &fixture, answer());
    history(&views, cx);
    assert_eq!(
        views
            .panel
            .read_with(cx, |p, _| p.old_conversations().map(<[_]>::len)),
        Some(0)
    );
    assert!(cx.debug_bounds("agent-history-old").is_none());
    assert!(cx.debug_bounds("agent-history-search").is_some());
    close(&views, &fixture, cx);
}

#[gpui::test]
fn the_search_box_finds_new_and_old_conversations_together(cx: &mut TestAppContext) {
    let fixture = imported();
    let driver = answer();
    let (views, cx) = open(cx, &fixture, driver.clone());
    // A new conversation, by the scripted model.
    let composer = views.panel.read_with(cx, |p, _| p.composer());
    composer.update(cx, |field, cx| field.set_text(ASKED, cx));
    views.panel.update(cx, |panel, cx| panel.send(cx));
    wait(cx, "the new conversation's turn completes", |cx| {
        views.panel.read_with(cx, |p, _| {
            p.is_settled()
                && p.snapshot()
                    .is_some_and(|s| s.runs.iter().any(|r| r.state == State::Completed))
        })
    });
    let new = views
        .panel
        .read_with(cx, |p, _| p.snapshot().unwrap().conversation.clone());
    history(&views, cx);
    let field = views.panel.read_with(cx, |p, _| p.history_search());
    assert!(
        field.read_with(cx, |f, _| f.placeholder_text().is_empty()),
        "no placeholder, as the book search has none"
    );

    let search = |query: &str, cx: &mut VisualTestContext| {
        views
            .panel
            .update(cx, |panel, cx| panel.set_history_query(query, cx));
        let query = query.to_owned();
        wait(cx, "the search finishes", |cx| {
            views.panel.read_with(cx, |p, _| {
                p.is_settled() && p.history_results().is_some_and(|r| r.query == query)
            })
        });
        views.panel.read_with(cx, |p, _| {
            let r = p.history_results().unwrap();
            (
                r.new.iter().map(|(id, ..)| id.clone()).collect::<Vec<_>>(),
                r.old
                    .iter()
                    .map(|f| f.conversation.id.clone())
                    .collect::<Vec<_>>(),
            )
        })
    };
    // New and old together: the new one's words, an old one's title.
    let (found_new, found_old) = search("精神胜利法", cx);
    assert_eq!(found_new, std::slice::from_ref(&new));
    assert_eq!(found_old, [c::TITLED]);
    // 「几个 · 几处」, as the book search counts: two conversations, the
    // query twice in each (title and the author's words).
    let meta = field.read_with(cx, |f, _| f.meta().map(ToString::to_string));
    let expected = cx.update(|_, cx| {
        dr_shell::strings::tf(
            cx,
            dr_i18n::keys::global_search::STATS,
            &[("groups", &2), ("occurrences", &4)],
        )
        .to_string()
    });
    assert_eq!(meta, Some(expected));
    assert!(
        cx.debug_bounds("agent-history-old").is_some(),
        "the groups stay apart"
    );
    // The Agent's words of the new one, letter case ignored in the old.
    assert_eq!(search("被人打了", cx), (vec![new.clone()], vec![]));
    assert_eq!(search("todo", cx).1, [c::UNTITLED]);
    // Nothing found.
    assert_eq!(search("不在任何对话里的词", cx), (vec![], vec![]));
    assert!(cx.debug_bounds("agent-history-none").is_some());
    assert_eq!(field.read_with(cx, |f, _| f.meta().cloned()), None);
    // A newer query wins over the one before.
    views.panel.update(cx, |panel, cx| {
        panel.set_history_query("赵", cx);
        panel.set_history_query("赵太爷", cx);
    });
    assert_eq!(search("赵太爷", cx).1, [c::TOOLS, c::FORK]);

    // An old hit opens at the turn it is in: the last of a long one, laid
    // out without the turns above it.
    assert_eq!(search("王胡", cx).1, [c::LONG]);
    click(cx, leak(format!("agent-history-old-{}", c::LONG)));
    wait(cx, "the hit's conversation is read", |cx| {
        views.panel.read_with(cx, |p, _| {
            p.old_conversation().is_some_and(|(_, t)| t.is_some())
        })
    });
    draw(cx);
    let last = leak(format!("agent-old-turn-{}", c::LONG_TURNS - 1));
    assert!(
        cx.debug_bounds(last).is_some(),
        "the hit's turn is on screen"
    );
    assert!(
        cx.debug_bounds("agent-old-turn-0").is_none(),
        "the top is not laid out"
    );
    assert!(views.panel.read_with(cx, |p, _| p.old_scroll_top()) > Some(c::LONG_TURNS / 2));
    views.panel.update(cx, |p, cx| p.close_old(cx));
    // A new hit opens that conversation.
    search("被人打了", cx);
    click(cx, leak(format!("agent-history-new-{new}")));
    wait(cx, "the new conversation is shown", |cx| {
        views.panel.read_with(cx, |p, _| {
            !p.history_shown() && p.snapshot().is_some_and(|s| s.conversation == new)
        })
    });
    assert_eq!(driver.requests().len(), 1);
    close(&views, &fixture, cx);
}
