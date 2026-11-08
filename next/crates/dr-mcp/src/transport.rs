//! Private local transport and bounded newline framing. JSON-RPC itself is
//! handled by rmcp; the only prefix outside that protocol is the v1 credential.

#[cfg(unix)]
use std::path::PathBuf;
use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};

use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
};

use crate::{Endpoint, GrantPaths, Result};

pub const REQUEST_LIMIT: usize = 1024 * 1024;
pub const RESPONSE_LIMIT: usize = 4 * 1024 * 1024;
pub const HANDSHAKE_LIMIT: usize = 4096;
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
pub type LocalStream = Box<dyn Stream>;

/// rmcp deliberately discards oversized input lines and keeps reading. The
/// local boundary instead terminates the connection at its first overrun,
/// including an input that never supplies a newline.
pub(crate) struct LineReader<R> {
    inner: R,
    limit: usize,
    pending: usize,
    failed: bool,
}
impl<R> LineReader<R> {
    pub(crate) fn new(inner: R, limit: usize) -> Self {
        Self {
            inner,
            limit,
            pending: 0,
            failed: false,
        }
    }
}
impl<R: AsyncRead + Unpin> AsyncRead for LineReader<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.failed {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "MCP line is too large",
            )));
        }
        if buffer.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        let start = buffer.filled().len();
        match Pin::new(&mut self.inner).poll_read(cx, buffer) {
            Poll::Ready(Ok(())) => {
                let bytes = &buffer.filled()[start..];
                if bytes.is_empty() && self.pending != 0 {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "incomplete MCP line",
                    )));
                }
                for byte in bytes {
                    self.pending = self.pending.saturating_add(1);
                    if self.pending > self.limit {
                        self.failed = true;
                        buffer.set_filled(start);
                        return Poll::Ready(Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "MCP line is too large",
                        )));
                    }
                    if *byte == b'\n' {
                        self.pending = 0;
                    }
                }
                Poll::Ready(Ok(()))
            }
            result => result,
        }
    }
}

pub enum Listener {
    #[cfg(unix)]
    Unix {
        listener: tokio::net::UnixListener,
        socket: SocketFile,
    },
    Loopback(TcpListener),
}

impl Listener {
    pub async fn bind(paths: &GrantPaths) -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let path = paths.socket_path()?;
            clear_stale_socket(&path).await?;
            let listener = tokio::net::UnixListener::bind(&path)
                .map_err(|error| format!("could not open the local MCP socket: {error}"))?;
            let socket = SocketFile::new(path)?;
            std::fs::set_permissions(&socket.path, std::fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("could not protect the local MCP socket: {error}"))?;
            Ok(Self::Unix { listener, socket })
        }
        #[cfg(not(unix))]
        {
            let _ = paths;
            Self::loopback().await
        }
    }

    /// Available on both platforms so the Windows transport can also be
    /// exercised by the synthetic client tests on macOS.
    pub async fn loopback() -> Result<Self> {
        TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map(Self::Loopback)
            .map_err(|error| format!("could not open the local MCP port: {error}"))
    }

    pub fn endpoint(&self) -> Result<Endpoint> {
        match self {
            #[cfg(unix)]
            Self::Unix { socket, .. } => Ok(Endpoint::Unix(socket.path.clone())),
            Self::Loopback(listener) => listener
                .local_addr()
                .map(Endpoint::Loopback)
                .map_err(|error| error.to_string()),
        }
    }

    pub async fn accept(&self) -> io::Result<LocalStream> {
        match self {
            #[cfg(unix)]
            Self::Unix { listener, .. } => {
                let (stream, _) = listener.accept().await?;
                Ok(Box::new(stream))
            }
            Self::Loopback(listener) => {
                let (stream, peer) = listener.accept().await?;
                if !peer.ip().is_loopback() {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "not loopback",
                    ));
                }
                stream.set_nodelay(true)?;
                Ok(Box::new(stream))
            }
        }
    }
}

pub async fn connect(endpoint: &Endpoint) -> Result<LocalStream> {
    match endpoint {
        Endpoint::Unix(path) => {
            #[cfg(unix)]
            {
                tokio::net::UnixStream::connect(path)
                    .await
                    .map(|stream| Box::new(stream) as LocalStream)
                    .map_err(|_| "Drifting is not listening at this connection's socket".into())
            }
            #[cfg(not(unix))]
            {
                let _ = path;
                Err("Unix sockets are not supported by this build".into())
            }
        }
        Endpoint::Loopback(address) => {
            if !address.ip().is_loopback() || address.port() == 0 {
                return Err("MCP connections must use a local loopback address".into());
            }
            let stream = TcpStream::connect(address).await.map_err(|_| {
                "Drifting is not listening at this connection's local port".to_owned()
            })?;
            stream
                .set_nodelay(true)
                .map_err(|error| error.to_string())?;
            Ok(Box::new(stream))
        }
    }
}

/// No allocation beyond the configured bound, including a peer that never
/// sends a newline. The caller owns cancellation or handshake timeout.
pub async fn read_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let bytes = reader.fill_buf().await?;
        if bytes.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "incomplete MCP line",
                ))
            };
        }
        let end = bytes.iter().position(|byte| *byte == b'\n');
        let count = end.map_or(bytes.len(), |index| index + 1);
        if line.len().saturating_add(count) > limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "MCP line is too large",
            ));
        }
        line.extend_from_slice(&bytes[..count]);
        reader.consume(count);
        if end.is_some() {
            return Ok(Some(line));
        }
    }
}

#[cfg(unix)]
pub struct SocketFile {
    path: PathBuf,
    device: u64,
    inode: u64,
}

#[cfg(unix)]
impl SocketFile {
    fn new(path: PathBuf) -> Result<Self> {
        use std::os::unix::fs::MetadataExt as _;
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        Ok(Self {
            path,
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
}

#[cfg(unix)]
impl Drop for SocketFile {
    fn drop(&mut self) {
        use std::os::unix::fs::MetadataExt as _;
        if std::fs::symlink_metadata(&self.path)
            .is_ok_and(|metadata| metadata.dev() == self.device && metadata.ino() == self.inode)
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(unix)]
async fn clear_stale_socket(path: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::{FileTypeExt as _, MetadataExt as _};
    let old = match std::fs::symlink_metadata(path) {
        Ok(old) => old,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    // SAFETY: geteuid has no arguments or memory preconditions.
    if !old.file_type().is_socket() || old.uid() != unsafe { libc::geteuid() } {
        return Err("the MCP socket path is occupied by another file".into());
    }
    match tokio::time::timeout(
        Duration::from_millis(250),
        tokio::net::UnixStream::connect(path),
    )
    .await
    {
        Ok(Err(error))
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
            ) => {}
        _ => return Err("another MCP listener is already using this socket".into()),
    }
    let current = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if current.dev() != old.dev() || current.ino() != old.ino() {
        return Err("the MCP socket changed while opening it".into());
    }
    std::fs::remove_file(path).map_err(|error| error.to_string())
}
