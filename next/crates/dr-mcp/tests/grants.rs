//! Only temporary application/client directories and synthetic credentials.
use dr_mcp::{Client, ClientPaths, Credential, Endpoint, GrantPaths, GrantStore};
use futures::{FutureExt, executor::block_on};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn paths(root: &Path) -> GrantPaths {
    GrantPaths::new(
        root.join("app/mcp"),
        root.join("writer"),
        ClientPaths::from_home(root.join("home"), None, None),
    )
}
fn endpoint(port: u16) -> Endpoint {
    Endpoint::Loopback(([127, 0, 0, 1], port).into())
}
fn credential(store: &GrantStore, id: &str) -> Credential {
    Credential::read_private(Path::new(&store.describe(id).unwrap().config.args[2])).unwrap()
}

#[test]
fn manual_grants_authenticate_revoke_and_keep_secrets_out_of_public_values() {
    let dir = tempfile::tempdir().unwrap();
    let store = GrantStore::open(paths(dir.path()), endpoint(42100)).unwrap();
    let connection = block_on(store.create_manual("Synthetic client")).unwrap();
    assert_eq!(connection.grant.id.len(), 64);
    let secret = credential(&store, &connection.grant.id);
    let wire = serde_json::to_value(&secret).unwrap();
    assert_eq!(wire["version"], 1);
    assert_eq!(wire["socketPath"], "127.0.0.1:42100");
    assert_eq!(wire["token"].as_str().unwrap().len(), 64);
    assert!(!format!("{secret:?}").contains(wire["token"].as_str().unwrap()));
    let public = serde_json::to_string(&connection).unwrap();
    assert!(!public.contains("token"));
    let lease = store.authenticate(&secret).unwrap();
    lease.check_book("first-book").unwrap();
    lease.check_book("second-book").unwrap();
    store.validate(&lease).unwrap();
    let mut wake = lease.revoked();
    assert!(wake.as_mut().now_or_never().is_none());
    assert!(
        !block_on(store.revoke(&connection.grant.id))
            .unwrap()
            .leftover
    );
    block_on(wake);
    assert!(store.validate(&lease).is_err());
    assert!(lease.check_book("first-book").is_err());
    assert!(store.authenticate(&secret).is_err());
    assert!(!Path::new(&connection.config.args[2]).exists());
}

#[test]
fn client_configuration_failure_rolls_back_grant_and_connection_file() {
    let dir = tempfile::tempdir().unwrap();
    let paths = paths(dir.path());
    let store = GrantStore::open(paths.clone(), endpoint(42101)).unwrap();
    let config = paths.clients.path(Client::Codex).unwrap();
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    fs::write(config, b"broken [ not toml").unwrap();
    assert!(block_on(store.connect(Client::Codex, "Synthetic client")).is_err());
    assert!(store.list().is_empty());
    assert_eq!(fs::read(config).unwrap(), b"broken [ not toml");
    let files: Vec<_> = fs::read_dir(&paths.directory)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name())
        .collect();
    assert!(
        files
            .iter()
            .all(|name| !name.to_string_lossy().starts_with("connection-"))
    );
    let registry: Value =
        serde_json::from_slice(&fs::read(paths.directory.join("grants.json")).unwrap()).unwrap();
    assert_eq!(registry["grants"], json!([]));
}

#[test]
fn repair_updates_windows_endpoint_and_executable_but_never_readds_removed_entry() {
    let dir = tempfile::tempdir().unwrap();
    let first = paths(dir.path());
    let store = GrantStore::open(first.clone(), endpoint(42102)).unwrap();
    let connection = block_on(store.connect(Client::Antigravity, "Synthetic client"))
        .unwrap()
        .connection;
    let old = credential(&store, &connection.grant.id);
    let old_token = serde_json::to_value(&old).unwrap()["token"].clone();
    block_on(store.drain()).unwrap();
    drop(store);
    let mut second = first.clone();
    second.executable = dir.path().join("moved-writer");
    let store = GrantStore::open(second, endpoint(42103)).unwrap();
    assert!(
        block_on(store.repair_owned(true))
            .unwrap()
            .warnings
            .is_empty()
    );
    let repaired = credential(&store, &connection.grant.id);
    assert_eq!(repaired.endpoint(), &endpoint(42103));
    assert_eq!(serde_json::to_value(&repaired).unwrap()["token"], old_token);
    let path = first.clients.path(Client::Antigravity).unwrap();
    let mut config: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let name = connection
        .grant
        .installation
        .as_ref()
        .unwrap()
        .server_name
        .clone();
    assert_eq!(
        config["mcpServers"][&name]["command"],
        dir.path().join("moved-writer").to_str().unwrap()
    );
    config["mcpServers"].as_object_mut().unwrap().remove(&name);
    fs::write(path, serde_json::to_vec(&config).unwrap()).unwrap();
    assert!(
        block_on(store.repair_owned(true))
            .unwrap()
            .warnings
            .is_empty()
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(path).unwrap()).unwrap(),
        config
    );
    store.authenticate(&repaired).unwrap();
}

#[test]
fn revocation_survives_a_foreign_client_edit_and_failed_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let paths = paths(dir.path());
    let store = GrantStore::open(paths.clone(), endpoint(42104)).unwrap();
    let connection = block_on(store.connect(Client::ClaudeCode, "Synthetic client"))
        .unwrap()
        .connection;
    let secret = credential(&store, &connection.grant.id);
    let lease = store.authenticate(&secret).unwrap();
    let path = paths.clients.path(Client::ClaudeCode).unwrap();
    let installation = connection.grant.installation.unwrap();
    let source = json!({"mcpServers":{installation.server_name:{"command":"different","args":["different"]}}});
    fs::write(path, serde_json::to_vec(&source).unwrap()).unwrap();
    assert!(
        block_on(store.revoke(&connection.grant.id))
            .unwrap()
            .leftover
    );
    assert!(store.validate(&lease).is_err());
    assert!(store.authenticate(&secret).is_err());
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(path).unwrap()).unwrap(),
        source
    );
    let reopened = GrantStore::open(paths, endpoint(42104)).unwrap();
    assert!(reopened.authenticate(&secret).is_err());
}

#[test]
fn legacy_fields_are_read_then_dropped_and_single_book_scope_is_retained() {
    let dir = tempfile::tempdir().unwrap();
    let paths = paths(dir.path());
    let store = GrantStore::open(paths.clone(), endpoint(42105)).unwrap();
    let connection = block_on(store.create_manual("Synthetic client")).unwrap();
    let mut wire = serde_json::to_value(credential(&store, &connection.grant.id)).unwrap();
    let old_file = PathBuf::from(&connection.config.args[2]);
    let old_id = "0199a777-1234-7abc-8abc-0123456789ab";
    let file = paths.directory.join(format!("connection-{old_id}.json"));
    wire["connectionId"] = json!(old_id);
    fs::rename(old_file, &file).unwrap();
    fs::write(&file, serde_json::to_vec(&wire).unwrap()).unwrap();
    let path = paths.directory.join("grants.json");
    let mut registry: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    registry["grants"][0]["id"] = json!(old_id);
    registry["grants"][0]["projectId"] = json!("authorized-book");
    registry["grants"][0]["access"] = json!("read");
    registry["grants"][0]["allowDangerous"] = json!(false);
    fs::write(&path, serde_json::to_vec(&registry).unwrap()).unwrap();
    drop(store);
    let store = GrantStore::open(paths, endpoint(42105)).unwrap();
    let lease = store
        .authenticate(&Credential::read_private(&file).unwrap())
        .unwrap();
    lease.check_book("authorized-book").unwrap();
    assert!(lease.check_book("other-book").is_err());
    block_on(store.create_manual("Another synthetic client")).unwrap();
    let saved = fs::read_to_string(path).unwrap();
    assert!(!saved.contains("access"));
    assert!(!saved.contains("allowDangerous"));
    assert!(saved.contains("projectId"));
}

#[test]
fn upgrading_a_same_name_legacy_installation_only_retires_it_after_success() {
    for collision in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths(dir.path());
        let store = GrantStore::open(paths.clone(), endpoint(42107)).unwrap();
        let old = block_on(store.connect(Client::Antigravity, "Synthetic legacy client"))
            .unwrap()
            .connection;
        let secret = credential(&store, &old.grant.id);
        let registry_path = paths.directory.join("grants.json");
        let mut registry: Value =
            serde_json::from_slice(&fs::read(&registry_path).unwrap()).unwrap();
        registry["grants"][0]["projectId"] = json!("old-book");
        fs::write(registry_path, serde_json::to_vec(&registry).unwrap()).unwrap();
        drop(store);
        let store = GrantStore::open(paths.clone(), endpoint(42107)).unwrap();
        let lease = store.authenticate(&secret).unwrap();
        let installation = old.grant.installation.as_ref().unwrap();
        let mut config: Value =
            serde_json::from_slice(&fs::read(&installation.config_path).unwrap()).unwrap();
        if collision {
            config["mcpServers"][format!("{}_all", installation.server_name)] =
                json!({"command":"other", "args":["other"]});
            fs::write(
                &installation.config_path,
                serde_json::to_vec(&config).unwrap(),
            )
            .unwrap();
            assert!(
                block_on(store.connect(Client::Antigravity, "Synthetic upgraded client")).is_err()
            );
            store.validate(&lease).unwrap();
            assert_eq!(store.list().len(), 1);
            assert_eq!(
                serde_json::from_slice::<Value>(&fs::read(&installation.config_path).unwrap())
                    .unwrap(),
                config
            );
        } else {
            let new =
                block_on(store.connect(Client::Antigravity, "Synthetic upgraded client")).unwrap();
            assert!(!new.leftover);
            assert_ne!(new.connection.grant.id, old.grant.id);
            assert!(new.connection.grant.project_id.is_none());
            block_on(lease.revoked());
            assert!(store.authenticate(&secret).is_err());
            assert_eq!(store.list().len(), 1);
            let repeated =
                block_on(store.connect(Client::Antigravity, "Synthetic upgraded client")).unwrap();
            assert_eq!(repeated.connection.grant.id, new.connection.grant.id);
            assert_eq!(store.list().len(), 1);
            let config: Value =
                serde_json::from_slice(&fs::read(&installation.config_path).unwrap()).unwrap();
            assert!(
                config["mcpServers"]
                    .get(&installation.server_name)
                    .is_none()
            );
        }
    }
}

#[test]
fn malformed_wire_and_custom_claude_only_disable_the_affected_route() {
    let dir = tempfile::tempdir().unwrap();
    let clients = ClientPaths::from_home(
        dir.path().join("home"),
        None,
        Some(dir.path().join("custom-claude")),
    );
    assert!(clients.path(Client::ClaudeCode).is_err());
    assert!(clients.path(Client::Codex).is_ok());
    assert!(clients.path(Client::Antigravity).is_ok());
    let valid = json!({"version":1,"socketPath":"127.0.0.1:43210","connectionId":"old-uuid-id","token":"synthetic-token"});
    assert!(serde_json::from_value::<Credential>(valid.clone()).is_ok());
    for (key, bad) in [
        ("version", json!(2)),
        ("socketPath", json!("203.0.113.1:80")),
        ("connectionId", json!("../escape")),
        ("unexpected", json!(true)),
    ] {
        let mut value = valid.clone();
        value[key] = bad;
        assert!(serde_json::from_value::<Credential>(value).is_err());
    }
}

#[test]
fn an_unexpected_registry_change_fails_closed_without_overwriting_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let paths = paths(dir.path());
    let store = GrantStore::open(paths.clone(), endpoint(42106)).unwrap();
    let grant = block_on(store.create_manual("Synthetic client")).unwrap();
    let secret = credential(&store, &grant.grant.id);
    let lease = store.authenticate(&secret).unwrap();
    let path = paths.directory.join("grants.json");
    let mut bytes = fs::read(&path).unwrap();
    bytes.push(b' ');
    fs::write(&path, &bytes).unwrap();
    assert!(block_on(store.revoke(&grant.grant.id)).is_err());
    assert!(store.validate(&lease).is_err());
    assert!(store.authenticate(&secret).is_err());
    assert!(block_on(store.create_manual("Another client")).is_err());
    block_on(lease.revoked());
    block_on(store.drain()).unwrap();
    assert_eq!(fs::read(path).unwrap(), bytes);
    assert!(Path::new(&grant.config.args[2]).exists());
}

#[cfg(unix)]
#[test]
fn long_identity_directory_uses_a_stable_private_short_socket_parent() {
    use std::os::unix::{ffi::OsStrExt, fs::PermissionsExt};
    let dir = tempfile::tempdir().unwrap();
    let short = tempfile::tempdir_in("/tmp").unwrap();
    let mut paths = paths(dir.path());
    paths.directory = dir.path().join("long-identity".repeat(12));
    let paths = paths.with_socket_root(short.path().join("cache"));
    let socket = paths.socket_path().unwrap();
    assert_eq!(paths.socket_path().unwrap(), socket);
    assert!(socket.as_os_str().as_bytes().len() <= 103);
    assert!(socket.starts_with(short.path().join("cache/drifting-mcp")));
    assert_eq!(
        fs::metadata(socket.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}
