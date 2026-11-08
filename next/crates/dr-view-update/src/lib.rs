//! dr-view-update: automatic updates (module M42), over F7's
//! `dr_platform::update`.
//!
//! - **When**: [`FIRST_CHECK`] after launch, then every three hours while
//!   the app stays open (`update::CHECK_INTERVAL`, the 0.1 client's), and
//!   whenever the author clicks 检查更新 in Settings › 关于.
//! - **A newer version** is downloaded at once, in the background, into
//!   `<data>/updates`, and verified: the minisign signature with the
//!   updater key, and that the signed file is the offered version. Then the
//!   notification center says 「Drifting x 可以更新」 with a 「重启以更新」
//!   button, and the Settings row says it installs when the app quits.
//! - **Installing** happens as the app quits, after the library has saved
//!   (a `dr_shell::quit::before_quit` hook registered after the others):
//!   macOS swaps the bundle in place, Windows starts the installer.
//!   「重启以更新」 quits that way and reopens the new version. A quit the
//!   system starts (logging out) skips the hooks; the next quit installs.
//! - **Refused**, with nothing kept: a bad signature or another key's; a
//!   signature or a bundle of another version (an older release offered as
//!   newer); another app; a download that broke off or stalled; no
//!   connection. An offer of the running version or an older one is never
//!   downloaded. The Settings row says every outcome in plain words; the
//!   notification center also gets the refusals that mean the file was
//!   wrong (retrying will not fix them), once per version and launch. A
//!   failed automatic check stays out of the notification center, as in
//!   0.1, and is tried again at the next one.
//! - **Afterwards** the new version says 「已更新到 Drifting x」 once; an
//!   install that failed at quit (the app's folder not writable) is said at
//!   the next launch.
//!
//! The app calls [`init`] after `dr_shell::init` and the other views, so
//! the quit hook runs last. docs/rust-rewrite/modules/m42-update.md has the
//! decisions.

use std::collections::HashSet;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use dr_i18n::{Key, keys};
use dr_platform::Identity;
use dr_platform::diagnostics::UpdateSnapshot;
use dr_platform::update::{
    self, Available, Downloaded, Downloads, InstallerLaunch, Offer, Problem, UpdateError,
    UpdateFetch, Updater, UpdaterConfig,
};
use dr_shell::notifications::{NoticeAction, Notifications, Source};
use dr_shell::settings::UpdatesRow;
use dr_shell::strings::{t, tf};
use dr_ui::components::Button;
use gpui::{App, AsyncApp, Global, IntoElement as _, SharedString, Window};
use semver::Version;

/// How long after launch the first check runs: after the window, the
/// library and the crash follow-up, off the launch path.
pub const FIRST_CHECK: Duration = Duration::from_secs(10);

/// How often a download's progress reaches the Settings row.
const TICK: Duration = Duration::from_millis(200);

/// Reopens the app from `bundle` once this process has exited
/// (`dr_platform::relaunch::after_exit`).
pub type Relaunch = Rc<dyn Fn(&Path) -> io::Result<()>>;
/// Starts the Windows installer (`InstallerLaunch::spawn`).
pub type SpawnInstaller = Rc<dyn Fn(&InstallerLaunch) -> io::Result<()>>;

/// How this process puts an update in place.
pub enum Install {
    /// macOS: swap `bundle` as the app quits; reopen it with `relaunch`.
    Bundle { bundle: PathBuf, relaunch: Relaunch },
    /// Windows: start the downloaded installer as the app quits; with
    /// 「重启以更新」 it reopens the app with `relaunch_args`.
    Installer {
        spawn: SpawnInstaller,
        relaunch_args: Vec<OsString>,
    },
    /// Not running from an app bundle (`cargo run`): download and verify,
    /// never install.
    Nowhere,
}

impl Install {
    pub fn for_this_process() -> Install {
        #[cfg(target_os = "macos")]
        {
            match update::running_bundle() {
                Some(bundle) => Install::Bundle {
                    bundle,
                    relaunch: Rc::new(dr_platform::relaunch::after_exit),
                },
                None => Install::Nowhere,
            }
        }
        #[cfg(windows)]
        {
            Install::Installer {
                spawn: Rc::new(InstallerLaunch::spawn),
                relaunch_args: Vec::new(),
            }
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            Install::Nowhere
        }
    }
}

/// When automatic checks run. `first: None` leaves only manual checks
/// (tests).
#[derive(Clone, Copy, Debug)]
pub struct Schedule {
    pub first: Option<Duration>,
    pub every: Duration,
}

impl Default for Schedule {
    fn default() -> Self {
        Schedule {
            first: Some(FIRST_CHECK),
            every: update::CHECK_INTERVAL,
        }
    }
}

/// What the updater works with.
pub struct Service {
    /// The updater, or why this build has none (no key, no test manifest).
    pub updater: Result<Arc<Updater<UpdateFetch>>, String>,
    /// `<data>/updates`; without it nothing is downloaded.
    pub downloads: Option<Downloads>,
    pub current: Version,
    pub install: Install,
    pub schedule: Schedule,
}

impl Service {
    /// This build: F7's `UpdaterConfig::for_build` (release builds need the
    /// compiled-in key; development builds a test manifest and key in their
    /// environment), downloads under the data folder, installs into the
    /// running bundle.
    pub fn for_build(identity: &Identity, data: Option<&Path>, version: &str) -> Service {
        let current = Version::parse(version).unwrap_or_else(|_| Version::new(0, 0, 0));
        let updater = UpdaterConfig::for_build(identity, version)
            .and_then(|config| {
                let fetch = UpdateFetch::new(
                    config.url_policy,
                    &format!("Drifting/{version}"),
                    update::fetch::STALL_TIMEOUT,
                )?;
                Updater::new(config, fetch)
            })
            .map(Arc::new)
            .map_err(|error| error.to_string());
        if let Err(reason) = &updater {
            log::info!("updates: off in this build ({reason})");
        }
        Service {
            updater,
            downloads: data.map(Downloads::in_data),
            current,
            install: Install::for_this_process(),
            schedule: Schedule::default(),
        }
    }
}

/// What the Settings row shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    /// This build cannot update.
    Unavailable,
    /// Nothing checked yet this launch.
    Idle,
    Checking,
    UpToDate,
    /// The service offers an older version than this one; not installed.
    OlderOffered(Version),
    Downloading {
        version: Version,
        received: u64,
        total: Option<u64>,
    },
    /// Downloaded and verified; installs as the app quits.
    Ready(Version),
    Failed(Problem),
}

/// The verified download waiting for the quit, and its notice.
struct Waiting {
    update: Downloaded,
    notice: Option<u64>,
}

pub struct Updates {
    service: Service,
    status: Status,
    waiting: Option<Waiting>,
    /// A check (and its download) is running.
    busy: bool,
    /// 「重启以更新」 asked for the app to reopen after installing.
    relaunch: bool,
    /// Refusals already in the notification center this launch.
    told: HashSet<(Version, Problem)>,
}

impl Global for Updates {}

impl Updates {
    pub fn status(cx: &App) -> Status {
        cx.try_global::<Updates>()
            .map_or(Status::Unavailable, |u| u.status.clone())
    }

    /// The verified version waiting for the quit.
    pub fn waiting(cx: &App) -> Option<Version> {
        let updates = cx.try_global::<Updates>()?;
        Some(updates.waiting.as_ref()?.update.version.clone())
    }

    /// 检查更新: checks now (unless a check is running) and says the
    /// outcome in the Settings row, whatever it is.
    pub fn check(cx: &mut App) {
        run_check(true, cx);
    }

    /// 「重启以更新」: quits through the ordinary quit flow, which saves,
    /// installs the waiting update and reopens the app.
    pub fn restart(cx: &mut App) {
        if let Some(updates) = updates_mut(cx) {
            updates.relaunch = true;
        }
        dr_shell::quit::request(cx);
    }
}

/// Installs the updater: tidies the updates folder, says what the last quit
/// installed (or could not), adds the Settings row and the quit hook, and
/// schedules the checks.
pub fn init(service: Service, cx: &mut App) {
    if let Some(downloads) = &service.downloads {
        downloads.clean(&service.current);
        if let Some(installed) = downloads.take_installed(&service.current) {
            let text = tf(
                cx,
                keys::notifications::app_update::INSTALLED,
                &[("version", &installed.version)],
            );
            Notifications::post(Source::Update, text, cx);
        }
        if let Some(failure) = downloads.take_failure(&service.current) {
            let key = if failure.problem == Problem::NeedsAdmin {
                keys::settings::update::INSTALL_FAILED_ADMIN
            } else {
                keys::settings::update::INSTALL_FAILED
            };
            let text = tf(cx, key, &[("version", &failure.version)]);
            Notifications::post(Source::Update, text, cx);
        }
    }
    let status = if service.updater.is_ok() {
        Status::Idle
    } else {
        Status::Unavailable
    };
    let schedule = service.schedule;
    let available = service.updater.is_ok();
    cx.set_global(Updates {
        service,
        status,
        waiting: None,
        busy: false,
        relaunch: false,
        told: HashSet::new(),
    });
    dr_shell::settings::set_updates_row(cx, row);
    dr_shell::quit::before_quit(cx, install_on_quit);
    if let (true, Some(first)) = (available, schedule.first) {
        cx.spawn(async move |cx| {
            let mut wait = first;
            loop {
                cx.background_executor().timer(wait).await;
                cx.update(|cx| run_check(false, cx));
                wait = schedule.every;
            }
        })
        .detach();
    }
}

fn updates_mut(cx: &mut App) -> Option<&mut Updates> {
    if cx.has_global::<Updates>() {
        Some(cx.global_mut::<Updates>())
    } else {
        None
    }
}

fn set_status(status: Status, cx: &mut App) {
    if let Some(updates) = updates_mut(cx) {
        updates.status = status;
    }
    cx.refresh_windows();
}

fn run_check(manual: bool, cx: &mut App) {
    let Some(updates) = cx.try_global::<Updates>() else {
        return;
    };
    if updates.busy {
        return;
    }
    let Ok(updater) = updates.service.updater.clone() else {
        return;
    };
    let waiting = updates.waiting.as_ref().map(|w| w.update.version.clone());
    let directory = updates
        .service
        .downloads
        .as_ref()
        .map(|d| d.dir().to_path_buf());
    // An automatic check while an update waits keeps showing it: the
    // 「重启以更新」 button never flickers away.
    let quiet = !manual && waiting.is_some();
    cx.global_mut::<Updates>().busy = true;
    if !quiet {
        set_status(Status::Checking, cx);
    }
    cx.spawn(async move |cx| {
        let outcome = checking(updater, waiting, directory, cx).await;
        cx.update(|cx| settle(outcome, manual, cx));
    })
    .detach();
}

/// What one check came to.
enum Outcome {
    /// The version waiting already is the newest.
    StillWaiting,
    Current,
    Older(Version),
    Downloaded(Downloaded),
    /// `version`: the update that was refused, when it got that far.
    Failed {
        problem: Problem,
        version: Option<Version>,
    },
}

async fn checking(
    updater: Arc<Updater<UpdateFetch>>,
    waiting: Option<Version>,
    directory: Option<PathBuf>,
    cx: &mut AsyncApp,
) -> Outcome {
    let started = Instant::now();
    let reading = updater.clone();
    let offer = cx
        .background_executor()
        .spawn(async move { reading.check() })
        .await;
    let available: Available = match offer {
        Ok(Offer::Newer(available)) if waiting.as_ref() == Some(&available.version) => {
            return Outcome::StillWaiting;
        }
        Ok(Offer::Newer(available)) => available,
        Ok(Offer::Current) => return Outcome::Current,
        Ok(Offer::Older(version)) => {
            log::warn!("updates: the manifest offers {version}, older than this one; ignored");
            return Outcome::Older(version);
        }
        Err(error) => {
            log::info!(
                "updates: the check failed after {:.0} ms: {error}",
                started.elapsed().as_secs_f64() * 1000.0
            );
            return failed(&error, None);
        }
    };
    let Some(directory) = directory else {
        return Outcome::Failed {
            problem: Problem::Local,
            version: Some(available.version),
        };
    };
    let version = available.version.clone();
    cx.update(|cx| {
        set_status(
            Status::Downloading {
                version: version.clone(),
                received: 0,
                total: None,
            },
            cx,
        )
    });
    // The download thread writes its progress here; a ticker on the main
    // thread copies it to the row.
    let progress = Arc::new((AtomicU64::new(0), AtomicU64::new(0)));
    let ticker = {
        let progress = progress.clone();
        let version = version.clone();
        cx.spawn(async move |cx| {
            loop {
                cx.background_executor().timer(TICK).await;
                let downloading = cx.update(|cx| {
                    let busy = matches!(Updates::status(cx), Status::Downloading { .. });
                    if busy {
                        let total = progress.1.load(Ordering::Relaxed);
                        set_status(
                            Status::Downloading {
                                version: version.clone(),
                                received: progress.0.load(Ordering::Relaxed),
                                total: (total > 0).then_some(total),
                            },
                            cx,
                        );
                    }
                    busy
                });
                if !downloading {
                    break;
                }
            }
        })
    };
    let result = cx
        .background_executor()
        .spawn(async move {
            updater.download(&available, &directory, &mut |p| {
                progress.0.store(p.received, Ordering::Relaxed);
                progress.1.store(p.total.unwrap_or(0), Ordering::Relaxed);
            })
        })
        .await;
    drop(ticker);
    match result {
        Ok(downloaded) => {
            log::info!(
                "updates: {} downloaded and verified in {:.1} s",
                downloaded.version,
                started.elapsed().as_secs_f64()
            );
            Outcome::Downloaded(downloaded)
        }
        Err(error) => {
            log::warn!("updates: {version} refused: {error}");
            failed(&error, Some(version))
        }
    }
}

fn failed(error: &UpdateError, version: Option<Version>) -> Outcome {
    Outcome::Failed {
        problem: error.problem(),
        version,
    }
}

/// Refusals that mean the file itself was wrong: they go to the
/// notification center too.
fn is_refusal(problem: Problem) -> bool {
    matches!(
        problem,
        Problem::Signature | Problem::Version | Problem::WrongApp
    )
}

fn settle(outcome: Outcome, manual: bool, cx: &mut App) {
    let Some(updates) = updates_mut(cx) else {
        return;
    };
    updates.busy = false;
    let waiting = updates.waiting.as_ref().map(|w| w.update.version.clone());
    let status = match outcome {
        Outcome::StillWaiting => {
            Status::Ready(waiting.clone().unwrap_or_else(|| Version::new(0, 0, 0)))
        }
        Outcome::Current => Status::UpToDate,
        Outcome::Older(version) => Status::OlderOffered(version),
        Outcome::Downloaded(update) => {
            let version = update.version.clone();
            make_waiting(update, cx);
            Status::Ready(version)
        }
        Outcome::Failed { problem, version } => {
            if is_refusal(problem)
                && let Some(version) = version
                && cx
                    .global_mut::<Updates>()
                    .told
                    .insert((version.clone(), problem))
            {
                let text = t(cx, refusal_words(problem));
                Notifications::post(Source::Update, text, cx);
            }
            Status::Failed(problem)
        }
    };
    // A failed or empty automatic check leaves a waiting update in view.
    let status = match (&waiting, &status, manual) {
        (Some(version), Status::Failed(_) | Status::UpToDate | Status::OlderOffered(_), false) => {
            Status::Ready(version.clone())
        }
        _ => status,
    };
    set_status(status, cx);
}

/// The download is the update the next quit installs: older waiting files
/// go, and the notification center offers 「重启以更新」.
fn make_waiting(update: Downloaded, cx: &mut App) {
    let version = update.version.clone();
    let previous = cx.global_mut::<Updates>().waiting.take();
    if let Some(notice) = previous.and_then(|w| w.notice) {
        Notifications::remove(notice, cx);
    }
    if let Some(downloads) = &cx.global::<Updates>().service.downloads {
        downloads.keep_only(&update.path);
    }
    let text = tf(
        cx,
        keys::notifications::app_update::AVAILABLE,
        &[("version", &version)],
    );
    let label = t(cx, keys::settings::update::RESTART);
    let notice = Notifications::post_with(
        Source::Update,
        text,
        NoticeAction {
            label,
            run: Rc::new(|_, _, cx| Updates::restart(cx)),
        },
        cx,
    );
    cx.global_mut::<Updates>().waiting = Some(Waiting {
        update,
        notice: Some(notice),
    });
}

/// The quit hook: installs the waiting update, then (after 「重启以更新」)
/// reopens the app. Runs after the library's own hook has saved.
pub fn install_on_quit(cx: &mut App) {
    let Some(updates) = updates_mut(cx) else {
        return;
    };
    let Some(waiting) = updates.waiting.take() else {
        return;
    };
    let relaunch = updates.relaunch;
    let update = waiting.update;
    let downloads = updates.service.downloads.clone();
    let started = Instant::now();
    let installed: Result<(), Problem> = match &updates.service.install {
        Install::Bundle {
            bundle,
            relaunch: reopen,
        } => {
            let result = update.replace_bundle(bundle).map_err(|error| {
                log::error!("updates: {} not installed: {error}", update.version);
                error.problem()
            });
            if relaunch && let Err(error) = reopen(bundle.as_path()) {
                log::error!("updates: could not reopen {}: {error}", bundle.display());
            }
            result
        }
        Install::Installer {
            spawn,
            relaunch_args,
        } => {
            let mut launch = update.installer_launch(relaunch_args);
            if !relaunch {
                launch = launch.without_relaunch();
            }
            spawn(&launch).map_err(|error| {
                log::error!("updates: the installer did not start: {error}");
                Problem::Local
            })
        }
        Install::Nowhere => {
            log::info!(
                "updates: {} downloaded but not installed: not running from an app bundle",
                update.version
            );
            return;
        }
    };
    if let Some(downloads) = downloads {
        let noted = match installed {
            Ok(()) => downloads.record_installed(&update),
            Err(problem) => downloads.record_failure(&update.version, problem),
        };
        if let Err(error) = noted {
            log::warn!("updates: could not leave a note for the next launch: {error}");
        }
    }
    if installed.is_ok() {
        log::info!(
            "updates: {} put in place in {:.0} ms",
            update.version,
            started.elapsed().as_secs_f64() * 1000.0
        );
    }
}

/// The update service's state for the diagnostic summary, in the 0.1
/// client's phases (`idle`, `checking`, `downloading`, `ready`, `error`):
/// a version and byte counts, never an error's text.
pub fn snapshot(cx: &App) -> UpdateSnapshot {
    let mut snapshot = UpdateSnapshot::idle();
    match Updates::status(cx) {
        Status::Unavailable | Status::Idle | Status::UpToDate | Status::OlderOffered(_) => {}
        Status::Checking => snapshot.phase = "checking".into(),
        Status::Downloading {
            version,
            received,
            total,
        } => {
            snapshot.phase = "downloading".into();
            snapshot.candidate_version = Some(version.to_string());
            snapshot.downloaded_bytes = received;
            snapshot.total_bytes = total;
        }
        Status::Ready(version) => {
            snapshot.phase = "ready".into();
            snapshot.candidate_version = Some(version.to_string());
        }
        Status::Failed(_) => {
            snapshot.phase = "error".into();
            snapshot.has_error = true;
        }
    }
    snapshot
}

/// The words for a problem, in the row and the notification center.
fn refusal_words(problem: Problem) -> Key {
    use keys::settings::update as u;
    match problem {
        Problem::Unavailable => u::UNAVAILABLE,
        Problem::Offline => u::CHECK_FAILED,
        Problem::Server => u::SERVER_ERROR,
        Problem::Interrupted => u::INTERRUPTED,
        Problem::Signature => u::REFUSED_SIGNATURE,
        Problem::Version => u::REFUSED_VERSION,
        Problem::WrongApp => u::REFUSED_APP,
        Problem::NeedsAdmin | Problem::Local => u::LOCAL_ERROR,
    }
}

/// The words under 新版本 in Settings › 关于 for `status`.
pub fn status_words(status: &Status, cx: &App) -> Option<SharedString> {
    use keys::settings::update as u;
    Some(match status {
        Status::Idle => return None,
        Status::Unavailable => t(cx, u::UNAVAILABLE),
        Status::Checking => t(cx, u::CHECKING),
        Status::UpToDate => t(cx, u::NO_UPDATE),
        Status::OlderOffered(version) => tf(cx, u::OLDER_OFFERED, &[("version", version)]),
        Status::Downloading {
            received, total, ..
        } => match total {
            Some(total) if *total > 0 => {
                let percent = (received.saturating_mul(100) / total).min(100);
                tf(cx, u::DOWNLOADING_PROGRESS, &[("progress", &percent)])
            }
            _ => t(cx, u::DOWNLOADING),
        },
        Status::Ready(version) => tf(cx, u::READY_ON_QUIT, &[("version", version)]),
        Status::Failed(problem) => t(cx, refusal_words(*problem)),
    })
}

/// The Settings row: its words, and 检查更新 or 重启以更新.
fn row(_: &mut Window, cx: &mut App) -> UpdatesRow {
    let status = Updates::status(cx);
    let control = match status {
        Status::Unavailable | Status::Checking | Status::Downloading { .. } => None,
        Status::Ready(_) => Some(
            Button::new("update-restart", t(cx, keys::settings::update::RESTART))
                .small()
                .on_click(|_, _, cx| Updates::restart(cx))
                .into_any_element(),
        ),
        _ => Some(
            Button::new("update-check", t(cx, keys::settings::update::CHECK_ACTION))
                .small()
                .on_click(|_, _, cx| Updates::check(cx))
                .into_any_element(),
        ),
    };
    UpdatesRow {
        description: status_words(&status, cx),
        control,
    }
}
