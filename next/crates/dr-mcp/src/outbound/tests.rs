use std::{sync::Arc, time::Duration};

use dr_agent::{Event, State, ToolExecutor, events};
use futures::{FutureExt, channel::oneshot};

use super::{Status, storage, tracked};

// Exercise the same real Runtime, local HTTP peer and seed library as the
// public-facade acceptance, with access only to a private cleanup ACK seam.
#[allow(dead_code)]
mod support {
    use crate as dr_mcp;
    use dr_agent::State;
    include!("../../tests/support/outbound.rs");
}
use support::{Behavior, Fixture, Server, call, draft, finish, permission, until};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn call_cleanup_failure_preserves_unknown_outcome_and_invalidates_catalog() {
    cleanup_failure(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn call_cleanup_and_status_failure_still_invalidates_catalog() {
    cleanup_failure(true).await;
}

async fn cleanup_failure(remove_configuration: bool) {
    const PRIVATE_DETAIL: &str = "synthetic private cleanup payload";
    let fixture = Fixture::new();
    let server = Server::new().await;
    let book = fixture.book.to_string();
    let info = fixture
        .manager
        .save(book.clone(), draft(&server.url, "cleanup-failure"))
        .await
        .unwrap();
    fixture.manager.activate(Some(book.clone())).await.unwrap();
    let watch = fixture.manager.watch();
    let slot = fixture.manager.slot(&book, &info.id).unwrap();
    let (entered, cleanup_started) = oneshot::channel();
    let (release, cleanup_released) = oneshot::channel();
    slot.connection.lock().await.as_mut().unwrap().cleanup = Arc::new(tracked::Closed::injected(
        async move {
            let _ = entered.send(());
            cleanup_released.await.unwrap();
            Err(PRIVATE_DETAIL.into())
        }
        .boxed(),
    ));
    // The peer really receives the call, then fails with an expired session.
    // The SDK must not reinitialize or replay it. Cleanup is separately failed.
    server.behavior(Behavior {
        hold: true,
        expire: true,
        ..Default::default()
    });
    let request = call(&info, &fixture.text);
    let approved_revision = fixture.tools.describe(&request).unwrap().revision;
    let (runtime, run) = fixture.start(fixture.book.clone(), request.clone());
    let session = run.session.clone();
    let approval = permission(&fixture, &run).await;
    run.control.permit(approval, true).await.unwrap();
    until(|| server.calls() == 1).await;
    if remove_configuration {
        // A competing local removal makes the later Failed status CAS reject.
        // Keep the live slot to check that failed durability cannot restore it.
        storage::remove(fixture.ws.library(), &book, &info.id, &info.revision).unwrap();
    }
    server.release();
    tokio::time::timeout(Duration::from_secs(10), cleanup_started)
        .await
        .unwrap()
        .unwrap();

    // Invalidation precedes even the completion of a failing cleanup ACK.
    assert!(matches!(
        watch.borrow().servers[0].status,
        Status::Failed { .. }
    ));
    assert_eq!(
        fixture.manager.search(&book, "", None, 10)["tools"][0]["available"],
        false
    );
    assert!(
        fixture
            .manager
            .descriptor(&info.id, &info.tools[0].name, &approved_revision)
            .is_none()
    );
    assert_ne!(
        fixture.tools.describe(&request).unwrap().revision,
        approved_revision
    );
    release.send(()).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), finish(runtime, run))
            .await
            .unwrap(),
        State::Completed
    );

    let report = events(fixture.ws.library(), &session, 0)
        .unwrap()
        .into_iter()
        .find_map(|event| match event.event {
            Event::ToolFinished { result } => Some(result.output.to_string()),
            _ => None,
        })
        .unwrap();
    assert!(report.contains("remote outcome is unknown"), "{report}");
    assert!(report.contains("MCP connection cleanup failed"), "{report}");
    assert!(!report.contains(PRIVATE_DETAIL));
    assert_eq!(
        report.contains("MCP failure status could not be saved"),
        remove_configuration
    );
    let snapshot = fixture.manager.snapshot();
    let Status::Failed { message } = &snapshot.servers[0].status else {
        panic!("failed call still appears available");
    };
    assert!(message.contains("remote outcome is unknown"));
    assert!(message.contains("MCP connection cleanup failed"));
    assert!(!message.contains(PRIVATE_DETAIL));
    assert!(slot.connection.lock().await.is_none());
    match storage::read(fixture.ws.library(), &book, &info.id).unwrap() {
        Some(record) => {
            assert!(!remove_configuration);
            assert_eq!(record.info.status, snapshot.servers[0].status);
        }
        None => assert!(remove_configuration),
    }
    assert_eq!(server.calls(), 1);
    assert_eq!(
        server
            .requests()
            .iter()
            .filter(|request| request["method"] == "initialize")
            .count(),
        1
    );
    fixture.shutdown().await;
    server.close().await;
}
