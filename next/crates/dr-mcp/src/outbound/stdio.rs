//! The SDK framing with an explicitly awaited process-tree cleanup.
//! Cleanup starts even if initialization or the outer caller is dropped.
use std::{
    collections::BTreeMap,
    io,
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex},
};

use futures::{
    FutureExt,
    channel::oneshot,
    future::{BoxFuture, Shared},
};
use process_wrap::tokio::{ChildWrapper, CommandWrap};
use rmcp::{
    RoleClient,
    service::{RxJsonRpcMessage, TxJsonRpcMessage},
    transport::{Transport, async_rw::AsyncRwTransport},
};
use tokio::{
    io::AsyncReadExt,
    process::{ChildStdin, ChildStdout, Command},
    runtime::Handle,
};

type Framing = AsyncRwTransport<RoleClient, crate::transport::LineReader<ChildStdout>, ChildStdin>;
type Closed = Shared<BoxFuture<'static, crate::Result<()>>>;

struct Pending {
    child: Box<dyn ChildWrapper>,
    stderr: tokio::task::JoinHandle<()>,
    reply: Option<oneshot::Sender<crate::Result<()>>>,
    signalled: bool,
    settled: bool,
}

impl Pending {
    fn signal(&mut self) -> crate::Result<()> {
        if self.signalled || self.settled {
            return Ok(());
        }
        match self.child.start_kill() {
            Ok(()) => self.signalled = true,
            Err(_) => {
                // A peer that already exited is not a cleanup failure. A
                // successful try_wait also prevents Drop touching its old PGID.
                if self.child.try_wait().is_ok_and(|status| status.is_some()) {
                    self.settled = true;
                } else {
                    return Err("MCP process cleanup failed".into());
                }
            }
        }
        Ok(())
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        // Runtime shutdown can discard an unpolled cleanup worker. Signalling
        // must not depend on that worker or on a live Tokio reactor. On Unix
        // this goes through ProcessGroup, not just the direct child.
        let _ = self.signal();
        self.stderr.abort();
    }
}

pub(super) struct Cleanup {
    pending: Mutex<Option<Pending>>,
    closed: Closed,
    runtime: Handle,
}

impl Cleanup {
    fn start(&self) {
        if let Some(mut pending) = self.pending.lock().expect("MCP process cleanup").take() {
            let signalled = pending.signal();
            self.runtime.spawn(async move {
                let killed = match signalled {
                    Err(error) => Err(error),
                    Ok(()) if pending.settled => Ok(()),
                    Ok(()) => pending
                        .child
                        .wait()
                        .await
                        .map(|_| ())
                        .map_err(|_| "MCP process cleanup failed".to_owned()),
                };
                pending.settled |= killed.is_ok();
                // A descendant must not keep the stderr pipe and cleanup
                // alive after its process tree has been reaped.
                pending.stderr.abort();
                let _ = (&mut pending.stderr).await;
                let reply = pending.reply.take();
                drop(pending);
                if let Some(reply) = reply {
                    let _ = reply.send(killed);
                }
            });
        }
    }
    pub(super) async fn close(&self) -> crate::Result<()> {
        self.start();
        self.closed.clone().await
    }
}

pub(super) struct Process {
    framing: Option<Framing>,
    cleanup: Arc<Cleanup>,
}

impl Drop for Process {
    fn drop(&mut self) {
        self.framing.take();
        self.cleanup.start();
    }
}

pub(super) fn validate(
    command: &str,
    args: &[String],
    cwd: Option<&str>,
    env: &BTreeMap<String, String>,
) -> crate::Result<()> {
    if !Path::new(command).is_absolute() || command.len() > 4096 || command.contains('\0') {
        return Err("MCP stdio command must be an absolute executable path".into());
    }
    if cwd
        .is_some_and(|cwd| !Path::new(cwd).is_absolute() || cwd.len() > 4096 || cwd.contains('\0'))
    {
        return Err("MCP stdio working directory must be absolute".into());
    }
    if args.len() > 256
        || args.iter().map(String::len).sum::<usize>() > 65536
        || args.iter().any(|s| s.contains('\0'))
    {
        return Err("MCP argument limit exceeded".into());
    }
    if env.len() > 64
        || env.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>() > 65536
        || env.iter().any(|(k, v)| {
            k.is_empty()
                || k.len() > 200
                || !k.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
                || v.contains('\0')
        })
    {
        return Err("invalid MCP environment".into());
    }
    Ok(())
}

pub(super) async fn spawn(
    command: &str,
    args: &[String],
    cwd: Option<&str>,
    env: &BTreeMap<String, String>,
    runtime: Handle,
) -> crate::Result<(Process, Arc<Cleanup>)> {
    validate(command, args, cwd, env)?;
    let mut command = Command::new(command);
    command
        .args(args)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(not(windows))]
    let inherited = &["PATH", "HOME", "TMPDIR", "TEMP", "SYSTEMROOT"][..];
    #[cfg(windows)]
    let inherited = &[
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "WINDIR",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "PROGRAMDATA",
    ][..];
    for key in inherited {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command.envs(env);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut command = CommandWrap::from(command);
    #[cfg(unix)]
    command.wrap(process_wrap::tokio::ProcessGroup::leader());
    #[cfg(windows)]
    {
        // JobObject inspects this wrapper to enable KILL_ON_JOB_CLOSE. Unix
        // relies only on Pending's process-group guard so an inner child does
        // not signal a PID already reaped by ProcessGroup::try_wait.
        command.wrap(process_wrap::tokio::KillOnDrop);
        command.wrap(process_wrap::tokio::CreationFlags(
            windows::Win32::System::Threading::CREATE_NO_WINDOW,
        ));
        command.wrap(process_wrap::tokio::JobObject);
    }
    let mut child = command.spawn().map_err(|_| "MCP process could not start")?;
    let pipes = (
        child.stdin().take(),
        child.stdout().take(),
        child.stderr().take(),
    );
    let (Some(stdin), Some(stdout), Some(mut stderr)) = pipes else {
        let _ = Box::into_pin(child.kill()).await;
        return Err("MCP process pipes are unavailable".into());
    };
    let stderr = runtime.spawn(async move {
        // Fixed memory; drain without putting a plugin's raw output (which
        // may contain credentials or manuscript text) in application logs.
        let mut buf = [0; 8192];
        while let Ok(n) = stderr.read(&mut buf).await {
            if n == 0 {
                break;
            }
        }
    });
    let (reply, receive) = oneshot::channel();
    let closed = async {
        receive
            .await
            .unwrap_or_else(|_| Err("MCP cleanup ended early".into()))
    }
    .boxed()
    .shared();
    let cleanup = Arc::new(Cleanup {
        pending: Mutex::new(Some(Pending {
            child,
            stderr,
            reply: Some(reply),
            signalled: false,
            settled: false,
        })),
        closed,
        runtime,
    });
    let framing = AsyncRwTransport::new(
        crate::transport::LineReader::new(stdout, super::http::RESPONSE_LIMIT),
        stdin,
    )
    .with_max_line_length(super::http::RESPONSE_LIMIT);
    Ok((
        Process {
            framing: Some(framing),
            cleanup: cleanup.clone(),
        },
        cleanup,
    ))
}

impl Transport<RoleClient> for Process {
    type Error = io::Error;
    fn send(
        &mut self,
        message: TxJsonRpcMessage<RoleClient>,
    ) -> impl std::future::Future<Output = io::Result<()>> + Send + 'static {
        let valid = serde_json::to_vec(&message)
            .is_ok_and(|bytes| bytes.len() <= super::http::REQUEST_LIMIT);
        let future = self.framing.as_mut().expect("open framing").send(message);
        async move {
            if !valid {
                return Err(io::Error::other("MCP request size limit exceeded"));
            }
            future.await
        }
    }
    async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleClient>> {
        self.framing.as_mut()?.receive().await
    }
    async fn close(&mut self) -> io::Result<()> {
        self.framing.take();
        self.cleanup.close().await.map_err(io::Error::other)
    }
}
