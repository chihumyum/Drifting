//! The actual executable takes its headless branch before any desktop service.
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[test]
fn remote_eof_exits_even_while_the_clients_standard_input_stays_open() {
    let directory = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let connection = directory.path().join("connection.json");
    let bytes = serde_json::to_vec(&serde_json::json!({"version":1,"socketPath":listener.local_addr().unwrap().to_string(),"connectionId":"synthetic-bridge","token":"synthetic-local-only-credential"})).unwrap();
    std::fs::write(&connection, bytes).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&connection, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut socket = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "headless bridge did not connect");
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("synthetic listener failed: {error}"),
            }
        };
        socket.set_nonblocking(false).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut line = String::new();
        BufReader::new(socket.try_clone().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(&line).unwrap()["token"].is_string());
        socket.write_all(b"{\"ok\":true}\n").unwrap();
        // Let the bridge enter its real stdio read before closing the peer.
        std::thread::sleep(Duration::from_millis(100));
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_drifting"))
        .args(["--mcp", "--connection"])
        .arg(connection)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let input = child.stdin.take().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("MCP bridge waited for client stdin after remote EOF");
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    drop(input);
    server.join().unwrap();
    let mut output = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    assert!(status.success());
    assert!(
        output.is_empty(),
        "headless MCP emitted non-protocol stdout"
    );
}
