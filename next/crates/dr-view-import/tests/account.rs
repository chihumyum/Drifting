//! Importing a 0.1 library while signed in (`m10-import.md`, "登录状态下导入"):
//! the import becomes the account's own library, only while the account has
//! nothing in the new format here or on the server, and syncs from there.
//! Everything runs against the loopback `FakeSyncServer` with a synthetic
//! token and the synthetic 0.1 library of dr-import-v1's tests.
#[path = "../../dr-import-v1/tests/common/mod.rs"]
mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use dr_account::{
    AccountService, HostedConfig, HostedOrigin, LibraryOwner, LibraryRegistry, SessionStatus,
    SessionTokenStore, account_library_id,
};
use dr_i18n::keys;
use dr_import_v1::gate::Accept;
use dr_import_v1::progress::Step;
use dr_import_v1::run::Cancel;
use dr_platform::SecretStore;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_sync::{FakeSyncServer, SyncEngine};
use dr_view_import::reimport::{AccountCheck, Destination, Refusal, ResultOfImport};
use dr_view_import::{LegacyImport, State};
use dr_workspace::Workspace as Library;
use gpui::{Entity, TestAppContext, VisualTestContext};

const VERSION: &str = "0.2.0-dev";
const TOKEN: &str = "synthetic-account-import-token";
/// `FakeSyncServer`'s signed-in user.
const SUBJECT: &str = "synthetic-sync-user-1";

/// One device signed in to the fake server's account: its data folder, its
/// account service and its open account library.
struct Device {
    data: tempfile::TempDir,
    account: Arc<AccountService>,
    ws: Library,
}

impl Device {
    fn signed_in(server: &FakeSyncServer) -> Device {
        let data = tempfile::tempdir().unwrap();
        let origin = HostedOrigin::parse(server.base_url()).unwrap();
        let secrets = Arc::new(SecretStore::in_memory());
        SessionTokenStore::new(Arc::clone(&secrets))
            .write(&origin, TOKEN)
            .unwrap();
        let account = Arc::new(
            AccountService::new(
                HostedConfig::with_origin(origin),
                data.path(),
                "drifting-next-dev",
                secrets,
            )
            .unwrap(),
        );
        let state = account.bootstrap();
        assert_eq!(state.status, SessionStatus::Connected);
        assert!(state.is_account_library);
        let ws = open(data.path(), &state.active_library_dir);
        Device { data, account, ws }
    }

    fn root(&self) -> PathBuf {
        self.ws.library().paths().root.clone()
    }

    fn check(&self, server: &FakeSyncServer) -> AccountCheck {
        AccountCheck {
            subject: SUBJECT.into(),
            base_url: server.base_url().into(),
            access_token: TOKEN.into(),
        }
    }
}

fn open(data: &Path, dir: &Path) -> Library {
    let mut opts = dr_workspace::library_options(VERSION);
    opts.device = Some(dr_store::Device::open(data).unwrap());
    let lib = dr_store::Library::open(dir, opts).unwrap();
    Library::open(lib, Default::default()).unwrap()
}

fn sync(ws: &Library, server: &FakeSyncServer) {
    let mut engine = SyncEngine::new(server.base_url(), ws.library()).unwrap();
    engine.sync_once(ws.library(), TOKEN).unwrap();
}

/// Every file under `root` with its digest, size and modification time.
fn files(root: &Path) -> BTreeMap<String, (String, u64, SystemTime)> {
    fn visit(root: &Path, path: &Path, out: &mut BTreeMap<String, (String, u64, SystemTime)>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(root, &path, out);
            } else {
                let meta = std::fs::metadata(&path).unwrap();
                out.insert(
                    path.strip_prefix(root).unwrap().display().to_string(),
                    (
                        common::sha256_bytes(&std::fs::read(&path).unwrap()),
                        meta.len(),
                        meta.modified().unwrap(),
                    ),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    visit(root, root, &mut out);
    out
}

/// What an import may have left in a data folder: targets, manifests,
/// pending pointers.
fn import_traces(data: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(data)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("reimport-"))
        .collect();
    out.sort();
    out
}

fn registry_bytes(data: &Path) -> Vec<u8> {
    std::fs::read(data.join(dr_account::LIBRARIES_FILE)).unwrap()
}

fn doc_values(ws: &Library) -> BTreeMap<String, serde_json::Value> {
    ws.library()
        .syncable_docs()
        .unwrap()
        .into_iter()
        .map(|d| {
            let value = ws.library().load_copy(&d.doc_id).unwrap().get_deep_value();
            (d.doc_id, serde_json::to_value(value).unwrap())
        })
        .collect()
}

fn prepare(device: &Device, old: &common::Old) -> Destination {
    let picked = dr_import_v1::locate::resolve(&old.root).unwrap();
    Destination::prepare(&device.root(), &picked).unwrap()
}

// The window.

/// The app takes the device's library (no other handle stays open: a swap
/// closes it) and its account service.
fn install(cx: &mut TestAppContext, ws: Library, account: Arc<AccountService>) {
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
                library: Some(ws),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_shell::Strings::install(dr_i18n::Locale::ZhCn, cx);
        cx.set_global(dr_view_account::Service::with_service(account));
        dr_view_shelf::init(cx);
        dr_view_import::init(cx);
    });
}

fn importer(cx: &mut VisualTestContext) -> Entity<LegacyImport> {
    cx.update(|_, cx| dr_view_import::importer(cx).unwrap())
}

fn state(cx: &mut VisualTestContext) -> State {
    importer(cx).read_with(cx, |i, _| i.state().clone())
}

fn settled(cx: &mut VisualTestContext) -> State {
    let until = Instant::now() + Duration::from_secs(60);
    loop {
        cx.run_until_parked();
        let now = state(cx);
        if !matches!(
            now,
            State::Running(_) | State::Switching(_) | State::Picking
        ) {
            return now;
        }
        assert!(Instant::now() < until, "timed out: {now:?}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn configure(cx: &mut VisualTestContext, source: &Path) {
    let i = importer(cx);
    let source = source.to_path_buf();
    cx.update(|w, cx| i.update(cx, |i, cx| i.start(source, w, cx)));
}

fn start(cx: &mut VisualTestContext) {
    let i = importer(cx);
    cx.update(|w, cx| i.update(cx, |i, cx| i.start_configured(w, cx)));
}

fn active(cx: &mut VisualTestContext) -> Library {
    cx.update(|_, cx| cx.global::<Services>().library.clone().unwrap())
}

fn zh(key: dr_i18n::Key) -> String {
    dr_i18n::I18n::new(dr_i18n::Locale::ZhCn, dr_i18n::Platform::Mac)
        .t(key)
        .to_owned()
}

#[gpui::test]
fn signed_in_the_import_becomes_the_accounts_library_and_a_second_device_syncs_it(
    cx: &mut TestAppContext,
) {
    let server = FakeSyncServer::start(TOKEN);
    let device = Device::signed_in(&server);
    let first = device.root();
    let data = device.data.path().to_path_buf();
    assert_eq!(
        first,
        data.join("libraries").join(account_library_id(SUBJECT))
    );
    let old = common::build_v3(true);
    let source_before = files(&old.root);
    let Device {
        data: _data,
        account,
        ws,
    } = device;
    install(cx, ws, account);
    let (_view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();

    configure(cx, &old.root);
    assert!(matches!(state(cx), State::Ready(_)), "{:?}", state(cx));
    let target = importer(cx).read_with(cx, |i, _| i.destination().unwrap().target());
    assert_eq!(target.parent(), Some(data.as_path()));
    start(cx);
    let State::Done(done) = settled(cx) else {
        panic!("{:?}", state(cx))
    };
    assert_eq!(done.books[0].status, "imported");

    // The account's own library is now the imported one: the entry keeps its
    // id and owner, the empty library it had stays on disk.
    let imported = active(cx);
    assert_eq!(imported.library().paths().root, target);
    let registry = LibraryRegistry::load_or_init(&data).unwrap();
    assert_eq!(registry.active_entry().id, account_library_id(SUBJECT));
    assert_eq!(
        registry.active_entry().owner,
        LibraryOwner::Account {
            subject: SUBJECT.into()
        }
    );
    assert_eq!(registry.active_library_dir(&data), target);
    assert!(
        registry
            .entries
            .iter()
            .all(|e| e.owner != LibraryOwner::Local || e.path == "library"),
        "no local library was added: {registry:?}"
    );
    assert!(first.is_dir());
    // The account state follows, so the sync supervisor connects to it.
    cx.update(|_, cx| {
        let svc = cx.global::<dr_view_account::Service>();
        assert_eq!(svc.state.active_library_dir, target);
        assert!(svc.state.is_account_library);
        assert_eq!(
            dr_view_account::shown_account_state(cx)
                .0
                .active_library_dir,
            target
        );
    });
    // Nothing went to the server while importing: only sync uploads.
    assert_eq!(server.stored_object_count(), 0);
    assert_eq!(
        files(&old.root),
        source_before,
        "the 0.1 library is untouched"
    );

    sync(&imported, &server);
    assert!(server.stored_object_count() > 0);
    let uploaded = doc_values(&imported);
    assert!(uploaded.contains_key(&format!("book:{}", common::BOOK)));

    // A second device signs in to the same account and gets every book by
    // syncing; importing there is refused and writes nothing.
    let second = Device::signed_in(&server);
    assert!(second.ws.library().docs(None, None).unwrap().is_empty());
    sync(&second.ws, &server);
    assert_eq!(doc_values(&second.ws), uploaded);
    let records = server.stored_object_count();
    let registry_before = registry_bytes(second.data.path());
    let job = prepare(&second, &old);
    let refused = dr_view_import::reimport::import_for(
        job,
        VERSION,
        Accept::NOTHING,
        Cancel::default(),
        Some(&second.check(&server)),
        &mut |_| {},
    )
    .unwrap();
    assert!(matches!(
        refused,
        ResultOfImport::Refused(Refusal::AccountHasBooks)
    ));
    assert!(import_traces(second.data.path()).is_empty());
    assert_eq!(registry_bytes(second.data.path()), registry_before);
    assert_eq!(server.stored_object_count(), records);
    assert_eq!(files(&old.root), source_before);
}

#[gpui::test]
fn the_dialog_refuses_an_account_that_has_books_here_or_on_the_server(cx: &mut TestAppContext) {
    let server = FakeSyncServer::start(TOKEN);
    // Another device already put a book into the account.
    let elsewhere = Device::signed_in(&server);
    dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap()
    .write_to(elsewhere.ws.library())
    .unwrap();
    sync(&elsewhere.ws, &server);
    let records = server.stored_object_count();
    assert!(records > 0);

    let device = Device::signed_in(&server);
    let data = device.data.path().to_path_buf();
    let original = device.root();
    let registry_before = registry_bytes(&data);
    let old = common::build_v3(true);
    let source_before = files(&old.root);
    let Device {
        data: _data,
        account,
        ws,
    } = device;
    install(cx, ws, account);
    let (_view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();

    // On the server only: asked when the import is about to write.
    configure(cx, &old.root);
    assert!(matches!(state(cx), State::Ready(_)));
    start(cx);
    let State::Failed(failed) = settled(cx) else {
        panic!("{:?}", state(cx))
    };
    assert_eq!(
        failed.message,
        zh(keys::import::v1::refused::ACCOUNT_HAS_BOOKS)
    );
    assert_eq!(failed.message, "这个账号已经有书了，直接同步就行。");
    assert!(import_traces(&data).is_empty());
    assert_eq!(registry_bytes(&data), registry_before);
    assert_eq!(active(cx).library().paths().root, original);
    assert!(active(cx).library().docs(None, None).unwrap().is_empty());

    // Here too (synced in): refused at once, before the import is even set up.
    let i = importer(cx);
    cx.update(|w, cx| i.update(cx, |i, cx| i.close(w, cx)));
    sync(&active(cx), &server);
    assert!(!active(cx).library().docs(None, None).unwrap().is_empty());
    configure(cx, &old.root);
    let State::Failed(failed) = state(cx) else {
        panic!("{:?}", state(cx))
    };
    assert_eq!(
        failed.message,
        zh(keys::import::v1::refused::ACCOUNT_HAS_BOOKS)
    );
    assert!(import_traces(&data).is_empty());
    assert_eq!(server.stored_object_count(), records);
    assert_eq!(files(&old.root), source_before);
}

#[gpui::test]
fn the_dialog_refuses_when_the_server_cannot_be_asked(cx: &mut TestAppContext) {
    let server = FakeSyncServer::start(TOKEN);
    let device = Device::signed_in(&server);
    let data = device.data.path().to_path_buf();
    let registry_before = registry_bytes(&data);
    let old = common::build_v3(true);
    let Device {
        data: _data,
        account,
        ws,
    } = device;
    install(cx, ws, account);
    let (_view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();

    let i = importer(cx);
    for (fault, key) in [
        ("offline", keys::settings::hosted::account_errors::GENERIC),
        (
            "expired",
            keys::settings::hosted::account_errors::UNAUTHORIZED,
        ),
        ("503", keys::settings::hosted::account_errors::GENERIC),
    ] {
        match fault {
            "offline" => server.set_offline(true),
            "expired" => server.set_expected_token("synthetic-rotated-token"),
            _ => server.set_forced_status_error(Some(503)),
        }
        configure(cx, &old.root);
        start(cx);
        let State::Failed(failed) = settled(cx) else {
            panic!("{fault}: {:?}", state(cx))
        };
        assert_eq!(failed.message, zh(key), "{fault}");
        assert!(import_traces(&data).is_empty(), "{fault}");
        assert_eq!(registry_bytes(&data), registry_before, "{fault}");
        cx.update(|w, cx| i.update(cx, |i, cx| i.close(w, cx)));
        server.set_offline(false);
        server.set_expected_token(TOKEN);
        server.set_forced_status_error(None);
    }
    assert_eq!(server.stored_object_count(), 0);
    assert!(active(cx).library().docs(None, None).unwrap().is_empty());
}

#[test]
fn without_the_accounts_session_nothing_is_asked_and_nothing_is_written() {
    let server = FakeSyncServer::start(TOKEN);
    let device = Device::signed_in(&server);
    let data = device.data.path().to_path_buf();
    let registry_before = registry_bytes(&data);
    let old = common::build_v3(true);
    let source_before = files(&old.root);
    let someone_else = AccountCheck {
        subject: "synthetic-other-user".into(),
        ..device.check(&server)
    };
    for check in [None, Some(&someone_else)] {
        let job = prepare(&device, &old);
        let result = dr_view_import::reimport::import_for(
            job,
            VERSION,
            Accept::NOTHING,
            Cancel::default(),
            check,
            &mut |_| {},
        )
        .unwrap();
        assert!(matches!(
            result,
            ResultOfImport::Refused(Refusal::Unasked { expired: false, .. })
        ));
        // The plain local entry point is the same as no check.
        let job = prepare(&device, &old);
        let result = dr_view_import::reimport::import(
            job,
            VERSION,
            Accept::NOTHING,
            Cancel::default(),
            &mut |_| {},
        )
        .unwrap();
        assert!(matches!(result, ResultOfImport::Refused(_)));
        assert!(import_traces(&data).is_empty());
        assert_eq!(registry_bytes(&data), registry_before);
    }
    assert_eq!(server.sync_request_count(), 0, "nothing was asked");
    assert_eq!(files(&old.root), source_before);
}

#[test]
fn an_interrupted_account_import_keeps_the_accounts_library_and_carries_on() {
    let server = FakeSyncServer::start(TOKEN);
    let device = Device::signed_in(&server);
    let data = device.data.path().to_path_buf();
    let original = device.root();
    let registry_before = registry_bytes(&data);
    let old = common::build_v3(true);
    let source_before = files(&old.root);
    let check = device.check(&server);

    // Cancelled before anything is written.
    let job = prepare(&device, &old);
    let cancel = Cancel::default();
    cancel.after_book();
    let result = dr_view_import::reimport::import_for(
        job,
        VERSION,
        Accept::NOTHING,
        cancel,
        Some(&check),
        &mut |_| {},
    )
    .unwrap();
    assert!(matches!(result, ResultOfImport::Cancelled));
    assert!(import_traces(&data).is_empty());

    // Stopped in the middle of the book.
    let job = prepare(&device, &old);
    let target = job.target();
    let cancel = Cancel::default();
    let stop = cancel.clone();
    let result = dr_view_import::reimport::import_for(
        job,
        VERSION,
        Accept::NOTHING,
        cancel,
        Some(&check),
        &mut |p| {
            if p.step == Step::Bodies && p.done == 1 {
                stop.now();
            }
        },
    )
    .unwrap();
    let ResultOfImport::Imported { job, receipt, .. } = result else {
        panic!("expected an interrupted import")
    };
    assert!(!job.completed && receipt.cancelled);
    // The account's library is as it was; the server has nothing.
    assert_eq!(registry_bytes(&data), registry_before);
    assert!(device.ws.library().docs(None, None).unwrap().is_empty());
    assert_eq!(server.stored_object_count(), 0);
    // The account remembers its own unfinished import, the local library
    // does not.
    let pointer = format!("reimport-v5-pending-{}.json", account_library_id(SUBJECT));
    assert!(data.join(&pointer).is_file());
    assert!(!data.join("reimport-v5-pending.json").exists());
    let unfinished = Destination::unfinished(&original).unwrap().unwrap();
    assert_eq!(unfinished.target(), target);
    let local = data.join("library");
    assert!(Destination::unfinished(&local).unwrap().is_none());

    // Carrying on finishes the same target; taking it up makes it the
    // account's library.
    let resumed = prepare(&device, &old);
    assert_eq!(resumed.target(), target);
    let ResultOfImport::Imported { job, receipt, .. } = dr_view_import::reimport::import_for(
        resumed,
        VERSION,
        Accept::NOTHING,
        Cancel::default(),
        Some(&check),
        &mut |_| {},
    )
    .unwrap() else {
        panic!("not carried on")
    };
    assert!(job.completed);
    assert_eq!(receipt.books[0].status, "imported");
    let Device {
        data: dir,
        account,
        ws,
    } = device;
    ws.shutdown().unwrap();
    let opened = job
        .open_target(&original, dr_workspace::library_options(VERSION))
        .unwrap();
    let taken = Library::open(opened, Default::default()).unwrap();
    job.commit_selection(&taken).unwrap();
    assert_eq!(
        LibraryRegistry::load_or_init(dir.path())
            .unwrap()
            .active_library_dir(dir.path()),
        target
    );
    assert_eq!(account.reload_active_library().active_library_dir, target);
    assert!(Destination::unfinished(&target).unwrap().is_none());
    taken.shutdown().unwrap();

    // Signed out: the local library is open and imports go there, as before;
    // the account keeps its library.
    let signed_out = account.sign_out().unwrap();
    assert_eq!(signed_out.active_library_dir, local);
    let local_ws = open(dir.path(), &local);
    assert!(
        local_ws.library().docs(None, None).unwrap().is_empty(),
        "no book came over"
    );
    let picked = dr_import_v1::locate::resolve(&old.root).unwrap();
    let job = Destination::prepare(&local, &picked).unwrap();
    assert_ne!(job.target(), target);
    let ResultOfImport::Imported { job, .. } = dr_view_import::reimport::import(
        job,
        VERSION,
        Accept::NOTHING,
        Cancel::default(),
        &mut |_| {},
    )
    .unwrap() else {
        panic!("local import")
    };
    local_ws.shutdown().unwrap();
    let opened = job
        .open_target(&local, dr_workspace::library_options(VERSION))
        .unwrap();
    let taken = Library::open(opened, Default::default()).unwrap();
    job.commit_selection(&taken).unwrap();
    taken.shutdown().unwrap();
    let registry = LibraryRegistry::load_or_init(dir.path()).unwrap();
    assert_eq!(registry.active_entry().owner, LibraryOwner::Local);
    assert_eq!(registry.active_library_dir(dir.path()), job.target());
    let account_entry = registry
        .entries
        .iter()
        .find(|e| e.id == account_library_id(SUBJECT))
        .unwrap();
    assert_eq!(dir.path().join(&account_entry.path), target);
    assert_eq!(server.stored_object_count(), 0, "no sync ran");
    assert_eq!(files(&old.root), source_before);
}

/// 0.1 names an account's library `account-` + the first 16 bytes of
/// SHA-256(subject) in hex (`src-tauri/src/library_registry.rs`), as this
/// client does; but it finds it by the owner its registry records, which also
/// covers the pre-registry library claimed for an account. So does the list.
#[test]
fn signed_in_the_list_offers_the_accounts_own_01_library_first_then_the_local_ones() {
    use sha2::Digest as _;
    let digest = sha2::Sha256::digest(SUBJECT.as_bytes());
    let hex: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(account_library_id(SUBJECT), format!("account-{hex}"));

    let base = tempfile::tempdir().unwrap();
    let mine = account_library_id(SUBJECT);
    let theirs = account_library_id("synthetic-other-user");
    std::fs::write(
        base.path().join("libraries.json"),
        format!(
            r#"{{"version":1,"active":"local","libraries":{{
                "legacy":{{"owner":{{"kind":"local"}}}},
                "local":{{"owner":{{"kind":"local"}}}},
                "{mine}":{{"owner":{{"kind":"account","subject":"{SUBJECT}"}}}},
                "{theirs}":{{"owner":{{"kind":"account","subject":"synthetic-other-user"}}}}}}}}"#
        ),
    )
    .unwrap();
    for root in [
        base.path().to_path_buf(),
        base.path().join("libraries/local"),
        base.path().join("libraries").join(&mine),
        base.path().join("libraries").join(&theirs),
    ] {
        std::fs::create_dir_all(root.join("databases")).unwrap();
        std::fs::write(root.join("databases/drifting-library.db"), b"").unwrap();
    }
    let ids = |found: &[dr_view_import::FoundLibrary]| {
        found
            .iter()
            .map(|l| (l.picked.id.clone().unwrap(), l.account))
            .collect::<Vec<_>>()
    };
    let signed_in = dr_view_import::find_libraries(base.path(), Some(SUBJECT));
    assert_eq!(
        ids(&signed_in),
        [
            (mine.clone(), true),
            ("local".to_owned(), false),
            ("legacy".to_owned(), false)
        ]
    );
    assert_eq!(signed_in[0].picked.left, [theirs.as_str()]);
    let mut accounts = vec![mine.clone(), theirs.clone()];
    accounts.sort();
    assert_eq!(
        signed_in[1].picked.left, accounts,
        "by id, as 0.1 lists them"
    );
    let signed_out = dr_view_import::find_local_libraries(base.path());
    assert_eq!(
        ids(&signed_out),
        [("local".to_owned(), false), ("legacy".to_owned(), false)]
    );

    // The pre-registry library claimed for the account is the account's.
    std::fs::write(
        base.path().join("libraries.json"),
        format!(
            r#"{{"version":1,"active":"legacy","libraries":{{
                "legacy":{{"owner":{{"kind":"account","subject":"{SUBJECT}"}}}},
                "local":{{"owner":{{"kind":"local"}}}}}}}}"#
        ),
    )
    .unwrap();
    let signed_in = dr_view_import::find_libraries(base.path(), Some(SUBJECT));
    assert_eq!(
        ids(&signed_in),
        [("legacy".to_owned(), true), ("local".to_owned(), false)]
    );
    assert_eq!(signed_in[0].picked.root, base.path());
}
