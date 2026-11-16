//! HC (`kernel-v5.md` §15 #46, #47; `handoff/v5-tracks.md` HC): the Agent's
//! suggestion cards on Project Home, wired as the app wires them, over the
//! real controller and a synthetic model stream. No real model, no key
//! leaves the process: every address is loopback.

use std::{
    cell::RefCell,
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

use dr_agent::{
    DriverEvent, FinishReason,
    driver::scripted::{ScriptedDriver, Step},
    proactive::{CardStatus, CheckinCard, CheckinOutcome, ProactiveStore, SuggestionStart},
};
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, credentials::Credentials,
    oauth::OAuthEndpoints,
};
use dr_doc::v3::novel::{MOD_PROSE, TPL_CHAPTER};
use dr_model::id::{BookId, new_uuid_v7};
use dr_shell::{
    Services, Settings, SettingsFile, ShellInfo, Workspace,
    nav::{Open, Target},
    settings::registry,
    workspace::RightTab,
};
use dr_testkit::seed::{self, Preset};
use dr_view_agent::{
    connection::{Connections, PROVIDERS},
    home_cards::HomeCards,
    hub::AgentHub,
    tools::CompanionTools,
};
use dr_view_home::{AgentCards, v3::Home};
use dr_workspace::{Actor, Workspace as Library};
use futures::{channel::oneshot, executor::block_on};
use gpui::{
    AppContext as _, Entity, Modifiers, TestAppContext, VisualTestContext, point, px, size,
};
use serde_json::{Value, json};

struct Fixture {
    _dir: tempfile::TempDir,
    lib: Library,
    book: BookId,
    entry: String,
}

impl Fixture {
    /// The tiny seed with one paragraph of a chapter just revised (so the
    /// Agent has changes to look at).
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open_dir(dir.path(), "hc-home-cards").unwrap();
        lib.set_auto_links(false);
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().clone();
        let entry = seeded.books[0]
            .book
            .view()
            .entries()
            .into_iter()
            .find(|e| {
                e.template
                    .as_ref()
                    .is_some_and(|t| t.as_str() == TPL_CHAPTER)
            })
            .unwrap()
            .id
            .to_string();
        seeded.write_to(lib.library()).unwrap();
        lib.library().rebuild_stale_indexes().unwrap();
        let doc = format!("body:{entry}/{MOD_PROSE}");
        let prose = out(&lib, "prose.read", json!({"doc": doc, "limit": 1000}));
        let p = &prose["paragraphs"][1];
        out(
            &lib,
            "prose.replace",
            json!({"doc": doc, "block_id": p["block_id"], "find": p["text"],
                   "replace": "合成的作者修改，给 Agent 看的改动。"}),
        );
        Self {
            _dir: dir,
            lib,
            book,
            entry,
        }
    }

    fn stored(&self) -> dr_agent::proactive::ProactiveState {
        ProactiveStore::load(self.lib.library(), &self.book).unwrap()
    }

    /// Cards an earlier look left (two hours ago: the 90 minutes are over).
    fn earlier_cards(&self, titles: &[&str]) {
        let lib = self.lib.library();
        let state = ProactiveStore::load(lib, &self.book).unwrap();
        let at = chrono::Utc::now().timestamp_millis() - 2 * 60 * 60 * 1000;
        let ticket = ProactiveStore::begin_checkin(
            lib,
            &self.book,
            &SuggestionStart {
                expected_revision: state.revision,
                id: new_uuid_v7(),
                now_ms: at,
                enabled: true,
                coverage: Default::default(),
            },
        )
        .unwrap()
        .unwrap();
        let cards = titles
            .iter()
            .map(|title| CheckinCard {
                id: new_uuid_v7(),
                title: (*title).into(),
                detail: "上一次留下的。".into(),
                instruction: format!("合成的任务：{title}"),
                target: None,
            })
            .collect();
        ProactiveStore::complete_checkin(
            lib,
            &self.book,
            &ticket,
            &CheckinOutcome {
                cards,
                ..Default::default()
            },
        )
        .unwrap();
    }
}

fn out(lib: &Library, name: &str, input: Value) -> Value {
    lib.call(&Actor::User, name, input).unwrap()["output"].clone()
}

/// A connected route (a key in the candidate store) or none.
fn provider(connected: bool) -> ProviderDriver {
    let local = "http://127.0.0.1:9";
    let credentials = if connected {
        Credentials::candidate(dr_agent::Provider::Deepseek, "synthetic-home-cards-key").unwrap()
    } else {
        Credentials::new(Arc::new(dr_platform::secrets::SecretStore::in_memory()))
    };
    ProviderDriver::with_endpoints(
        HttpClient::new().unwrap(),
        credentials,
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

/// The look's answer: one JSON object of cards.
fn look(cards: Value) -> Vec<Step> {
    vec![
        Step::Event(DriverEvent::TextDelta {
            index: 0,
            text: json!({ "cards": cards }).to_string(),
        }),
        Step::Event(DriverEvent::Finish(FinishReason::Complete)),
    ]
}

fn reply(text: &str) -> Vec<Step> {
    vec![
        Step::Event(DriverEvent::TextDelta {
            index: 0,
            text: text.into(),
        }),
        Step::Event(DriverEvent::Finish(FinishReason::Complete)),
    ]
}

struct Opened {
    ws: Entity<Workspace>,
    hub: Entity<AgentHub>,
    connections: Entity<Connections>,
    cards: Rc<RefCell<Option<Entity<HomeCards>>>>,
}

impl Opened {
    fn cards(&self) -> Entity<HomeCards> {
        self.cards.borrow().clone().expect("Home made its cards")
    }

    fn card_count(&self, cx: &mut VisualTestContext) -> usize {
        self.cards().read_with(cx, |c, _| {
            c.suggestions().map_or(0, |s| s.state.cards.len())
        })
    }

    fn statuses(&self, cx: &mut VisualTestContext) -> Vec<CardStatus> {
        self.cards().read_with(cx, |c, _| {
            c.suggestions()
                .map(|s| s.state.cards.iter().map(|c| c.status.clone()).collect())
                .unwrap_or_default()
        })
    }

    /// The conversation the right sidebar's Agent panel shows, if it shows
    /// one and the sidebar is open on Agent.
    fn companion(&self, cx: &mut VisualTestContext) -> Option<String> {
        let open = self.ws.read_with(cx, |ws, _| {
            ws.right.open
                && ws
                    .right
                    .panes
                    .panes
                    .iter()
                    .any(|p| p.tab == RightTab::Companion)
        });
        if !open {
            return None;
        }
        cx.update(|_, cx| {
            dr_view_agent::panels(cx).iter().find_map(|panel| {
                panel
                    .read(cx)
                    .snapshot()
                    .map(|s| s.conversation.as_str().to_owned())
            })
        })
    }

    fn go_home(&self, cx: &mut VisualTestContext, entry: &str) {
        let target = Target::Entry {
            id: entry.parse().unwrap(),
            module: None,
        };
        self.ws.update(cx, |ws, cx| ws.open(target, Open::KEEP, cx));
        wait(cx, "a page in front", |cx| {
            self.ws.read_with(cx, |ws, _| ws.nav.active_tab().is_some())
        });
        self.ws.update(cx, |ws, cx| ws.open_home(cx));
        wait(cx, "Home in front", |cx| {
            self.ws.read_with(cx, |ws, _| ws.nav.active_tab().is_none())
        });
    }
}

fn wait(
    cx: &mut VisualTestContext,
    stage: &str,
    mut done: impl FnMut(&mut VisualTestContext) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        cx.executor().advance_clock(Duration::from_millis(40));
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        if done(cx) {
            break;
        }
        assert!(Instant::now() < deadline, "timed out: {stage}");
        std::thread::sleep(Duration::from_millis(3));
    }
}

/// A few frames with nothing expected to change.
fn settle(cx: &mut VisualTestContext) {
    for _ in 0..25 {
        cx.executor().advance_clock(Duration::from_millis(40));
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        std::thread::sleep(Duration::from_millis(4));
    }
}

fn open<'a>(
    cx: &'a mut TestAppContext,
    f: &Fixture,
    driver: Arc<ScriptedDriver>,
    connected: bool,
    proactive: bool,
) -> (Opened, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    let made: Rc<RefCell<Option<Entity<HomeCards>>>> = Default::default();
    let (hub, connections) = cx.update(|cx| {
        let mut settings = SettingsFile::in_memory();
        settings
            .set(registry::UI_LOCALE, "zh-CN".into(), None)
            .unwrap();
        if !proactive {
            settings
                .set(registry::AGENT_PROACTIVE, false.into(), None)
                .unwrap();
        }
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "hc-home-cards-test",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(f.lib.clone()),
                book: Some(f.book.to_string()),
                ..Services::default()
            },
            settings,
            cx,
        );
        dr_view_agent::init_with(
            provider(connected),
            driver,
            Arc::new(CompanionTools::default()),
            cx,
        );
        dr_view_home::init(cx);
        // As the app wires them (`app/drifting/src/main.rs`).
        let made = made.clone();
        dr_view_home::set_agent_cards(cx, move |host, _, cx| {
            let cards = cx.new(|cx| HomeCards::new(host.workspace, cx));
            *made.borrow_mut() = Some(cards.clone());
            AgentCards::new(cards, HomeCards::drawn, HomeCards::shown)
        });
        let views = cx.global::<dr_view_agent::AgentViews>();
        let (hub, connections) = (views.hub.clone(), views.connections.clone());
        for p in PROVIDERS {
            connections.update(cx, |c, _| {
                c.set_catalog_endpoint(p, "http://127.0.0.1:9/models".into())
            });
        }
        (hub, connections)
    });
    let (ws, vcx) = cx.add_window_view(Workspace::new);
    vcx.simulate_resize(size(px(1280.0), px(1600.0)));
    vcx.update(|window, _| window.activate_window());
    wait(vcx, "the project on Home", |vcx| {
        ws.read_with(vcx, |ws, _| {
            ws.book.id == f.book.as_str() && ws.book.v3().is_some() && ws.v3_home.is_some()
        }) && hub.read_with(vcx, |h, _| h.controller.is_some())
            && connections.read_with(vcx, |c, _| c.usable().is_some())
    });
    ws.update(vcx, |ws, cx| ws.open_home(cx));
    let home: Entity<Home> = ws.read_with(vcx, |ws, _| {
        ws.v3_home.clone().unwrap().downcast::<Home>().unwrap()
    });
    wait(vcx, "Home drawn", |vcx| {
        home.read_with(vcx, |h, _| h.loaded.is_some()) && made.borrow().is_some()
    });
    (
        Opened {
            ws,
            hub,
            connections,
            cards: made,
        },
        vcx,
    )
}

fn close(w: &Opened, cx: &mut VisualTestContext, f: &Fixture) {
    let closing = w.hub.update(cx, |h, cx| h.prepare_close(cx));
    block_on(closing).unwrap();
    cx.run_until_parked();
    cx.update(|_, cx| dr_view_home::clear_agent_cards(cx));
    f.lib.close();
}

fn click_card(cx: &mut VisualTestContext, selector: &'static str) {
    let b = cx.debug_bounds(selector).unwrap();
    cx.simulate_click(
        point(b.left() + px(20.0), b.top() + px(20.0)),
        Modifiers::none(),
    );
}

/// Home coming to the front looks once; the cards sit two to a row; a card
/// opens its conversation in the right sidebar's Agent while Home stays,
/// and then reads 查看对话 and opens the same conversation again.
#[gpui::test]
fn home_looks_once_shows_two_columns_and_a_card_opens_its_conversation(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let driver = Arc::new(ScriptedDriver::new(vec![
        look(json!([
            {"title": "「回信」里说灯塔停了十年，要对一下吗？", "detail": "两处都是你写的。",
             "instruction": "核对两处的年数，把原文摆出来问我。", "target": "c1"},
            {"title": "项目记忆里有两条在说同一件事，要合成一条吗？",
             "instruction": "把两条合成一条。"},
            {"title": "第三张合成卡", "detail": "合成的依据。", "instruction": "合成的任务。"}
        ])),
        reply("好，我先读一遍。"),
    ]));
    let (w, cx) = open(cx, &f, driver.clone(), true, true);
    wait(cx, "three cards on Home", |cx| {
        w.card_count(cx) == 3 && cx.debug_bounds("home-agent-card-2").is_some()
    });
    let requests = driver.requests();
    assert_eq!(requests.len(), 1, "one look");
    assert!(requests[0].purpose.is_single() && requests[0].tools.is_empty());
    let stored = f.stored();
    assert_eq!(
        stored.cards[0].card.target.as_ref().map(|t| t.id.as_str()),
        Some(f.entry.as_str()),
        "the first card is about the revised chapter"
    );

    // Two to a row, in the cards' order.
    let (c0, c1, c2) = (
        cx.debug_bounds("home-agent-card-0").unwrap(),
        cx.debug_bounds("home-agent-card-1").unwrap(),
        cx.debug_bounds("home-agent-card-2").unwrap(),
    );
    assert_eq!(c0.top(), c1.top());
    assert!(c1.left() >= c0.right());
    assert_eq!(c2.left(), c0.left());
    assert!(c2.top() >= c0.bottom().min(c1.bottom()));
    let slot = cx.debug_bounds("v3-home-agent-cards").unwrap();
    assert!(slot.top() <= c0.top() && c2.bottom() <= slot.bottom());
    assert!(cx.debug_bounds("home-agent-checking").is_none());

    // Within 90 minutes Home coming back asks, but nothing is looked at.
    let opened = f.stored().last_opened_ms;
    w.go_home(cx, &f.entry);
    wait(cx, "the second ask", |_| {
        f.stored().last_opened_ms != opened
    });
    settle(cx);
    assert_eq!(
        driver.requests().len(),
        1,
        "no second look within 90 minutes"
    );

    // The card opens a conversation: the right sidebar on Agent, Home stays.
    assert_eq!(w.companion(cx), None);
    click_card(cx, "home-agent-card-0");
    wait(cx, "the card's conversation beside Home", |cx| {
        let started = match &w.statuses(cx)[0] {
            CardStatus::Started { conversation } => Some(conversation.clone()),
            _ => None,
        };
        started.is_some() && w.companion(cx) == started
    });
    assert!(
        w.ws.read_with(cx, |ws, _| ws.nav.active_tab().is_none()),
        "Home stays"
    );
    let requests = driver.requests();
    assert_eq!(requests.len(), 2);
    assert!(
        serde_json::to_string(&requests[1].conversation)
            .unwrap()
            .contains("核对两处的年数"),
        "the conversation starts from the card's instruction"
    );
    let CardStatus::Started { conversation } = w.statuses(cx)[0].clone() else {
        unreachable!()
    };
    assert_eq!(w.card_count(cx), 3, "the card stays");

    // Elsewhere in the panel, then the card again: the same conversation.
    let panel = cx.update(|_, cx| dr_view_agent::panels(cx)[0].clone());
    panel.update(cx, |p, cx| p.new_conversation(cx));
    wait(cx, "a new conversation in the panel", |cx| {
        panel.read_with(cx, |p, _| p.snapshot().is_none())
    });
    click_card(cx, "home-agent-card-0");
    wait(cx, "the same conversation", |cx| {
        w.companion(cx).as_deref() == Some(conversation.as_str())
    });
    assert_eq!(driver.requests().len(), 2, "查看对话 starts nothing");
    close(&w, cx, &f);
}

/// × takes a card away for good; a start that fails says so under the card,
/// which can be clicked again.
#[gpui::test]
fn a_dismissed_card_stays_gone_and_a_failed_start_says_so(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let driver = Arc::new(ScriptedDriver::new(vec![
        look(json!([
            {"title": "第一张合成卡", "detail": "依据。", "instruction": "第一项合成任务。"},
            {"title": "第二张合成卡", "detail": "依据。", "instruction": "第二项合成任务。"}
        ])),
        reply("好。"),
    ]));
    let (w, cx) = open(cx, &f, driver.clone(), true, true);
    wait(cx, "two cards", |cx| {
        w.card_count(cx) == 2 && cx.debug_bounds("home-agent-card-1").is_some()
    });
    let gone = f.stored().cards[1].card.id.clone();
    let b = cx.debug_bounds("home-agent-card-1").unwrap();
    // The × in its top right corner.
    cx.simulate_click(
        point(b.right() - px(18.0), b.top() + px(18.0)),
        Modifiers::none(),
    );
    wait(cx, "the card gone", |cx| {
        w.card_count(cx) == 1 && cx.debug_bounds("home-agent-card-1").is_none()
    });
    wait(cx, "and gone from the store", |_| {
        f.stored().cards.iter().all(|c| c.card.id != gone)
    });
    assert_eq!(driver.requests().len(), 1, "× starts nothing");
    w.go_home(cx, &f.entry);
    settle(cx);
    assert_eq!(w.card_count(cx), 1, "Home again: it does not come back");

    // A start that fails: the line under the card, and the card still Open.
    let controller = w.hub.read_with(cx, |h, _| h.controller.clone().unwrap());
    controller.set_proactive_enabled(false);
    click_card(cx, "home-agent-card-0");
    wait(cx, "没能开始", |cx| {
        cx.debug_bounds("home-agent-card-failed-0").is_some()
    });
    assert_eq!(w.statuses(cx), vec![CardStatus::Open]);
    assert_eq!(driver.requests().len(), 1);
    controller.set_proactive_enabled(true);
    click_card(cx, "home-agent-card-0");
    wait(cx, "started the second time", |cx| {
        matches!(w.statuses(cx)[0], CardStatus::Started { .. })
            && cx.debug_bounds("home-agent-card-failed-0").is_none()
    });
    assert_eq!(driver.requests().len(), 2);
    close(&w, cx, &f);
}

/// 设置 → 智能 → Agent → 主动建议: off, Home shows nothing and nothing is
/// looked at; on, the next time Home comes to the front.
#[gpui::test]
fn the_switch_in_settings_turns_the_cards_off_and_on(cx: &mut TestAppContext) {
    let def = registry::find(registry::AGENT_PROACTIVE).unwrap();
    assert_eq!(def.kind, registry::Kind::Switch);
    assert_eq!(def.scope, registry::Scope::Device);
    assert_eq!(def.default_value(), Value::Bool(true));
    assert_eq!(def.section, registry::Section::Agent);
    assert_eq!(def.label, dr_i18n::keys::project_home::settings::PROACTIVE);
    assert_eq!(def.description, None);
    assert_eq!(
        registry::in_section(registry::Section::Agent)
            .last()
            .map(|d| d.key),
        Some(registry::AGENT_PROACTIVE),
        "the last row of the Agent page"
    );

    let f = Fixture::new();
    let driver = Arc::new(ScriptedDriver::new(vec![look(json!([
        {"title": "一张合成卡", "instruction": "合成任务。"}
    ]))]));
    let (w, cx) = open(cx, &f, driver.clone(), true, false);
    settle(cx);
    assert!(driver.requests().is_empty(), "off: no look");
    assert_eq!(f.stored().last_opened_ms, None, "nor any ask");
    assert!(cx.debug_bounds("v3-home-agent-cards").is_none());

    // On: nothing yet, until Home next comes to the front.
    cx.update(|_, cx| {
        Settings::update(cx, |s| s.set(registry::AGENT_PROACTIVE, true.into(), None)).unwrap();
    });
    settle(cx);
    assert!(driver.requests().is_empty());
    w.go_home(cx, &f.entry);
    wait(cx, "cards after Home came back", |cx| {
        cx.debug_bounds("home-agent-card-0").is_some()
    });
    assert_eq!(driver.requests().len(), 1);

    // Off again: Home shows nothing.
    cx.update(|_, cx| {
        Settings::update(cx, |s| s.set(registry::AGENT_PROACTIVE, false.into(), None)).unwrap();
    });
    wait(cx, "nothing on Home", |cx| {
        cx.debug_bounds("v3-home-agent-cards").is_none()
    });
    assert_eq!(
        f.stored().cards.len(),
        1,
        "the card is kept, only not shown"
    );
    close(&w, cx, &f);
}

/// Without a model nothing runs and Home shows nothing, cards an earlier
/// look left included.
#[gpui::test]
fn without_a_model_nothing_runs_and_home_shows_nothing(cx: &mut TestAppContext) {
    let f = Fixture::new();
    f.earlier_cards(&["上一次的合成卡"]);
    let driver = Arc::new(ScriptedDriver::new(vec![]));
    let (w, cx) = open(cx, &f, driver.clone(), false, true);
    assert_eq!(w.connections.read_with(cx, |c, _| c.usable()), Some(false));
    wait(cx, "the stored card read", |cx| w.card_count(cx) == 1);
    settle(cx);
    assert!(driver.requests().is_empty());
    assert!(cx.debug_bounds("v3-home-agent-cards").is_none());
    close(&w, cx, &f);
}

/// While the Agent looks, a line above the cards (an earlier look's stay
/// until this one is done).
#[gpui::test]
fn a_look_under_way_has_its_line_above_the_cards(cx: &mut TestAppContext) {
    let f = Fixture::new();
    f.earlier_cards(&["上一次的合成卡"]);
    let (go, held) = oneshot::channel();
    let driver = Arc::new(ScriptedDriver::new(vec![{
        let mut steps = vec![Step::Wait(held)];
        steps.extend(look(
            json!([{"title": "这一次的合成卡", "instruction": "合成任务。"}]),
        ));
        steps
    }]));
    let (w, cx) = open(cx, &f, driver.clone(), true, true);
    wait(cx, "the line while it looks", |cx| {
        cx.debug_bounds("home-agent-checking").is_some()
            && cx.debug_bounds("home-agent-card-0").is_some()
    });
    let line = cx.debug_bounds("home-agent-checking").unwrap();
    assert!(line.bottom() <= cx.debug_bounds("home-agent-card-0").unwrap().top());
    assert_eq!(f.stored().cards[0].card.title, "上一次的合成卡");
    go.send(()).unwrap();
    wait(cx, "this look's card", |cx| {
        cx.debug_bounds("home-agent-checking").is_none()
            && f.stored().cards.first().map(|c| c.card.title.as_str()) == Some("这一次的合成卡")
            && w.card_count(cx) == 1
    });
    close(&w, cx, &f);
}

/// A look that fails: its line, and the earlier cards stay.

#[gpui::test]
fn a_failed_look_says_so_and_keeps_the_cards(cx: &mut TestAppContext) {
    let f = Fixture::new();
    f.earlier_cards(&["上一次的合成卡"]);
    let driver = Arc::new(ScriptedDriver::new(vec![vec![Step::Fail(
        "合成的请求失败".into(),
    )]]));
    let (w, cx) = open(cx, &f, driver.clone(), true, true);
    wait(cx, "the failed line", |cx| {
        cx.debug_bounds("home-agent-check-failed").is_some()
    });
    assert_eq!(driver.requests().len(), 1);
    assert!(cx.debug_bounds("home-agent-card-0").is_some());
    assert!(cx.debug_bounds("home-agent-checking").is_none());
    close(&w, cx, &f);
}

/// A look with no cards leaves nothing on Home.
#[gpui::test]
fn a_look_with_no_cards_leaves_nothing(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let driver = Arc::new(ScriptedDriver::new(vec![look(json!([]))]));
    let (w, cx) = open(cx, &f, driver.clone(), true, true);
    wait(cx, "the look done", |_| {
        f.stored().last_checkin_ms.is_some()
    });
    settle(cx);
    assert_eq!(driver.requests().len(), 1);
    assert!(cx.debug_bounds("v3-home-agent-cards").is_none());
    close(&w, cx, &f);
}

/// The Agent panel no longer looks: opening it, and the window coming back
/// with a page in front, ask nothing.
#[gpui::test]
fn the_agent_panel_does_not_look(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let driver = Arc::new(ScriptedDriver::new(vec![look(json!([
        {"title": "一张合成卡", "instruction": "合成任务。"}
    ]))]));
    let (w, cx) = open(cx, &f, driver.clone(), true, true);
    wait(cx, "the card", |cx| {
        cx.debug_bounds("home-agent-card-0").is_some()
    });
    let opened = f.stored().last_opened_ms;
    assert!(opened.is_some());

    // A page in front, the right sidebar on Agent, an empty conversation.
    let target = Target::Entry {
        id: f.entry.parse().unwrap(),
        module: None,
    };
    w.ws.update(cx, |ws, cx| ws.open(target, Open::KEEP, cx));
    cx.update(|window, cx| w.ws.update(cx, |ws, cx| ws.reveal_companion(window, cx)));
    wait(cx, "the panel", |cx| {
        cx.update(|_, cx| !dr_view_agent::panels(cx).is_empty())
    });
    let panel = cx.update(|_, cx| dr_view_agent::panels(cx)[0].clone());
    panel.update(cx, |p, cx| p.new_conversation(cx));
    cx.deactivate_window();
    cx.update(|window, _| window.activate_window());
    settle(cx);
    assert_eq!(f.stored().last_opened_ms, opened, "nothing asked");
    assert_eq!(driver.requests().len(), 1);
    close(&w, cx, &f);
}
