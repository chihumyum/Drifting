//! The listening half, without GPUI: a thread accepts connections, each
//! connection gets a thread that checks the token, reads requests one at a
//! time and hands each to the callback with a [`Reply`]; the thread waits
//! for the reply and writes it. The callback decides where the work runs
//! (dr-debug-bridge sends it to GPUI's main thread).

use std::io::BufReader;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::Value;

use crate::PROTOCOL;
use crate::place::{Connection, Paths};
use crate::transport::{Stream, receive, send};
use crate::wire::{BridgeError, Hello, Request, Response, codes};

/// Answers one request; call it exactly once, from any thread.
pub type Reply = Box<dyn FnOnce(Result<Value, BridgeError>) + Send>;

/// How long a new connection has to say hello.
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

/// A listening bridge. [`Server::close`] removes its connection file and
/// socket; dropping it leaves them (the app removes them when it quits).
pub struct Server {
    pub connection: Connection,
    paths: Paths,
    closed: Arc<AtomicBool>,
}

enum Listener {
    #[cfg(unix)]
    Unix(std::os::unix::net::UnixListener),
    #[cfg(not(unix))]
    Tcp(std::net::TcpListener),
}

impl Listener {
    fn accept(&self) -> std::io::Result<Stream> {
        match self {
            #[cfg(unix)]
            Listener::Unix(l) => l.accept().map(|(s, _)| Stream::Unix(s)),
            #[cfg(not(unix))]
            Listener::Tcp(l) => l.accept().map(|(s, _)| Stream::Tcp(s)),
        }
    }
}

fn io(e: impl std::fmt::Display) -> BridgeError {
    BridgeError::new(codes::IO, e.to_string())
}

#[cfg(unix)]
fn bind(paths: &Paths) -> Result<(Listener, String), BridgeError> {
    use std::os::unix::fs::PermissionsExt;
    let path = &paths.socket;
    if path.as_os_str().len() >= crate::place::MAX_SOCKET_PATH {
        return Err(io(format!(
            "{} is too long for a Unix socket",
            path.display()
        )));
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(io)?;
    }
    // One instance runs at a time (dr-platform's lock): a socket left here
    // is a quit that never cleaned up.
    let _ = std::fs::remove_file(path);
    let l = std::os::unix::net::UnixListener::bind(path).map_err(io)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(io)?;
    Ok((Listener::Unix(l), path.to_string_lossy().into_owned()))
}

#[cfg(not(unix))]
fn bind(_: &Paths) -> Result<(Listener, String), BridgeError> {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(io)?;
    let address = l.local_addr().map_err(io)?.to_string();
    Ok((Listener::Tcp(l), address))
}

/// Starts listening for `instance` and writes its connection file.
pub fn listen(
    paths: &Paths,
    instance: &str,
    version: &str,
    token: &str,
    handler: impl Fn(Request, Reply) + Send + Sync + 'static,
) -> Result<Server, BridgeError> {
    let (listener, address) = bind(paths)?;
    let connection = Connection {
        protocol: PROTOCOL.into(),
        instance: instance.into(),
        pid: std::process::id(),
        version: version.into(),
        address,
        token: token.into(),
    };
    connection.write(&paths.connection).map_err(io)?;
    let closed = Arc::new(AtomicBool::new(false));
    let handler: Arc<dyn Fn(Request, Reply) + Send + Sync> = Arc::new(handler);
    let hello = Hello {
        hello: PROTOCOL.into(),
        token: None,
        instance: Some(instance.into()),
        pid: Some(connection.pid),
        version: Some(version.into()),
    };
    let (token, stop) = (token.to_owned(), closed.clone());
    std::thread::Builder::new()
        .name("debug-bridge".into())
        .spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let Ok(stream) = listener.accept() else {
                    continue;
                };
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let (handler, token, hello) = (handler.clone(), token.clone(), hello.clone());
                let _ = std::thread::Builder::new()
                    .name("debug-bridge-connection".into())
                    .spawn(move || serve(stream, &token, &hello, handler.as_ref()));
            }
        })
        .map_err(io)?;
    Ok(Server {
        connection,
        paths: paths.clone(),
        closed,
    })
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

fn serve(
    stream: Stream,
    token: &str,
    hello: &Hello,
    handler: &(dyn Fn(Request, Reply) + Send + Sync),
) {
    let Ok(mut writer) = stream.try_clone() else {
        return;
    };
    let _ = stream.set_read_timeout(Some(HELLO_TIMEOUT));
    let mut reader = BufReader::new(stream);
    let theirs: Option<Hello> = receive(&mut reader).ok().flatten();
    let welcome = theirs
        .is_some_and(|h| h.hello == PROTOCOL && h.token.as_deref().is_some_and(|t| same(t, token)));
    if !welcome {
        let _ = send(
            &mut writer,
            &serde_json::json!({ "error": BridgeError::new(codes::UNAUTHORIZED, "wrong protocol or token") }),
        );
        writer.shutdown();
        return;
    }
    if send(&mut writer, hello).is_err() {
        return;
    }
    let _ = reader.get_ref().set_read_timeout(None);
    loop {
        let request: Request = match receive(&mut reader) {
            Ok(Some(r)) => r,
            Ok(None) => return,
            Err(e) if e.code == codes::IO => return,
            Err(e) => {
                if send(&mut writer, &Response::of(0, Err(e))).is_err() {
                    return;
                }
                continue;
            }
        };
        let id = request.id;
        let (tx, rx) = std::sync::mpsc::channel();
        handler(
            request,
            Box::new(move |r| {
                let _ = tx.send(r);
            }),
        );
        let outcome = rx
            .recv()
            .unwrap_or_else(|_| Err(BridgeError::new(codes::IO, "the app dropped the request")));
        if send(&mut writer, &Response::of(id, outcome)).is_err() {
            return;
        }
    }
}

impl Server {
    /// Stops taking connections and removes the connection file (if it is
    /// still ours) and the socket.
    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        if Connection::read(&self.paths.connection).is_ok_and(|c| c.token == self.connection.token)
        {
            let _ = std::fs::remove_file(&self.paths.connection);
        }
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.paths.socket);
        // Wake the accepting thread so it sees the flag.
        let _ = Stream::connect(&self.connection.address);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::Client;
    use serde_json::json;

    fn echo(dir: &std::path::Path) -> Server {
        listen(
            &Paths::under(dir),
            "test.instance",
            "9.9.9",
            "tok",
            |req, reply| {
                std::thread::spawn(move || match req.method.as_str() {
                    "echo" => reply(Ok(req.params)),
                    _ => reply(Err(BridgeError::new(codes::UNKNOWN_METHOD, req.method))),
                });
            },
        )
        .unwrap()
    }

    #[test]
    fn a_client_with_the_token_is_answered() {
        let dir = tempfile::tempdir().unwrap();
        let server = echo(dir.path());
        let mut c = Client::open(&Paths::under(dir.path())).unwrap();
        assert_eq!(c.hello.instance.as_deref(), Some("test.instance"));
        assert_eq!(c.hello.version.as_deref(), Some("9.9.9"));
        assert_eq!(
            c.call("echo", json!({"a": [1, "二"]})).unwrap(),
            json!({"a": [1, "二"]})
        );
        let e = c.call("nope", Value::Null).unwrap_err();
        assert_eq!(e.code, codes::UNKNOWN_METHOD);
        // A second client at the same time.
        let mut d = Client::open(&Paths::under(dir.path())).unwrap();
        assert_eq!(d.call("echo", json!(2)).unwrap(), json!(2));
        assert_eq!(c.call("echo", json!(3)).unwrap(), json!(3));
        server.close();
        assert!(!dir.path().join(crate::place::CONNECTION_FILE).exists());
        assert_eq!(
            Client::open(&Paths::under(dir.path())).err().unwrap().code,
            codes::NOT_RUNNING
        );
    }

    #[test]
    fn a_wrong_token_is_turned_away() {
        let dir = tempfile::tempdir().unwrap();
        let server = echo(dir.path());
        let mut forged = server.connection.clone();
        forged.token = "tak".into();
        assert_eq!(
            Client::connect(&forged).err().unwrap().code,
            codes::UNAUTHORIZED
        );
        server.close();
    }
}
