//! The byte stream (a Unix socket, or loopback TCP on Windows) and the
//! blocking client.
//!
//! Windows listens on `127.0.0.1` with a port the system picks, written into
//! the connection file. The design named a named pipe; loopback TCP needs
//! nothing beyond std, and the token keeps other local programs out the same
//! way (f8-testkit.md 「调试桥」).

use std::io::{BufRead, BufReader, Read, Write};
use std::time::Duration;

use serde_json::Value;

use crate::PROTOCOL;
use crate::place::{Connection, Paths};
use crate::wire::{BridgeError, Hello, Request, Response, codes};

/// One connection's bytes.
pub enum Stream {
    #[cfg(unix)]
    Unix(std::os::unix::net::UnixStream),
    Tcp(std::net::TcpStream),
}

impl Stream {
    /// Connects to a connection file's address.
    pub fn connect(address: &str) -> std::io::Result<Stream> {
        #[cfg(unix)]
        if address.starts_with('/') {
            return std::os::unix::net::UnixStream::connect(address).map(Stream::Unix);
        }
        std::net::TcpStream::connect(address).map(Stream::Tcp)
    }

    pub fn try_clone(&self) -> std::io::Result<Stream> {
        match self {
            #[cfg(unix)]
            Stream::Unix(s) => s.try_clone().map(Stream::Unix),
            Stream::Tcp(s) => s.try_clone().map(Stream::Tcp),
        }
    }

    pub fn set_read_timeout(&self, t: Option<Duration>) -> std::io::Result<()> {
        match self {
            #[cfg(unix)]
            Stream::Unix(s) => s.set_read_timeout(t),
            Stream::Tcp(s) => s.set_read_timeout(t),
        }
    }

    pub fn shutdown(&self) {
        let _ = match self {
            #[cfg(unix)]
            Stream::Unix(s) => s.shutdown(std::net::Shutdown::Both),
            Stream::Tcp(s) => s.shutdown(std::net::Shutdown::Both),
        };
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            #[cfg(unix)]
            Stream::Unix(s) => s.read(buf),
            Stream::Tcp(s) => s.read(buf),
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            #[cfg(unix)]
            Stream::Unix(s) => s.write(buf),
            Stream::Tcp(s) => s.write(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            #[cfg(unix)]
            Stream::Unix(s) => s.flush(),
            Stream::Tcp(s) => s.flush(),
        }
    }
}

/// Writes one message and its newline.
pub fn send(w: &mut impl Write, v: &impl serde::Serialize) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(v).map_err(std::io::Error::other)?;
    line.push(b'\n');
    w.write_all(&line)?;
    w.flush()
}

/// Reads one message; `None` at the end of the stream.
pub fn receive<T: serde::de::DeserializeOwned>(
    r: &mut impl BufRead,
) -> Result<Option<T>, BridgeError> {
    let mut line = String::new();
    let n = r.read_line(&mut line).map_err(|e| {
        if matches!(
            e.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ) {
            BridgeError::new(codes::TIMEOUT, "no answer in time")
        } else {
            BridgeError::new(codes::IO, e.to_string())
        }
    })?;
    if n == 0 {
        return Ok(None);
    }
    serde_json::from_str(&line)
        .map(Some)
        .map_err(|e| BridgeError::new(codes::BAD_REQUEST, format!("not a message: {e}")))
}

/// A blocking connection to a running app's bridge.
pub struct Client {
    reader: BufReader<Stream>,
    writer: Stream,
    next: u64,
    /// What the app said when it let us in (instance, pid, version).
    pub hello: Hello,
}

impl Client {
    /// Reads the instance's connection file and connects.
    pub fn open(paths: &Paths) -> Result<Client, BridgeError> {
        Client::connect(&Connection::read(&paths.connection)?)
    }

    pub fn connect(c: &Connection) -> Result<Client, BridgeError> {
        let stream = Stream::connect(&c.address).map_err(|e| {
            BridgeError::new(
                codes::NOT_RUNNING,
                format!(
                    "nothing listens at {} (pid {}; the app quit without removing its connection file?): {e}",
                    c.address, c.pid
                ),
            )
        })?;
        let mut writer = stream
            .try_clone()
            .map_err(|e| BridgeError::new(codes::IO, e.to_string()))?;
        let mut reader = BufReader::new(stream);
        send(
            &mut writer,
            &Hello {
                hello: PROTOCOL.into(),
                token: Some(c.token.clone()),
                instance: None,
                pid: None,
                version: None,
            },
        )
        .map_err(|e| BridgeError::new(codes::IO, e.to_string()))?;
        let reply: Value = receive(&mut reader)?.ok_or_else(|| {
            BridgeError::new(codes::UNAUTHORIZED, "the app closed the connection")
        })?;
        if let Some(e) = reply.get("error") {
            let e: BridgeError = serde_json::from_value(e.clone())
                .unwrap_or_else(|_| BridgeError::new(codes::UNAUTHORIZED, e.to_string()));
            return Err(e);
        }
        let hello: Hello = serde_json::from_value(reply)
            .map_err(|e| BridgeError::new(codes::BAD_REQUEST, e.to_string()))?;
        if hello.hello != PROTOCOL {
            return Err(BridgeError::new(
                codes::BAD_REQUEST,
                format!("the app speaks {}, this client {PROTOCOL}", hello.hello),
            ));
        }
        Ok(Client {
            reader,
            writer,
            next: 1,
            hello,
        })
    }

    /// How long one call may wait for its answer (`None`: forever).
    pub fn set_timeout(&mut self, t: Option<Duration>) {
        let _ = self.reader.get_ref().set_read_timeout(t);
    }

    /// Calls `method` and waits for its answer.
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, BridgeError> {
        let id = self.next;
        self.next += 1;
        send(
            &mut self.writer,
            &Request {
                id,
                method: method.into(),
                params,
            },
        )
        .map_err(|e| BridgeError::new(codes::IO, e.to_string()))?;
        loop {
            let r: Response = receive(&mut self.reader)?
                .ok_or_else(|| BridgeError::new(codes::IO, "the app closed the connection"))?;
            if r.id == id {
                return r.into_result();
            }
        }
    }
}
