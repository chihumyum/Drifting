//! The executable's headless MCP path: no GUI, app lock or stdout diagnostics.

use crate::{Credential, Result, transport};
use std::path::Path;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt as _, BufReader};

pub fn run(connection: &Path) -> Result<()> {
    let credential = Credential::read_private(connection)?;
    let reactor = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    let result = reactor.block_on(forward(credential, tokio::io::stdin(), tokio::io::stdout()));
    // Tokio's standard-input reader uses an uncancelable blocking read. A
    // revoked/closed app connection must exit even while the MCP client keeps
    // stdin open; Runtime::drop would otherwise wait for that reader forever.
    reactor.shutdown_background();
    result
}

/// Injected pipes exercise the real bridge without using the test runner's
/// stdin/stdout or a real external client's configuration.
pub async fn forward<R, W>(credential: Credential, input: R, output: W) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let stream = tokio::time::timeout(
        transport::HANDSHAKE_TIMEOUT,
        transport::connect(credential.endpoint()),
    )
    .await
    .map_err(|_| "connecting to Drifting timed out".to_owned())??;
    let (read, mut write) = tokio::io::split(stream);
    let mut read = BufReader::new(read);
    let mut auth =
        serde_json::to_vec(&credential).map_err(|_| "invalid connection credential".to_owned())?;
    auth.push(b'\n');
    if auth.len() > transport::HANDSHAKE_LIMIT {
        return Err("connection credential is too large".into());
    }
    tokio::time::timeout(transport::HANDSHAKE_TIMEOUT, write.write_all(&auth))
        .await
        .map_err(|_| "MCP authentication timed out".to_owned())?
        .map_err(|_| "MCP authentication ended".to_owned())?;
    #[derive(serde::Deserialize)]
    struct Ack {
        ok: bool,
    }
    let ack = tokio::time::timeout(
        transport::HANDSHAKE_TIMEOUT,
        transport::read_line(&mut read, transport::HANDSHAKE_LIMIT),
    )
    .await
    .map_err(|_| "MCP authentication timed out".to_owned())?
    .map_err(|_| "invalid MCP authentication reply".to_owned())?
    .ok_or_else(|| "MCP authentication ended".to_owned())?;
    if !serde_json::from_slice::<Ack>(&ack)
        .map_err(|_| "invalid MCP authentication reply".to_owned())?
        .ok
    {
        return Err("MCP access denied; reconnect in Drifting's settings".into());
    }
    let upload = copy_lines(BufReader::new(input), write, transport::REQUEST_LIMIT);
    let download = copy_lines(read, output, transport::RESPONSE_LIMIT);
    // EOF closes the wire. The app cancels its scope and waits for entered
    // workers. The bridge never replays a request whose outcome is unknown.
    tokio::select! {
        result = upload => result,
        result = download => result,
    }
}

async fn copy_lines<R, W>(mut read: R, mut write: W, limit: usize) -> Result<()>
where
    R: tokio::io::AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    while let Some(line) = transport::read_line(&mut read, limit)
        .await
        .map_err(|error| error.to_string())?
    {
        write
            .write_all(&line)
            .await
            .map_err(|error| error.to_string())?;
        write.flush().await.map_err(|error| error.to_string())?;
    }
    write.shutdown().await.map_err(|error| error.to_string())
}
