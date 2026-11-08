#[path = "support/outbound.rs"]
mod support;

use dr_agent::{Event, State, ToolAccess, ToolCall, ToolExecutor, ToolPolicy, ToolStatus, events};
use dr_mcp::outbound::*;
use futures::FutureExt;
use serde_json::json;
use std::{collections::BTreeMap, time::Duration};
use support::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cache_search_is_local_and_every_http_call_needs_permission_despite_read_hint() {
    let f = Fixture::new();
    let server = Server::new().await;
    let info = f
        .manager
        .save(f.book.to_string(), draft(&server.url, "same"))
        .await
        .unwrap();
    assert_eq!(info.status, Status::Ready);
    assert_eq!(info.tools.len(), 1);
    let descriptors = f.tools.descriptors();
    assert_eq!(descriptors.len(), 2);
    assert_eq!(
        (descriptors[1].policy, descriptors[1].access),
        (ToolPolicy::ExternalPlugin, ToolAccess::Write)
    );
    let requests = server.requests().len();
    let (runtime, run) = f.start(
        f.book.clone(),
        ToolCall {
            id: "search".into(),
            name: "mcp_search".into(),
            arguments: json!({"query":"echo"}),
        },
    );
    let session = run.session.clone();
    assert_eq!(finish(runtime, run).await, State::Completed);
    assert_eq!(server.requests().len(), requests);
    let log = events(f.ws.library(), &session, 0).unwrap();
    assert!(
        !log.iter()
            .any(|e| matches!(e.event, Event::PermissionAsked { .. }))
    );
    assert!(log.iter().any(|e|matches!(&e.event,Event::ToolFinished{result} if result.output["tools"][0]["revision"]==info.tools[0].revision)));
    for (allow, count) in [(false, 0), (true, 1), (false, 1)] {
        let (runtime, run) = f.start(f.book.clone(), call(&info, &f.text));
        let request = permission(&f, &run).await;
        assert_eq!(server.calls(), count - usize::from(allow));
        run.control.permit(request, allow).await.unwrap();
        assert_eq!(finish(runtime, run).await, State::Completed);
        assert_eq!(server.calls(), count);
    }
    f.shutdown().await;
    server.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changed_configuration_invalidates_approval_without_retargeting_the_call() {
    let f = Fixture::new();
    let a = Server::new().await;
    let b = Server::new().await;
    let old = f
        .manager
        .save(f.book.to_string(), draft(&a.url, "same"))
        .await
        .unwrap();
    let (runtime, run) = f.start(f.book.clone(), call(&old, &f.text));
    let session = run.session.clone();
    let request = permission(&f, &run).await;
    let mut changed = draft(&b.url, "same");
    changed.expected_revision = Some(old.revision.clone());
    let changed = f.manager.save(f.book.to_string(), changed).await.unwrap();
    assert_ne!(old.tools[0].revision, changed.tools[0].revision);
    run.control.permit(request, true).await.unwrap();
    finish(runtime, run).await;
    assert_eq!((a.calls(), b.calls()), (0, 0));
    assert!(events(f.ws.library(), &session, 0).unwrap().iter().any(
        |e| matches!(&e.event,Event::ToolFinished{result} if result.status!=ToolStatus::Success)
    ));
    f.shutdown().await;
    a.close().await;
    b.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn books_with_identical_server_ids_keep_connections_and_authority_separate() {
    let f = Fixture::new();
    let a = Server::new().await;
    let b = Server::new().await;
    let first = f
        .manager
        .save(f.book.to_string(), draft(&a.url, "same"))
        .await
        .unwrap();
    let second = f
        .manager
        .save(f.other.to_string(), draft(&b.url, "same"))
        .await
        .unwrap();
    assert_ne!(first.tools[0].revision, second.tools[0].revision);
    a.behavior(Behavior {
        hold: true,
        ..Default::default()
    });
    let (runtime, run) = f.start(f.book.clone(), call(&first, &f.text));
    let request = permission(&f, &run).await;
    run.control.permit(request, true).await.unwrap();
    until(|| a.calls() == 1).await;
    f.manager.activate(Some(f.other.to_string())).await.unwrap();
    assert_eq!(f.manager.snapshot().book.as_deref(), Some(f.other.as_str()));
    a.release();
    finish(runtime, run).await;
    assert_eq!((a.calls(), b.calls()), (1, 0));
    // A's cached capability cannot authorize B, even after approving it.
    let (runtime, run) = f.start(f.other.clone(), call(&first, &f.text));
    let request = permission(&f, &run).await;
    run.control.permit(request, true).await.unwrap();
    finish(runtime, run).await;
    assert_eq!((a.calls(), b.calls()), (1, 0));
    let (runtime, run) = f.start(f.other.clone(), call(&second, &f.text));
    let request = permission(&f, &run).await;
    run.control.permit(request, true).await.unwrap();
    finish(runtime, run).await;
    assert_eq!((a.calls(), b.calls()), (1, 1));
    f.shutdown().await;
    a.close().await;
    b.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secrets_are_versioned_local_refs_and_stale_edits_leave_current_credentials_intact() {
    let f = Fixture::new();
    let before =
        f.ws.library()
            .docs(None, None)
            .unwrap()
            .into_iter()
            .map(|d| {
                let value =
                    f.ws.library()
                        .load_copy(&d.doc_id)
                        .unwrap()
                        .get_deep_value();
                (d.doc_id, value)
            })
            .collect::<Vec<_>>();
    let mut initial = draft("https://example.com/mcp", "credential");
    initial.enabled = false;
    initial.transport = TransportDraft::Http {
        url: "https://example.com/mcp".into(),
        headers: BTreeMap::from([
            (
                "authorization".into(),
                SecretInput::Set("synthetic-old-secret".into()),
            ),
            (
                "x-public".into(),
                SecretInput::Public("visible-value".into()),
            ),
        ]),
    };
    let old = f.manager.save(f.book.to_string(), initial).await.unwrap();
    let TransportConfig::Http { headers, .. } = &old.transport else {
        panic!()
    };
    let ConfigValue::Secret { reference: old_ref } = &headers["authorization"] else {
        panic!()
    };
    assert_eq!(
        headers["x-public"],
        ConfigValue::Public("visible-value".into())
    );
    let mut replacement = draft("https://example.com/mcp", "credential");
    replacement.enabled = false;
    replacement.expected_revision = Some(old.revision.clone());
    replacement.transport = TransportDraft::Http {
        url: "https://example.com/mcp".into(),
        headers: BTreeMap::from([(
            "authorization".into(),
            SecretInput::Set("synthetic-new-secret".into()),
        )]),
    };
    let current = f
        .manager
        .save(f.book.to_string(), replacement.clone())
        .await
        .unwrap();
    let TransportConfig::Http { headers, .. } = &current.transport else {
        panic!()
    };
    let ConfigValue::Secret {
        reference: current_ref,
    } = &headers["authorization"]
    else {
        panic!()
    };
    assert_ne!(old_ref, current_ref);
    assert!(f.secrets.get(old_ref).unwrap().is_none());
    assert!(
        f.manager
            .save(f.book.to_string(), replacement)
            .await
            .is_err()
    );
    assert_eq!(
        f.secrets.get(current_ref).unwrap().as_deref(),
        Some("synthetic-new-secret")
    );
    let mut keep = draft("https://example.com/mcp", "credential");
    keep.enabled = false;
    keep.expected_revision = Some(current.revision.clone());
    keep.transport = TransportDraft::Http {
        url: "https://example.com/mcp".into(),
        headers: BTreeMap::from([("authorization".into(), SecretInput::Keep)]),
    };
    let kept = f.manager.save(f.book.to_string(), keep).await.unwrap();
    assert_eq!(kept.transport, current.transport);
    let local = f.ws.library().local_entries("mcp.outbound", None).unwrap();
    assert_eq!(local.len(), 1);
    assert!(!local[0].value.contains("synthetic-new-secret"));
    assert!(!local[0].value.contains("synthetic-old-secret"));
    for (id, value) in before {
        assert_eq!(
            f.ws.library().load_copy(&id).unwrap().get_deep_value(),
            value
        );
    }
    f.manager
        .remove(f.book.to_string(), kept.id, kept.revision)
        .await
        .unwrap();
    assert!(f.secrets.get(current_ref).unwrap().is_none());
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bad_catalogs_are_rejected_atomically_and_reconnect_changes_tool_revision() {
    let f = Fixture::new();
    let server = Server::new().await;
    let first = f
        .manager
        .save(f.book.to_string(), draft(&server.url, "catalog"))
        .await
        .unwrap();
    assert_eq!(first.status, Status::Ready);
    for behavior in [
        Behavior {
            duplicate: true,
            ..Default::default()
        },
        Behavior {
            loop_cursor: true,
            ..Default::default()
        },
        Behavior {
            bad_schema: true,
            ..Default::default()
        },
        Behavior {
            tool_count: 257,
            ..Default::default()
        },
        Behavior {
            page_count: 17,
            ..Default::default()
        },
    ] {
        server.behavior(behavior);
        assert!(
            f.manager
                .reconnect(f.book.to_string(), first.id.clone(), first.revision.clone())
                .await
                .is_err()
        );
        let failed = f.manager.list(f.book.to_string()).await.unwrap().remove(0);
        assert!(matches!(failed.status, Status::Failed { .. }));
        assert_eq!(failed.tools, first.tools);
        assert_eq!(server.calls(), 0);
    }
    server.behavior(Behavior {
        page_count: 2,
        sse: true,
        ..Default::default()
    });
    f.manager
        .reconnect(f.book.to_string(), first.id.clone(), first.revision.clone())
        .await
        .unwrap();
    let ready = f.manager.list(f.book.to_string()).await.unwrap().remove(0);
    assert_eq!(ready.tools.len(), 2);
    assert_ne!(ready.tools[0].revision, first.tools[0].revision);
    f.shutdown().await;
    server.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn response_limits_and_expired_sessions_never_replay_an_actual_tool_call() {
    let f = Fixture::new();
    let server = Server::new().await;
    for (id, behavior) in [
        (
            "large",
            Behavior {
                oversized: true,
                ..Default::default()
            },
        ),
        (
            "headers",
            Behavior {
                headers: 65,
                ..Default::default()
            },
        ),
    ] {
        server.behavior(behavior);
        let info = f
            .manager
            .save(f.book.to_string(), draft(&server.url, id))
            .await
            .unwrap();
        assert!(matches!(info.status, Status::Failed { .. }));
        assert!(info.tools.is_empty());
    }
    server.behavior(Behavior::default());
    let info = f
        .manager
        .save(f.book.to_string(), draft(&server.url, "expiry"))
        .await
        .unwrap();
    let initializes = server
        .requests()
        .iter()
        .filter(|r| r["method"] == "initialize")
        .count();
    server.behavior(Behavior {
        expire: true,
        ..Default::default()
    });
    let (runtime, run) = f.start(f.book.clone(), call(&info, &f.text));
    let request = permission(&f, &run).await;
    run.control.permit(request, true).await.unwrap();
    finish(runtime, run).await;
    assert_eq!(server.calls(), 1);
    assert_eq!(
        server
            .requests()
            .iter()
            .filter(|r| r["method"] == "initialize")
            .count(),
        initializes
    );
    f.shutdown().await;
    server.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn input_required_is_returned_without_automatic_followup() {
    let f = Fixture::new();
    let server = Server::new().await;
    let info = f
        .manager
        .save(f.book.to_string(), draft(&server.url, "followup"))
        .await
        .unwrap();
    server.behavior(Behavior {
        followup: true,
        ..Default::default()
    });
    let (runtime, run) = f.start(f.book.clone(), call(&info, &f.text));
    let session = run.session.clone();
    let request = permission(&f, &run).await;
    run.control.permit(request, true).await.unwrap();
    finish(runtime, run).await;
    assert_eq!(server.calls(), 1);
    assert!(events(f.ws.library(), &session, 0).unwrap().iter().any(
        |e| matches!(&e.event,Event::ToolFinished{result} if result.output["outcome"]=="incomplete")
    ));
    f.shutdown().await;
    server.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_close_ack_still_drains_an_entered_call_and_releases_library_clones() {
    let f = Fixture::new();
    let server = Server::new().await;
    let info = f
        .manager
        .save(f.book.to_string(), draft(&server.url, "close"))
        .await
        .unwrap();
    server.behavior(Behavior {
        hold: true,
        ..Default::default()
    });
    let (runtime, run) = f.start(f.book.clone(), call(&info, &f.text));
    let session = run.session.clone();
    let request = permission(&f, &run).await;
    run.control.permit(request, true).await.unwrap();
    until(|| server.calls() == 1).await;
    drop(f.manager.begin_close());
    assert!(f.manager.list(f.book.to_string()).await.is_err());
    tokio::time::timeout(Duration::from_secs(10), f.manager.begin_close())
        .await
        .unwrap()
        .unwrap();
    finish(runtime, run).await;
    assert!(events(f.ws.library(),&session,0).unwrap().iter().any(|e|matches!(&e.event,Event::ToolFinished{result} if result.output.to_string().contains("outcome is unknown"))));
    assert_eq!(server.calls(), 1);
    f.shutdown().await;
    server.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_a_save_ack_does_not_abandon_queued_local_or_secret_writes() {
    let f = Fixture::new();
    let (entered, waiting) = tokio::sync::oneshot::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    let library = f.ws.library().clone();
    let transaction = tokio::task::spawn_blocking(move || {
        library.local_write(|_| {
            entered.send(()).unwrap();
            blocked.recv_timeout(Duration::from_secs(10)).unwrap();
            Ok(())
        })
    });
    waiting.await.unwrap();
    let mut config = draft("https://example.com/mcp", "pending");
    config.enabled = false;
    config.transport = TransportDraft::Http {
        url: "https://example.com/mcp".into(),
        headers: BTreeMap::from([(
            "authorization".into(),
            SecretInput::Set("synthetic-save".into()),
        )]),
    };
    drop(f.manager.save(f.book.to_string(), config));
    let closed = f.manager.begin_close().shared();
    assert!(closed.clone().now_or_never().is_none());
    release.send(()).unwrap();
    transaction.await.unwrap().unwrap();
    closed.await.unwrap();
    assert_eq!(
        f.ws.library()
            .local_entries("mcp.outbound", Some(f.book.as_str()))
            .unwrap()
            .len(),
        1
    );
    f.shutdown().await;
}

#[cfg(unix)]
async fn read_pid(path: &std::path::Path) -> libc::pid_t {
    let mut pid = None;
    until(|| {
        pid = std::fs::read_to_string(path)
            .ok()
            .and_then(|text| text.trim().parse::<libc::pid_t>().ok())
            .filter(|pid| *pid > 0);
        pid.is_some()
    })
    .await;
    pid.expect("complete positive fixture PID")
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stdio_uses_real_protocol_drains_stderr_and_reaps_the_process_on_close() {
    let f = Fixture::new();
    let script = f._directory.path().join("peer.py");
    let marker = f._directory.path().join("calls");
    std::fs::write(&script, include_str!("fixtures/outbound.py")).unwrap();
    let info = f
        .manager
        .save(
            f.book.to_string(),
            ServerDraft {
                id: Some("stdio".into()),
                expected_revision: None,
                name: "Synthetic stdio".into(),
                enabled: true,
                transport: TransportDraft::Stdio {
                    command: "/usr/bin/python3".into(),
                    args: vec![
                        script.to_string_lossy().into_owned(),
                        marker.to_string_lossy().into_owned(),
                        "stderr".into(),
                    ],
                    cwd: Some(f._directory.path().to_string_lossy().into_owned()),
                    env: BTreeMap::new(),
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(info.status, Status::Ready);
    let pid = read_pid(&marker.with_extension("pid")).await;
    let (runtime, run) = f.start(f.book.clone(), call(&info, &f.text));
    let request = permission(&f, &run).await;
    assert!(!marker.exists());
    run.control.permit(request, true).await.unwrap();
    finish(runtime, run).await;
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "1");
    let child = read_pid(&marker.with_extension("child.pid")).await;
    assert_eq!(unsafe { libc::kill(child, 0) }, 0);
    f.manager.begin_close().await.unwrap();
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    until(|| unsafe { libc::kill(child, 0) } == -1).await;
    f.shutdown().await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_stdio_initialization_is_reaped_even_when_the_save_waiter_is_dropped() {
    let f = Fixture::new();
    let script = f._directory.path().join("peer.py");
    let marker = f._directory.path().join("hang");
    std::fs::write(&script, include_str!("fixtures/outbound.py")).unwrap();
    drop(f.manager.save(
        f.book.to_string(),
        ServerDraft {
            id: Some("hang".into()),
            expected_revision: None,
            name: "Synthetic waiting peer".into(),
            enabled: true,
            transport: TransportDraft::Stdio {
                command: "/usr/bin/python3".into(),
                args: vec![
                    script.to_string_lossy().into_owned(),
                    marker.to_string_lossy().into_owned(),
                    "hang".into(),
                ],
                cwd: None,
                env: BTreeMap::new(),
            },
        },
    ));
    let pid = read_pid(&marker.with_extension("pid")).await;
    tokio::time::timeout(Duration::from_secs(10), f.manager.begin_close())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runtime_abort_settles_the_entered_plugin_as_unknown_without_retry() {
    let f = Fixture::new();
    let server = Server::new().await;
    let info = f
        .manager
        .save(f.book.to_string(), draft(&server.url, "abort"))
        .await
        .unwrap();
    server.behavior(Behavior {
        hold: true,
        ..Default::default()
    });
    let (runtime, run) = f.start(f.book.clone(), call(&info, &f.text));
    let session = run.session.clone();
    let request = permission(&f, &run).await;
    run.control.permit(request, true).await.unwrap();
    until(|| server.calls() == 1).await;
    run.control.abort().await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), finish(runtime, run))
            .await
            .unwrap(),
        State::Aborted
    );
    assert_eq!(server.calls(), 1);
    assert!(events(f.ws.library(), &session, 0).unwrap().iter().any(|e| matches!(&e.event, Event::ToolFinished { result } if result.output.to_string().contains("outcome is unknown"))));
    assert!(matches!(
        f.manager.list(f.book.to_string()).await.unwrap()[0].status,
        Status::Failed { .. }
    ));
    f.shutdown().await;
    server.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refreshed_catalog_invalidates_pending_approval_even_when_configuration_is_unchanged() {
    let f = Fixture::new();
    let server = Server::new().await;
    let first = f
        .manager
        .save(f.book.to_string(), draft(&server.url, "catalog-approval"))
        .await
        .unwrap();
    let (runtime, run) = f.start(f.book.clone(), call(&first, &f.text));
    let request = permission(&f, &run).await;
    f.manager
        .reconnect(f.book.to_string(), first.id.clone(), first.revision.clone())
        .await
        .unwrap();
    let current = f.manager.list(f.book.to_string()).await.unwrap().remove(0);
    assert_eq!(first.revision, current.revision);
    assert_ne!(first.tools[0].revision, current.tools[0].revision);
    run.control.permit(request, true).await.unwrap();
    finish(runtime, run).await;
    assert_eq!(server.calls(), 0);
    f.shutdown().await;
    server.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_root_url_without_trailing_slash_connects_and_reopens_from_stored_configuration() {
    let f = Fixture::new();
    let server = Server::new().await;
    let original = server.url.strip_suffix("/mcp").unwrap();
    let first = f
        .manager
        .save(f.book.to_string(), draft(original, "root-url"))
        .await
        .unwrap();
    assert_eq!(first.status, Status::Ready);
    let TransportConfig::Http { url, .. } = &first.transport else {
        panic!()
    };
    assert_eq!(url, original);
    f.manager.begin_close().await.unwrap();

    // Existing persisted records retain the author's spelling. A fresh manager
    // must derive the same canonical URI for the SDK and guarded HTTP client.
    let reopened = Manager::new(
        f.ws.library().clone(),
        f.secrets.clone(),
        tokio::runtime::Handle::current(),
    );
    let saved = reopened.list(f.book.to_string()).await.unwrap().remove(0);
    assert_eq!(saved.transport, first.transport);
    reopened
        .reconnect(f.book.to_string(), saved.id, saved.revision)
        .await
        .unwrap();
    let current = reopened.list(f.book.to_string()).await.unwrap().remove(0);
    assert_eq!(current.status, Status::Ready);
    f.slot.replace(Some(reopened.clone()));
    let (runtime, run) = f.start(f.book.clone(), call(&current, &f.text));
    let request = permission(&f, &run).await;
    assert_eq!(server.calls(), 0);
    run.control.permit(request, true).await.unwrap();
    finish(runtime, run).await;
    assert_eq!(server.calls(), 1);
    reopened.begin_close().await.unwrap();
    f.shutdown().await;
    server.close().await;
}

#[cfg(unix)]
#[test]
fn dropping_the_reactor_during_stdio_handshake_signals_the_whole_process_tree() {
    let reactor = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let (fixture, pid, child) = reactor.block_on(async {
        let f = Fixture::new();
        let script = f._directory.path().join("peer.py");
        let marker = f._directory.path().join("shutdown");
        std::fs::write(&script, include_str!("fixtures/outbound.py")).unwrap();
        drop(f.manager.save(
            f.book.to_string(),
            ServerDraft {
                id: Some("shutdown".into()),
                expected_revision: None,
                name: "Synthetic interrupted reactor".into(),
                enabled: true,
                transport: TransportDraft::Stdio {
                    command: "/usr/bin/python3".into(),
                    args: vec![
                        script.to_string_lossy().into_owned(),
                        marker.to_string_lossy().into_owned(),
                        "hang-tree".into(),
                    ],
                    cwd: None,
                    env: BTreeMap::new(),
                },
            },
        ));
        let pid = read_pid(&marker.with_extension("pid")).await;
        let child = read_pid(&marker.with_extension("child.pid")).await;
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
        assert_eq!(unsafe { libc::kill(child, 0) }, 0);
        (f, pid, child)
    });
    // No begin_close or live Tokio executor remains to run a newly enqueued
    // cleanup future. This tests emergency signalling, not durable settlement.
    drop(reactor);
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        // Tokio's orphan reaper may have ended with the reactor. Reap only
        // this test's direct child; the grandchild must independently die from
        // the process-group signal (not a test-issued kill).
        let mut status = 0;
        unsafe {
            libc::waitpid(pid, &mut status, libc::WNOHANG);
        }
        if unsafe { libc::kill(pid, 0) } == -1 && unsafe { libc::kill(child, 0) } == -1 {
            break;
        }
        if std::time::Instant::now() >= deadline {
            // A failed regression must not strand its synthetic subprocesses.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
                libc::waitpid(pid, &mut status, 0);
            }
            panic!("reactor shutdown left a synthetic process alive");
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    drop(fixture);
}
