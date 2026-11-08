//! Automatic updates in the app, on GPUI's test platform, against a
//! stand-in for GitHub Releases on 127.0.0.1 (dr-platform's
//! `fake_server`), with a throwaway key pair and a synthetic installed
//! bundle in a temp folder. Nothing here reaches a real server, the release
//! key or an installed app; reopening is recorded, not done.
//!
//! - the first check runs after launch, then every three hours; a newer
//!   version is downloaded and verified, the notification center offers
//!   「重启以更新」, and its button quits, installs and reopens;
//! - an update waiting for the quit installs on an ordinary quit too, and
//!   the new version says so once; a relaunch before installing keeps the
//!   verified file and does not download it again;
//! - a bad signature, an older release offered as newer, a download cut
//!   short, no connection, and an offer older than this version are
//!   refused, nothing is kept, and each is said: in Settings always, in the
//!   notification center when the file itself was wrong;
//! - a bundle of another version is not installed at quit, and the next
//!   launch says so.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use dr_i18n::keys;
use dr_platform::update::fetch::fake_server::{FakeServer, Serve, refused_base};
use dr_platform::update::install::test_bundles::{archive_of, write_app};
use dr_platform::update::signature::test_keys::TestKey;
use dr_platform::update::{
    Downloads, Problem, Target, UpdateFetch, Updater, UpdaterConfig, UrlPolicy,
};
use dr_shell::notifications::{Notice, Notifications, Source};
use dr_shell::strings::{t, tf};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_update::{Install, Schedule, Service, Status, Updates};
use gpui::{App, TestAppContext, VisualTestContext};
use semver::Version;

const DEV: &str = "cc.drifting.next.dev";
const MANIFEST: &str = "/releases/latest/download/update.json";
const ARTIFACT: &str = "/releases/download/v/Drifting.app.tar.gz";

fn v(text: &str) -> Version {
    Version::parse(text).unwrap()
}

fn info() -> ShellInfo {
    ShellInfo {
        app_name: "Drifting Next",
        bundle_id: DEV,
        version: "0.2.0-dev",
        url_scheme: "drifting-next-dev",
        forced_appearance: None,
    }
}

/// A synthetic release: an app archive whose bundle says `bundle_version`,
/// signed as the release file of `signed_as`.
struct Build {
    archive: Vec<u8>,
    signature: String,
}

fn build(key: &TestKey, bundle_version: &str, signed_as: &str, tamper: bool) -> Build {
    let dir = tempfile::tempdir().unwrap();
    let app = write_app(
        dir.path(),
        DEV,
        &format!("v{bundle_version}"),
        bundle_version,
    );
    let path = dir.path().join("Drifting.app.tar.gz");
    archive_of(&app, &path);
    let mut archive = std::fs::read(&path).unwrap();
    let signature = key.sign_as(
        &archive,
        &format!("Drifting_{signed_as}_aarch64.app.tar.gz"),
    );
    if tamper {
        let last = archive.len() - 1;
        archive[last] ^= 0xff;
    }
    Build { archive, signature }
}

struct Env {
    server: FakeServer,
    key: TestKey,
    data: tempfile::TempDir,
    _apps: tempfile::TempDir,
    bundle: PathBuf,
    reopened: Rc<RefCell<Vec<PathBuf>>>,
}

impl Env {
    fn new() -> Env {
        let apps = tempfile::tempdir().unwrap();
        let bundle = write_app(apps.path(), DEV, "v0.2.0", "0.2.0");
        Env {
            server: FakeServer::start(),
            key: TestKey::generate(),
            data: tempfile::tempdir().unwrap(),
            _apps: apps,
            bundle,
            reopened: Rc::default(),
        }
    }

    /// The manifest offers `version` with `build` as its artifact, served
    /// the way `serve` says.
    fn publish(&self, version: &str, build: &Build, serve: impl FnOnce(Vec<u8>) -> Serve) {
        let target = Target::current().unwrap().key();
        let manifest = serde_json::json!({
            "version": version,
            "notes": "合成的测试版本",
            "pub_date": "2026-11-08T00:00:00Z",
            "platforms": { target: { "signature": build.signature, "url": self.server.url(ARTIFACT) } }
        });
        self.server
            .serve(MANIFEST, Serve::Bytes(manifest.to_string().into_bytes()));
        self.server.serve(ARTIFACT, serve(build.archive.clone()));
    }

    fn service(&self, current: &str, manifest_url: String, schedule: Schedule) -> Service {
        let config = UpdaterConfig {
            manifest_url,
            public_key: self.key.public_key(),
            current_version: v(current),
            target: Target::current().unwrap(),
            url_policy: UrlPolicy::AllowLocal,
            bundle_id: DEV.into(),
        };
        let fetch = UpdateFetch::new(
            UrlPolicy::AllowLocal,
            "Drifting test",
            Duration::from_millis(500),
        )
        .unwrap();
        let reopened = self.reopened.clone();
        Service {
            updater: Ok(Arc::new(Updater::new(config, fetch).unwrap())),
            downloads: Some(Downloads::in_data(self.data.path())),
            current: v(current),
            install: Install::Bundle {
                bundle: self.bundle.clone(),
                relaunch: Rc::new(move |bundle: &Path| {
                    reopened.borrow_mut().push(bundle.to_owned());
                    Ok(())
                }),
            },
            schedule,
        }
    }

    fn installed_marker(&self) -> String {
        std::fs::read_to_string(self.bundle.join("Contents/MacOS/drifting")).unwrap()
    }

    /// Files in `<data>/updates`.
    fn kept(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(self.data.path().join("updates"))
            .map(|dir| {
                dir.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }
}

const MANUAL: Schedule = Schedule {
    first: None,
    every: Duration::from_secs(3 * 60 * 60),
};

fn start(cx: &mut TestAppContext, service: Service) -> &mut VisualTestContext {
    // The stand-in server answers on threads of its own.
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(info(), Services::default(), SettingsFile::in_memory(), cx);
        dr_view_update::init(service, cx);
    });
    let (_, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    cx
}

fn check(cx: &mut VisualTestContext) {
    cx.update(|_, cx| Updates::check(cx));
    cx.run_until_parked();
}

fn status(cx: &mut VisualTestContext) -> Status {
    cx.update(|_, cx| Updates::status(cx))
}

fn words(cx: &mut VisualTestContext) -> String {
    cx.update(|_, cx| {
        dr_view_update::status_words(&Updates::status(cx), cx)
            .map(|w| w.to_string())
            .unwrap_or_default()
    })
}

fn notices(cx: &mut VisualTestContext) -> Vec<Notice> {
    cx.update(|_, cx| {
        Notifications::items(cx)
            .iter()
            .filter(|n| n.source == Source::Update)
            .cloned()
            .collect()
    })
}

fn say(cx: &mut VisualTestContext, f: impl FnOnce(&App) -> gpui::SharedString) -> String {
    cx.update(|_, cx| f(cx).to_string())
}

#[gpui::test]
fn a_newer_version_is_offered_and_restart_installs_and_reopens(cx: &mut TestAppContext) {
    let env = Env::new();
    env.publish(
        "0.2.1",
        &build(&env.key, "0.2.1", "0.2.1", false),
        Serve::Bytes,
    );
    let cx = start(cx, env.service("0.2.0", env.server.url(MANIFEST), MANUAL));
    assert_eq!(status(cx), Status::Idle);

    check(cx);
    assert_eq!(status(cx), Status::Ready(v("0.2.1")));
    // The diagnostic summary carries the phase and version, as 0.1's did.
    let snapshot = cx.update(|_, cx| dr_view_update::snapshot(cx));
    assert_eq!(
        (
            snapshot.phase.as_str(),
            snapshot.candidate_version.as_deref()
        ),
        ("ready", Some("0.2.1"))
    );
    assert_eq!(
        words(cx),
        say(cx, |cx| tf(
            cx,
            keys::settings::update::READY_ON_QUIT,
            &[("version", &"0.2.1")]
        ))
    );
    assert_eq!(env.kept(), ["Drifting_0.2.1_aarch64.app.tar.gz"]);
    let offered = notices(cx);
    assert_eq!(offered.len(), 1);
    assert_eq!(
        offered[0].text.to_string(),
        say(cx, |cx| tf(
            cx,
            keys::notifications::app_update::AVAILABLE,
            &[("version", &"0.2.1")]
        ))
    );
    let action = offered[0].action.clone().expect("a 重启以更新 button");
    assert_eq!(
        action.label.to_string(),
        say(cx, |cx| t(cx, keys::settings::update::RESTART))
    );

    // Nothing is installed before the author quits.
    assert_eq!(env.installed_marker(), "v0.2.0");
    let id = offered[0].id;
    cx.update(|window, cx| (action.run)(id, window, cx));
    cx.run_until_parked();
    assert_eq!(env.installed_marker(), "v0.2.1");
    assert_eq!(*env.reopened.borrow(), std::slice::from_ref(&env.bundle));
    assert_eq!(env.kept(), ["installed.json"]);

    // The new version starts and says so, once.
    cx.update(|_, cx| {
        dr_view_update::init(env.service("0.2.1", env.server.url(MANIFEST), MANUAL), cx)
    });
    let after: Vec<_> = notices(cx)
        .into_iter()
        .map(|n| n.text.to_string())
        .collect();
    assert_eq!(
        after[0],
        say(cx, |cx| tf(
            cx,
            keys::notifications::app_update::INSTALLED,
            &[("version", &"0.2.1")]
        ))
    );
    assert!(env.kept().is_empty());
}

#[gpui::test]
fn the_first_check_runs_after_launch_then_every_three_hours(cx: &mut TestAppContext) {
    let env = Env::new();
    env.publish(
        "0.2.0",
        &build(&env.key, "0.2.0", "0.2.0", false),
        Serve::Bytes,
    );
    let schedule = Schedule {
        first: Some(dr_view_update::FIRST_CHECK),
        every: dr_platform::update::CHECK_INTERVAL,
    };
    let cx = start(cx, env.service("0.2.0", env.server.url(MANIFEST), schedule));
    assert_eq!(env.server.requests(), 0, "nothing at launch itself");
    cx.executor().advance_clock(dr_view_update::FIRST_CHECK);
    cx.run_until_parked();
    assert_eq!(env.server.requests(), 1);
    assert_eq!(status(cx), Status::UpToDate);
    assert_eq!(
        words(cx),
        say(cx, |cx| t(cx, keys::settings::update::NO_UPDATE))
    );

    // A failed automatic check is said in Settings only.
    env.server.serve(MANIFEST, Serve::Status(503));
    cx.executor()
        .advance_clock(dr_platform::update::CHECK_INTERVAL);
    cx.run_until_parked();
    assert_eq!(env.server.requests(), 2);
    assert_eq!(status(cx), Status::Failed(Problem::Server));
    assert!(notices(cx).is_empty());

    // The next one finds a newer version and gets it.
    env.publish(
        "0.2.1",
        &build(&env.key, "0.2.1", "0.2.1", false),
        Serve::Bytes,
    );
    cx.executor()
        .advance_clock(dr_platform::update::CHECK_INTERVAL);
    cx.run_until_parked();
    assert_eq!(status(cx), Status::Ready(v("0.2.1")));

    // An ordinary quit installs it, and reopens nothing.
    cx.update(|_, cx| dr_shell::quit::request(cx));
    cx.run_until_parked();
    assert_eq!(env.installed_marker(), "v0.2.1");
    assert!(env.reopened.borrow().is_empty());
}

#[gpui::test]
fn a_waiting_update_is_not_downloaded_again_after_a_relaunch(cx: &mut TestAppContext) {
    let env = Env::new();
    env.publish(
        "0.2.1",
        &build(&env.key, "0.2.1", "0.2.1", false),
        Serve::Bytes,
    );
    let cx = start(cx, env.service("0.2.0", env.server.url(MANIFEST), MANUAL));
    check(cx);
    assert_eq!(status(cx), Status::Ready(v("0.2.1")));
    assert_eq!(env.server.requests(), 2, "the manifest and the artifact");

    // Relaunched without installing (a crash, a system quit): the verified
    // file is kept; the next check offers it again without fetching it.
    cx.update(|_, cx| {
        dr_view_update::init(env.service("0.2.0", env.server.url(MANIFEST), MANUAL), cx)
    });
    assert_eq!(env.kept(), ["Drifting_0.2.1_aarch64.app.tar.gz"]);
    check(cx);
    assert_eq!(status(cx), Status::Ready(v("0.2.1")));
    assert_eq!(env.server.requests(), 3, "only the manifest");
}

#[gpui::test]
fn a_bad_signature_is_refused_said_and_not_kept(cx: &mut TestAppContext) {
    let env = Env::new();
    env.publish(
        "0.2.1",
        &build(&env.key, "0.2.1", "0.2.1", true),
        Serve::Bytes,
    );
    let cx = start(cx, env.service("0.2.0", env.server.url(MANIFEST), MANUAL));
    check(cx);
    assert_eq!(status(cx), Status::Failed(Problem::Signature));
    let refused = say(cx, |cx| t(cx, keys::settings::update::REFUSED_SIGNATURE));
    assert_eq!(words(cx), refused);
    assert!(env.kept().is_empty());
    let said: Vec<_> = notices(cx)
        .into_iter()
        .map(|n| (n.text.to_string(), n.action.is_some()))
        .collect();
    assert_eq!(said, [(refused.clone(), false)]);

    // Checking again refuses again, and says it once.
    check(cx);
    assert_eq!(notices(cx).len(), 1);

    // Nothing waits, so quitting installs nothing.
    cx.update(|_, cx| dr_shell::quit::request(cx));
    cx.run_until_parked();
    assert_eq!(env.installed_marker(), "v0.2.0");
}

#[gpui::test]
fn an_older_release_offered_as_newer_is_refused(cx: &mut TestAppContext) {
    let env = Env::new();
    // Signed as the 0.1.9 release file, offered as 0.2.1.
    env.publish(
        "0.2.1",
        &build(&env.key, "0.1.9", "0.1.9", false),
        Serve::Bytes,
    );
    let cx = start(cx, env.service("0.2.0", env.server.url(MANIFEST), MANUAL));
    check(cx);
    assert_eq!(status(cx), Status::Failed(Problem::Version));
    let refused = say(cx, |cx| t(cx, keys::settings::update::REFUSED_VERSION));
    assert_eq!(words(cx), refused);
    assert!(env.kept().is_empty());
    assert_eq!(notices(cx)[0].text.as_ref(), refused);
}

#[gpui::test]
fn an_offer_older_than_this_version_is_not_downloaded(cx: &mut TestAppContext) {
    let env = Env::new();
    env.publish(
        "0.1.9",
        &build(&env.key, "0.1.9", "0.1.9", false),
        Serve::Bytes,
    );
    let cx = start(cx, env.service("0.2.0", env.server.url(MANIFEST), MANUAL));
    check(cx);
    assert_eq!(status(cx), Status::OlderOffered(v("0.1.9")));
    assert_eq!(env.server.requests(), 1, "the artifact is never asked for");
    assert_eq!(
        words(cx),
        say(cx, |cx| tf(
            cx,
            keys::settings::update::OLDER_OFFERED,
            &[("version", &"0.1.9")]
        ))
    );
    assert!(words(cx).contains("0.1.9"));
    assert!(env.kept().is_empty());
    assert!(notices(cx).is_empty());
}

#[gpui::test]
fn a_download_cut_short_is_dropped_and_fetched_again_next_time(cx: &mut TestAppContext) {
    let env = Env::new();
    let good = build(&env.key, "0.2.1", "0.2.1", false);
    let half = good.archive.len() / 2;
    env.publish("0.2.1", &good, |body| Serve::CutShort { body, sent: half });
    let cx = start(cx, env.service("0.2.0", env.server.url(MANIFEST), MANUAL));
    check(cx);
    assert_eq!(status(cx), Status::Failed(Problem::Interrupted));
    assert_eq!(
        words(cx),
        say(cx, |cx| t(cx, keys::settings::update::INTERRUPTED))
    );
    assert!(env.kept().is_empty(), "no partial file is kept");
    assert!(notices(cx).is_empty(), "retrying fixes it; no notice");

    // A stalled download is the same.
    env.publish("0.2.1", &good, |body| Serve::Stall {
        body,
        sent: half,
        quiet: Duration::from_secs(3),
    });
    check(cx);
    assert_eq!(status(cx), Status::Failed(Problem::Interrupted));
    assert!(env.kept().is_empty());

    env.publish("0.2.1", &good, Serve::Bytes);
    check(cx);
    assert_eq!(status(cx), Status::Ready(v("0.2.1")));
}

#[gpui::test]
fn no_connection_is_said_in_settings(cx: &mut TestAppContext) {
    let env = Env::new();
    let cx = start(
        cx,
        env.service("0.2.0", format!("{}{MANIFEST}", refused_base()), MANUAL),
    );
    check(cx);
    assert_eq!(status(cx), Status::Failed(Problem::Offline));
    let snapshot = cx.update(|_, cx| dr_view_update::snapshot(cx));
    assert_eq!(
        (snapshot.phase.as_str(), snapshot.has_error),
        ("error", true)
    );
    assert_eq!(
        words(cx),
        say(cx, |cx| t(cx, keys::settings::update::CHECK_FAILED))
    );
    assert!(notices(cx).is_empty());
}

#[gpui::test]
fn a_bundle_of_another_version_is_not_installed_and_the_next_launch_says_so(
    cx: &mut TestAppContext,
) {
    let env = Env::new();
    // Signed as the 0.2.1 file, but the bundle inside is 0.2.0's.
    env.publish(
        "0.2.1",
        &build(&env.key, "0.2.0", "0.2.1", false),
        Serve::Bytes,
    );
    let cx = start(cx, env.service("0.2.0", env.server.url(MANIFEST), MANUAL));
    check(cx);
    assert_eq!(status(cx), Status::Ready(v("0.2.1")));
    cx.update(|_, cx| Updates::restart(cx));
    cx.run_until_parked();
    assert_eq!(env.installed_marker(), "v0.2.0", "left as it was");
    // The author asked to restart: the app reopens, still the old version.
    assert_eq!(env.reopened.borrow().len(), 1);

    cx.update(|_, cx| {
        dr_view_update::init(env.service("0.2.0", env.server.url(MANIFEST), MANUAL), cx)
    });
    assert_eq!(
        notices(cx)[0].text.to_string(),
        say(cx, |cx| tf(
            cx,
            keys::settings::update::INSTALL_FAILED,
            &[("version", &"0.2.1")]
        ))
    );
}

/// Settings › 关于 draws the row from M42's hook, whatever the state.
#[gpui::test]
fn settings_draws_the_update_row(cx: &mut TestAppContext) {
    let env = Env::new();
    env.publish(
        "0.2.1",
        &build(&env.key, "0.2.1", "0.2.1", false),
        Serve::Bytes,
    );
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(info(), Services::default(), SettingsFile::in_memory(), cx);
        dr_view_update::init(env.service("0.2.0", env.server.url(MANIFEST), MANUAL), cx);
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    view.update_in(cx, |ws, window, cx| ws.open_settings(window, cx));
    cx.run_until_parked();
    assert!(view.read_with(cx, |ws, _| ws.settings.is_some()));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    check(cx);
    assert_eq!(status(cx), Status::Ready(v("0.2.1")));
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

#[gpui::test]
fn a_build_without_updates_says_so_and_offers_no_button(cx: &mut TestAppContext) {
    let env = Env::new();
    let mut service = env.service("0.2.0", env.server.url(MANIFEST), MANUAL);
    service.updater = Err("development builds update only from a local test manifest".into());
    let cx = start(cx, service);
    check(cx);
    assert_eq!(status(cx), Status::Unavailable);
    assert_eq!(env.server.requests(), 0);
    assert_eq!(
        words(cx),
        say(cx, |cx| t(cx, keys::settings::update::UNAVAILABLE))
    );
}
