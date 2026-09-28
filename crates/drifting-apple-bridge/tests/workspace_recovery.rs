//! A failed workspace upgrade through the C ABI: the failure, the safety
//! copy, a retry and a restore. Its own test binary, so the fault variable
//! it sets never reaches another test's open.
use drifting_apple_bridge::{drifting_lab_call, drifting_lab_free};
use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::path::{Path, PathBuf};

const CLIENT: &str = "apple-native-lab";

fn call(request: Value) -> Value {
    let input = CString::new(request.to_string()).unwrap();
    let result = unsafe { drifting_lab_call(input.as_ptr()) };
    let output = serde_json::from_slice(unsafe { CStr::from_ptr(result) }.to_bytes()).unwrap();
    unsafe { drifting_lab_free(result) };
    output
}

fn success(request: Value) -> Value {
    let response = call(request);
    assert_eq!(response["ok"], true, "{response}");
    response["value"].clone()
}

fn rejected(request: Value) -> String {
    let response = call(request);
    assert_eq!(response["ok"], false, "{response}");
    response["error"].as_str().unwrap().into()
}

/// A lab workspace with one synthetic project, closed again.
struct Fixture {
    _temporary: tempfile::TempDir,
    directory: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join(CLIENT);
        let opened = success(json!({"operation":"workspaceOpen","directory":directory}));
        let handle = opened["handle"].as_u64().unwrap();
        success(
            json!({"operation":"workspaceCreateProject","handle":handle,"name":"合成写作项目"}),
        );
        success(json!({"operation":"workspaceClose","handle":handle}));
        Self {
            _temporary: temporary,
            directory,
        }
    }
}

const FAULT: &str = "DRIFTING_TEST_DATABASE_FAULT_STAGE";

/// Makes the next open take the upgrade path and fail inside the shadow
/// migration (debug builds only), leaving the active database untouched.
fn failing_open(directory: &Path) -> String {
    std::fs::remove_file(
        directory
            .join("safety-backups")
            .join("apple-native-workspace.db.last-version"),
    )
    .unwrap();
    std::env::set_var(FAULT, "migration");
    let error = rejected(json!({"operation":"workspaceOpen","directory":directory}));
    std::env::remove_var(FAULT);
    error
}

fn recovery(directory: &Path, command: Value) -> Value {
    success(json!({"operation":"workspaceRecovery","directory":directory,"command":command}))
}

#[test]
fn workspace_recovery_reports_retries_and_restores_the_safety_copy() {
    let fixture = Fixture::new();
    let directory = fixture.directory.clone();
    let error = failing_open(&directory);
    assert!(error.starts_with("database-recovery:"), "{error}");
    let status = recovery(&directory, json!({"action":"status","error":error}));
    assert_eq!(status["code"], "migration-statement-failed");
    let session = status["recoverySessionId"].as_str().unwrap().to_string();
    let backup = status["safetyBackup"]["backupId"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(status["safetyBackup"]["sizeBytes"].as_u64().unwrap() > 0);
    // The copy and its folder, inside the lab directory.
    let file = recovery(
        &directory,
        json!({"action":"backupFile","recoverySessionId":session,"backupId":backup}),
    )["path"]
        .as_str()
        .unwrap()
        .to_string();
    let canonical = directory.canonicalize().unwrap();
    assert!(Path::new(&file).is_file() && Path::new(&file).starts_with(&canonical));
    let folder = recovery(
        &directory,
        json!({"action":"backupFolder","recoverySessionId":session}),
    )["path"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(Path::new(&file).parent().unwrap(), Path::new(&folder));
    let wrong = call(
        json!({"operation":"workspaceRecovery","directory":directory,
        "command":{"action":"backupFile","recoverySessionId":session,"backupId":"0".repeat(64)}}),
    );
    assert_eq!(wrong["ok"], false);
    // Restoring rebuilds from the copy; the workspace then opens with the book.
    let restored = recovery(
        &directory,
        json!({"action":"restore","recoverySessionId":session,"backupId":backup}),
    );
    assert!(restored["migrationsApplied"].is_u64());
    let opened = success(json!({"operation":"workspaceOpen","directory":directory}));
    assert_eq!(opened["projects"][0]["name"], "合成写作项目");
    let handle = opened["handle"].as_u64().unwrap();
    // A live workspace refuses recovery commands.
    let live = call(
        json!({"operation":"workspaceRecovery","directory":directory,
        "command":{"action":"backupFolder","recoverySessionId":session}}),
    );
    assert_eq!(live["ok"], false);
    success(json!({"operation":"workspaceClose","handle":handle}));
    // Retrying is opening again once the fault is gone.
    let error = failing_open(&directory);
    assert!(error.starts_with("database-recovery:"), "{error}");
    let opened = success(json!({"operation":"workspaceOpen","directory":directory}));
    assert_eq!(opened["projects"][0]["name"], "合成写作项目");
    success(json!({"operation":"workspaceClose","handle":opened["handle"]}));
    // Any other open failure has no safety copy to offer.
    let other = recovery(
        &directory,
        json!({"action":"status","error":"failed to open database: synthetic"}),
    );
    assert_eq!(other["code"], "database-open-failed");
    assert_eq!(other["safetyBackup"], Value::Null);
}
