//! CM4a: images in the Agent panel's composer. A real GPUI panel over a
//! synthetic seed library and the scripted model; dr-testkit's synthetic
//! images; a loopback model list. No real provider, key or model.

use std::{
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use dr_agent::{
    ContentBlock, DriverEvent, FinishReason, Provider, State,
    driver::scripted::{ScriptedDriver, Step},
    images::{MAX_IMAGES_PER_MESSAGE, payload_images},
};
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, credentials::Credentials,
    oauth::OAuthEndpoints,
};
use dr_model::id::BookId;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace as ShellWorkspace, strings::t};
use dr_testkit::seed::{self, Preset};
use dr_view_agent::{
    connection::{Connections, PROVIDERS},
    hub::AgentHub,
    images::Thumb,
    local::{LocalServer, LocalServerModel},
    panel::AgentPanel,
    state::{ChatSnapshot, MessageContent},
    tools::CompanionTools,
};
use dr_workspace::Workspace;
use futures::executor::block_on;
use gpui::{
    ClipboardItem, Entity, Focusable as _, Image, ImageFormat, PlatformInput, TestAppContext,
    VisualTestContext, point,
};
use serde_json::json;

struct Fixture {
    dir: tempfile::TempDir,
    ws: Workspace,
    book: BookId,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path().join("library"), "cm4a-panel-test").unwrap();
        ws.set_auto_links(false);
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().clone();
        seeded.write_to(ws.library()).unwrap();
        Self { dir, ws, book }
    }

    /// A synthetic image written beside the library, as a file to drop.
    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }
}

struct Views {
    panel: Entity<AgentPanel>,
    hub: Entity<AgentHub>,
    connections: Entity<Connections>,
    /// The shell's window, whose 「Agent」 tab is a panel of its own.
    shell: gpui::WindowHandle<ShellWorkspace>,
}

/// Models list on loopback: an Anthropic list whose first bundled model
/// takes images.
struct ModelList {
    url: String,
    asked: Arc<Mutex<usize>>,
    stop: Arc<AtomicBool>,
}

impl ModelList {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/models", listener.local_addr().unwrap());
        let (asked, stop) = (Arc::new(Mutex::new(0)), Arc::new(AtomicBool::new(false)));
        let (count, closing) = (asked.clone(), stop.clone());
        let body = json!({"data":[
            {"id":"claude-sonnet-5-5","capabilities":{"image_input":{"supported":true}}},
        ],"has_more":false})
        .to_string();
        std::thread::spawn(move || {
            while !closing.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        socket.set_nonblocking(false).unwrap();
                        let _ = socket.set_read_timeout(Some(Duration::from_secs(2)));
                        let mut buf = [0; 4096];
                        let _ = socket.read(&mut buf);
                        *count.lock().unwrap() += 1;
                        let _ = socket.write_all(
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            )
                            .as_bytes(),
                        );
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(2)),
                }
            }
        });
        Self { url, asked, stop }
    }
}

impl Drop for ModelList {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

fn provider(keys: &[Provider]) -> ProviderDriver {
    let nowhere = "http://127.0.0.1:9";
    let store = Arc::new(dr_platform::SecretStore::in_memory());
    for provider in keys {
        store
            .set(&format!("byok.{}", provider.as_str()), "synthetic-cm4a-key")
            .unwrap();
    }
    ProviderDriver::with_endpoints(
        HttpClient::new().unwrap(),
        Credentials::new(store),
        Endpoints {
            deepseek: nowhere.into(),
            anthropic: nowhere.into(),
            openai: nowhere.into(),
            chatgpt: nowhere.into(),
        },
        OAuthEndpoints::at(nowhere).unwrap(),
        RetryPolicy {
            max_attempts: 1,
            ..Default::default()
        },
    )
}

fn open<'a>(
    cx: &'a mut TestAppContext,
    fixture: &Fixture,
    driver: Arc<ScriptedDriver>,
    keys: &[Provider],
    catalog: &str,
) -> (Views, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    let catalog = catalog.to_owned();
    let (hub, connections) = cx.update(|cx| {
        let mut settings = SettingsFile::in_memory();
        settings.set_last_book(fixture.book.as_str());
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "cm4a-panel-test",
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
        dr_view_agent::init_with(
            provider(keys),
            driver,
            Arc::new(CompanionTools::default()),
            cx,
        );
        let views = cx.global::<dr_view_agent::AgentViews>();
        let (hub, connections) = (views.hub.clone(), views.connections.clone());
        for provider in PROVIDERS {
            connections.update(cx, |connections, _| {
                connections.set_catalog_endpoint(provider, catalog.clone())
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
    let views = Views {
        panel,
        hub,
        connections,
        shell: shell_window,
    };
    wait(cx, |cx| {
        shell.read_with(cx, |ws, _| {
            ws.book_id == fixture.book.as_str() && !ws.book.is_empty()
        }) && views
            .connections
            .read_with(cx, |connections, _| connections.usable() == Some(true))
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

fn wait(cx: &mut VisualTestContext, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        draw(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "Agent panel condition timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn settled(views: &Views, cx: &mut VisualTestContext) {
    wait(cx, |cx| {
        views.panel.read_with(cx, |panel, _| panel.is_settled())
    });
}

fn attached(views: &Views, cx: &VisualTestContext) -> usize {
    views.panel.read_with(cx, |panel, _| panel.attached().len())
}

fn error(views: &Views, cx: &VisualTestContext) -> Option<String> {
    views
        .panel
        .read_with(cx, |panel, _| panel.error().map(str::to_owned))
}

fn snapshot(views: &Views, cx: &VisualTestContext) -> Option<ChatSnapshot> {
    views
        .panel
        .read_with(cx, |panel, _| panel.snapshot().cloned())
}

fn composer_text(views: &Views, cx: &VisualTestContext) -> String {
    let field = views.panel.read_with(cx, |panel, _| panel.composer());
    field.read_with(cx, |field, _| field.text())
}

fn focus_composer(views: &Views, cx: &mut VisualTestContext) {
    let field = views.panel.read_with(cx, |panel, _| panel.composer());
    cx.update(|window, cx| field.focus_handle(cx).focus(window, cx));
    draw(cx);
}

fn paste(item: ClipboardItem, views: &Views, cx: &mut VisualTestContext) {
    cx.update(|_, cx| cx.write_to_clipboard(item));
    focus_composer(views, cx);
    cx.dispatch_action(dr_ui::input::field::Paste);
    settled(views, cx);
}

fn drop_files(paths: Vec<PathBuf>, views: &Views, cx: &mut VisualTestContext) {
    drop_on("agent-composer-area", paths, views, cx)
}

/// Dropped on the middle of the element drawn with `selector`.
fn drop_on(selector: &'static str, paths: Vec<PathBuf>, views: &Views, cx: &mut VisualTestContext) {
    let area = cx.debug_bounds(selector).unwrap();
    let at = point(
        area.origin.x + area.size.width / 2.,
        area.origin.y + area.size.height / 2.,
    );
    cx.update(|window, cx| {
        window.dispatch_event(
            PlatformInput::FileDrop(gpui::FileDropEvent::Entered {
                position: at,
                paths: gpui::ExternalPaths(paths.into_iter().collect()),
            }),
            cx,
        );
        window.dispatch_event(
            PlatformInput::FileDrop(gpui::FileDropEvent::Submit { position: at }),
            cx,
        );
        window.dispatch_event(PlatformInput::FileDrop(gpui::FileDropEvent::Ended), cx);
    });
    settled(views, cx);
}

fn close(views: &Views, fixture: &Fixture, cx: &mut VisualTestContext) {
    let close = views.hub.update(cx, |hub, cx| hub.prepare_close(cx));
    block_on(close).unwrap();
    cx.run_until_parked();
    fixture.ws.close();
}

fn text_reply(text: &str) -> Vec<Step> {
    vec![
        Step::Event(DriverEvent::TextDelta {
            index: 0,
            text: text.into(),
        }),
        Step::Event(DriverEvent::Finish(FinishReason::Complete)),
    ]
}

fn png_item(bytes: &[u8]) -> ClipboardItem {
    ClipboardItem::new_image(&Image::from_bytes(ImageFormat::Png, bytes.to_vec()))
}

#[gpui::test]
fn paste_and_drop_attach_images_and_text_pastes_as_text(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let driver = Arc::new(ScriptedDriver::new(Vec::new()));
    let (views, cx) = open(
        cx,
        &fixture,
        driver,
        &[Provider::Deepseek],
        "http://127.0.0.1:9/models",
    );
    let map = dr_testkit::media::png(320, 200);
    // An image on the clipboard goes into the composer, not its text.
    paste(png_item(&map), &views, cx);
    assert_eq!(attached(&views, cx), 1);
    assert_eq!(composer_text(&views, cx), "");
    assert!(cx.debug_bounds("agent-attachment-0").is_some());
    let image = views
        .panel
        .read_with(cx, |panel, _| panel.attached()[0].image.clone());
    assert_eq!((image.width, image.height), (320, 200));
    assert!(matches!(
        views
            .panel
            .read_with(cx, |panel, _| panel.thumb(&image).cloned()),
        Some(Thumb::Ready(_))
    ));
    // Text on the clipboard is pasted as text; the image stays.
    paste(ClipboardItem::new_string("潮声".into()), &views, cx);
    assert_eq!(composer_text(&views, cx), "潮声");
    assert_eq!(attached(&views, cx), 1);
    // The same image again is the same attachment.
    paste(png_item(&map), &views, cx);
    assert_eq!(attached(&views, cx), 1);

    // Files dropped on the composer: the images go, a HEIC does not, and
    // the line under the transcript says why.
    let quadrants = fixture.file("quadrants.png", &dr_testkit::media::quadrants(60, 40));
    let heic = fixture.file("photo.heic", dr_testkit::media::HEIC);
    drop_files(vec![quadrants, heic], &views, cx);
    assert_eq!(attached(&views, cx), 2);
    let unsupported =
        cx.update(|_, cx| t(cx, dr_i18n::keys::agent_images::UNSUPPORTED).to_string());
    assert_eq!(error(&views, cx), Some(unsupported));

    // Anywhere on the Agent column takes them: over the send button, and
    // over the conversation above the composer.
    let on_send = fixture.file("send.png", &dr_testkit::media::png(30, 30));
    drop_on("agent-send", vec![on_send], &views, cx);
    assert_eq!(attached(&views, cx), 3);
    let above = fixture.file("above.png", &dr_testkit::media::png(31, 30));
    drop_on("agent-empty", vec![above], &views, cx);
    assert_eq!(attached(&views, cx), 4);
    views.panel.update(cx, |panel, cx| {
        panel.remove_attached(3, cx);
        panel.remove_attached(2, cx);
    });
    draw(cx);
    assert_eq!(attached(&views, cx), 2);

    // Taking one out (the button next to its picture).
    views
        .panel
        .update(cx, |panel, cx| panel.remove_attached(0, cx));
    draw(cx);
    assert_eq!(attached(&views, cx), 1);
    assert!(cx.debug_bounds("agent-attachment-1").is_none());
    close(&views, &fixture, cx);
}

#[gpui::test]
fn the_limits_are_said_before_anything_is_sent(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let driver = Arc::new(ScriptedDriver::new(Vec::new()));
    let (views, cx) = open(
        cx,
        &fixture,
        driver.clone(),
        &[Provider::Deepseek],
        "http://127.0.0.1:9/models",
    );
    let too_wide = fixture.file("wide.png", &dr_testkit::media::png(8001, 2));
    drop_files(vec![too_wide], &views, cx);
    assert_eq!(attached(&views, cx), 0);
    let said = error(&views, cx).unwrap();
    assert!(said.contains("7") && said.contains("8000"), "{said}");
    // A file larger than an image may be is not read at all.
    let mut big = dr_testkit::media::png(4, 4);
    big.resize(dr_agent::images::MAX_IMAGE_BYTES as usize + 1, 0);
    let big = fixture.file("big.png", &big);
    drop_files(vec![big], &views, cx);
    assert_eq!(error(&views, cx), Some(said));
    // Five different images: four go, and the fifth is said.
    let files: Vec<_> = (0..=MAX_IMAGES_PER_MESSAGE as u32)
        .map(|n| fixture.file(&format!("{n}.png"), &dr_testkit::media::png(10 + n, 10)))
        .collect();
    drop_files(files, &views, cx);
    assert_eq!(attached(&views, cx), MAX_IMAGES_PER_MESSAGE);
    let too_many = error(&views, cx).unwrap();
    assert!(
        too_many.contains(&MAX_IMAGES_PER_MESSAGE.to_string()),
        "{too_many}"
    );
    assert!(driver.requests().is_empty());
    close(&views, &fixture, cx);
}

/// CW: images a page hands to the Agent (the module workbench's paper,
/// through the shell) wait in the composer of that window's 「Agent」 tab,
/// checked and limited as dropped ones, and the right column opens on it.
#[gpui::test]
fn images_handed_over_from_a_page_wait_in_the_windows_agent_composer(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let driver = Arc::new(ScriptedDriver::new(Vec::new()));
    let (views, cx) = open(
        cx,
        &fixture,
        driver.clone(),
        &[Provider::Deepseek],
        "http://127.0.0.1:9/models",
    );
    let sketch = fixture.file("handed.png", &dr_testkit::media::png(50, 40));
    let heic = fixture.file("handed.heic", dr_testkit::media::HEIC);
    views
        .shell
        .update(cx, |ws, window, cx| {
            ws.give_agent_images(
                dr_shell::pages::AgentImages::Files(vec![sketch, heic]),
                window,
                cx,
            )
        })
        .unwrap();
    // The window's own 「Agent」 tab (not the panel this test made).
    let tab = |cx: &mut VisualTestContext| {
        cx.update(|_, cx| {
            dr_view_agent::panels(cx)
                .into_iter()
                .find(|p| p.entity_id() != views.panel.entity_id())
        })
    };
    let panel = tab(cx).expect("the shell made its 「Agent」 tab to hand them to");
    // Read and checked off the main thread, then the line under the
    // transcript says what could not go (the panel of a window this test
    // does not draw may still be loading its conversations).
    wait(cx, |cx| {
        panel.read_with(cx, |p, _| p.attached().len() == 1 && p.error().is_some())
    });
    let unsupported =
        cx.update(|_, cx| t(cx, dr_i18n::keys::agent_images::UNSUPPORTED).to_string());
    assert_eq!(
        panel.read_with(cx, |p, _| p.error().map(str::to_owned)),
        Some(unsupported)
    );
    assert!(
        views.shell.read_with(cx, |ws, _| ws.right.open).unwrap(),
        "the right column opens"
    );
    // Pasted pictures: the per-message limit is said, as in the composer.
    let pictures: Vec<Vec<u8>> = (0..MAX_IMAGES_PER_MESSAGE as u32)
        .map(|n| dr_testkit::media::png(20 + n, 20))
        .collect();
    views
        .shell
        .update(cx, |ws, window, cx| {
            ws.give_agent_images(dr_shell::pages::AgentImages::Bytes(pictures), window, cx)
        })
        .unwrap();
    wait(cx, |cx| {
        panel.read_with(cx, |p, _| p.attached().len() == MAX_IMAGES_PER_MESSAGE)
    });
    let too_many = panel
        .read_with(cx, |p, _| p.error().map(str::to_owned))
        .unwrap();
    assert!(
        too_many.contains(&MAX_IMAGES_PER_MESSAGE.to_string()),
        "{too_many}"
    );
    // Nothing is sent.
    assert!(driver.requests().is_empty());
    close(&views, &fixture, cx);
}

#[gpui::test]
fn a_model_that_cannot_see_is_not_asked_and_the_agent_says_so(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let driver = Arc::new(ScriptedDriver::new(vec![text_reply("不该被调用")]));
    let (views, cx) = open(
        cx,
        &fixture,
        driver.clone(),
        &[Provider::Deepseek],
        "http://127.0.0.1:9/models",
    );
    paste(png_item(&dr_testkit::media::png(64, 48)), &views, cx);
    let field = views.panel.read_with(cx, |panel, _| panel.composer());
    field.update(cx, |field, cx| field.set_text("照这张草图建一个模块", cx));
    views.panel.update(cx, |panel, cx| panel.send(cx));
    wait(cx, |cx| {
        views.panel.read_with(cx, |panel, _| panel.is_settled())
            && snapshot(&views, cx).is_some_and(|s| {
                s.runs
                    .first()
                    .is_some_and(|run| run.state == State::Completed)
                    && s.messages.len() == 2
            })
    });
    assert!(driver.requests().is_empty(), "DeepSeek was not asked");
    assert_eq!(attached(&views, cx), 0, "what was sent left the composer");
    assert_eq!(composer_text(&views, cx), "");
    let snapshot = snapshot(&views, cx).unwrap();
    let MessageContent::User { text, images } = &snapshot.messages[0].content else {
        panic!("the author's message comes first");
    };
    assert_eq!(text, "照这张草图建一个模块");
    assert_eq!(images.len(), 1);
    let MessageContent::Assistant { message } = &snapshot.messages[1].content else {
        panic!("then the Agent's");
    };
    let unseen = cx.update(|_, cx| t(cx, dr_i18n::keys::agent_images::UNSEEN).to_string());
    assert_eq!(
        message.blocks,
        vec![ContentBlock::Text {
            index: 0,
            text: unseen
        }]
    );
    // The transcript shows the image the message names.
    let tile: &'static str =
        Box::leak(format!("agent-message-{}-image-0", snapshot.messages[0].id).into_boxed_str());
    wait(cx, |cx| {
        cx.debug_bounds(tile).is_some()
            && views.panel.read_with(cx, |panel, _| {
                matches!(
                    panel.thumb(images[0].as_ref().unwrap()),
                    Some(Thumb::Ready(_))
                )
            })
    });
    close(&views, &fixture, cx);
}

#[gpui::test]
fn a_local_model_that_sees_gets_the_bytes_and_one_that_does_not_is_told(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let driver = Arc::new(ScriptedDriver::new(vec![text_reply("看到了")]));
    let (views, cx) = open(
        cx,
        &fixture,
        driver.clone(),
        &[Provider::Deepseek],
        "http://127.0.0.1:9/models",
    );
    let mut sees = LocalServerModel::new("sees", Some(32_768));
    sees.image_input = Some(true);
    let server = LocalServer {
        id: "cm4a-local".into(),
        base_url: "http://localhost:11434".into(),
        label: "Ollama".into(),
        has_key: false,
        manual: false,
        models: vec![sees, LocalServerModel::new("blind", Some(32_768))],
    };
    views
        .connections
        .update(cx, |c, cx| c.put_local(server, true, cx));
    draw(cx);
    // An image alone is a message.
    let map = dr_testkit::media::png(64, 48);
    paste(png_item(&map), &views, cx);
    views.panel.update(cx, |panel, cx| panel.send(cx));
    wait(cx, |cx| {
        views.panel.read_with(cx, |panel, _| panel.is_settled())
            && snapshot(&views, cx).is_some_and(|s| s.messages.len() == 2)
    });
    let requests = driver.requests();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].config.sees_images());
    let user = requests[0]
        .conversation
        .iter()
        .find(|e| !payload_images(&e.payload).is_empty())
        .unwrap();
    assert_eq!(user.payload["text"], "");
    assert_eq!(requests[0].images.get(&user.id, 0).unwrap(), map.as_slice());

    // The same conversation on a local model the server did not say sees.
    assert!(
        views
            .connections
            .update(cx, |c, cx| c.select_local("cm4a-local", "blind", cx))
    );
    paste(png_item(&dr_testkit::media::quadrants(20, 10)), &views, cx);
    views.panel.update(cx, |panel, cx| panel.send(cx));
    wait(cx, |cx| {
        views.panel.read_with(cx, |panel, _| panel.is_settled())
            && snapshot(&views, cx).is_some_and(|s| s.messages.len() == 4)
    });
    assert_eq!(driver.requests().len(), 1, "the model was not asked again");
    close(&views, &fixture, cx);
}

#[gpui::test]
fn anthropics_live_list_is_asked_before_an_image_goes(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let list = ModelList::new();
    let driver = Arc::new(ScriptedDriver::new(vec![text_reply("一张地图")]));
    let (views, cx) = open(
        cx,
        &fixture,
        driver.clone(),
        &[Provider::Deepseek, Provider::Anthropic],
        &list.url,
    );
    assert!(
        views
            .connections
            .update(cx, |c, cx| c.select_provider(Provider::Anthropic, cx))
    );
    draw(cx);
    let asked_before = *list.asked.lock().unwrap();
    let map = dr_testkit::media::png(64, 48);
    paste(png_item(&map), &views, cx);
    let field = views.panel.read_with(cx, |panel, _| panel.composer());
    field.update(cx, |field, cx| field.set_text("看图", cx));
    views.panel.update(cx, |panel, cx| panel.send(cx));
    wait(cx, |cx| {
        views.panel.read_with(cx, |panel, _| panel.is_settled())
            && snapshot(&views, cx).is_some_and(|s| s.messages.len() == 2)
    });
    assert!(
        *list.asked.lock().unwrap() > asked_before,
        "the live list was asked"
    );
    let requests = driver.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].config.route.provider, Provider::Anthropic);
    assert!(requests[0].config.sees_images());
    assert_eq!(requests[0].images.len(), 1);
    close(&views, &fixture, cx);
}
