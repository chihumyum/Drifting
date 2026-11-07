//! One running copy per user.
//!
//! - **macOS**: Launch Services already keeps one copy of a bundle running
//!   and sends a second launch's links to the first through
//!   `on_open_urls`, so every process is the primary. (`cargo run` outside a
//!   bundle may start several; that is a development convenience.)
//! - **Windows**: the first process holds a named mutex,
//!   `Local\<instance name>.instance` (the bundle id, plus the development
//!   profile when there is one). A later one finds it taken, sends its
//!   arguments over a named pipe, `\\.\pipe\<instance name>.instance.<session>`,
//!   lets the first take the foreground, and exits. The primary reads each
//!   message on a background thread and hands the arguments on (to
//!   `DeepLinks::push_args`, which keeps only our links).
//!
//! The pipe takes local clients only, uses the default security descriptor
//! (only this user, administrators and SYSTEM may write), and is created with
//! `FILE_FLAG_FIRST_PIPE_INSTANCE`, so another process cannot squat on the
//! name ahead of the primary. Messages are bounded JSON:
//! `{"drifting.instance":1,"args":[…]}`.
//!
//! Headless launches must not come here: `drifting --mcp --connection <file>`
//! (the external-Agent contract, simplifications.md item 15) is routed in
//! `main` before this, or it would be forwarded to the window and exit.
//!
//! The idea follows Zed's `windows_only_instance.rs`; that file is GPL, so
//! nothing was copied. Only `cargo check --target x86_64-pc-windows-msvc`
//! runs on a Mac; the CI Windows job runs the tests.

// The message format is tested everywhere; only Windows sends it.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::{Deserialize, Serialize};

use crate::identity::Identity;

pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MESSAGE_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct Message {
    #[serde(rename = "drifting.instance")]
    version: u32,
    args: Vec<String>,
}

pub(crate) fn encode(args: &[String]) -> Option<Vec<u8>> {
    let bytes = serde_json::to_vec(&Message {
        version: MESSAGE_VERSION,
        args: args.to_vec(),
    })
    .ok()?;
    (bytes.len() <= MAX_MESSAGE_BYTES).then_some(bytes)
}

pub(crate) fn decode(bytes: &[u8]) -> Option<Vec<String>> {
    if bytes.len() > MAX_MESSAGE_BYTES {
        return None;
    }
    let message: Message = serde_json::from_slice(bytes).ok()?;
    (message.version == MESSAGE_VERSION).then_some(message.args)
}

pub enum Instance {
    /// Carry on starting up.
    Primary(Primary),
    /// Another copy is running and has these arguments; exit now.
    Forwarded,
    /// Another copy is running but did not take the message; exit anyway
    /// rather than open a second window on the same library.
    ForwardFailed,
}

impl Instance {
    pub fn primary(self) -> Option<Primary> {
        match self {
            Self::Primary(primary) => Some(primary),
            Self::Forwarded | Self::ForwardFailed => None,
        }
    }
}

/// The primary's side: call `listen` once the app can take arguments.
pub struct Primary {
    #[cfg(windows)]
    pipe: windows_impl::PipeName,
}

impl Primary {
    /// Delivers each later launch's arguments to `on_args`, on a background
    /// thread. Does nothing on macOS, where links arrive through GPUI.
    pub fn listen(self, on_args: impl Fn(Vec<String>) + Send + 'static) {
        #[cfg(windows)]
        windows_impl::listen(self.pipe, on_args);
        #[cfg(not(windows))]
        drop(on_args);
    }
}

/// Becomes the primary, or forwards `args` (without the program name) to it.
pub fn acquire(identity: &Identity, args: &[String]) -> Instance {
    #[cfg(windows)]
    {
        windows_impl::acquire(identity, args)
    }
    #[cfg(not(windows))]
    {
        let _ = (identity, args);
        Instance::Primary(Primary {})
    }
}

#[cfg(windows)]
mod windows_impl {
    use std::sync::OnceLock;

    use windows::Win32::Foundation::{
        CloseHandle, ERROR_ALREADY_EXISTS, ERROR_MORE_DATA, ERROR_PIPE_CONNECTED, GENERIC_WRITE,
        GetLastError, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_NONE,
        OPEN_EXISTING, PIPE_ACCESS_INBOUND, ReadFile, WriteFile,
    };
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_MESSAGE,
        PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_MESSAGE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
        WaitNamedPipeW,
    };
    use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
    use windows::Win32::System::Threading::{CreateMutexW, GetCurrentProcessId};
    use windows::Win32::UI::WindowsAndMessaging::{ASFW_ANY, AllowSetForegroundWindow};
    use windows::core::PCWSTR;

    use super::{Instance, MAX_MESSAGE_BYTES, Primary, decode, encode};
    use crate::identity::Identity;

    /// The mutex lives as long as the process; the OS releases it on exit.
    static MUTEX: OnceLock<isize> = OnceLock::new();

    pub(super) struct PipeName(Vec<u16>);

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    fn pipe_name(identity: &Identity) -> PipeName {
        let mut session = 0_u32;
        // SAFETY: `session` is a valid out-pointer.
        let _ = unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) };
        PipeName(wide(&format!(
            r"\\.\pipe\{}.instance.{session}",
            identity.instance_name()
        )))
    }

    pub(super) fn acquire(identity: &Identity, args: &[String]) -> Instance {
        let name = wide(&format!(r"Local\{}.instance", identity.instance_name()));
        // SAFETY: `name` is NUL-terminated and outlives the call.
        let mutex = unsafe { CreateMutexW(None, true, PCWSTR::from_raw(name.as_ptr())) };
        // SAFETY: reads this thread's last error right after the call.
        let already = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        match mutex {
            Ok(handle) if !already => {
                let _ = MUTEX.set(handle.0 as isize);
                Instance::Primary(Primary {
                    pipe: pipe_name(identity),
                })
            }
            Ok(handle) => {
                // SAFETY: our own handle to the existing mutex.
                let _ = unsafe { CloseHandle(handle) };
                forward(&pipe_name(identity), args)
            }
            // Without a mutex there is no way to tell; carry on alone.
            Err(_) => Instance::Primary(Primary {
                pipe: pipe_name(identity),
            }),
        }
    }

    fn forward(pipe: &PipeName, args: &[String]) -> Instance {
        let Some(message) = encode(args) else {
            return Instance::ForwardFailed;
        };
        // Let the primary bring its window forward; this process got the
        // foreground from the user's click.
        // SAFETY: no pointers involved.
        let _ = unsafe { AllowSetForegroundWindow(ASFW_ANY) };
        // The primary may be between two pipe instances, or still starting.
        for _ in 0..20 {
            // SAFETY: the name is NUL-terminated and outlives the calls; the
            // handle is closed below.
            unsafe {
                if let Ok(handle) = CreateFileW(
                    PCWSTR::from_raw(pipe.0.as_ptr()),
                    GENERIC_WRITE.0,
                    FILE_SHARE_NONE,
                    None,
                    OPEN_EXISTING,
                    FILE_FLAGS_AND_ATTRIBUTES(0),
                    None,
                ) {
                    let mut written = 0_u32;
                    let sent = WriteFile(handle, Some(&message), Some(&mut written), None).is_ok()
                        && written as usize == message.len();
                    let _ = CloseHandle(handle);
                    return if sent {
                        Instance::Forwarded
                    } else {
                        Instance::ForwardFailed
                    };
                }
                let _ = WaitNamedPipeW(PCWSTR::from_raw(pipe.0.as_ptr()), 100);
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        Instance::ForwardFailed
    }

    pub(super) fn listen(pipe: PipeName, on_args: impl Fn(Vec<String>) + Send + 'static) {
        let spawned = std::thread::Builder::new()
            .name("single-instance".into())
            .spawn(move || {
                let mut first = true;
                loop {
                    let mode = if first {
                        PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE
                    } else {
                        PIPE_ACCESS_INBOUND
                    };
                    // SAFETY: the name is NUL-terminated and outlives the call.
                    let handle = unsafe {
                        CreateNamedPipeW(
                            PCWSTR::from_raw(pipe.0.as_ptr()),
                            mode,
                            PIPE_TYPE_MESSAGE
                                | PIPE_READMODE_MESSAGE
                                | PIPE_WAIT
                                | PIPE_REJECT_REMOTE_CLIENTS,
                            PIPE_UNLIMITED_INSTANCES,
                            0,
                            MAX_MESSAGE_BYTES as u32,
                            0,
                            None,
                        )
                    };
                    if handle == INVALID_HANDLE_VALUE || handle.is_invalid() {
                        tracing::warn!("single-instance pipe could not be created");
                        return;
                    }
                    first = false;
                    if let Some(args) = receive(handle).and_then(|bytes| decode(&bytes)) {
                        on_args(args);
                    }
                    // SAFETY: our own pipe handle.
                    unsafe {
                        let _ = DisconnectNamedPipe(handle);
                        let _ = CloseHandle(handle);
                    }
                }
            });
        if spawned.is_err() {
            tracing::warn!("single-instance listener could not start");
        }
    }

    /// One message, at most `MAX_MESSAGE_BYTES`.
    fn receive(handle: HANDLE) -> Option<Vec<u8>> {
        // SAFETY: `handle` is a valid pipe; the client may connect first.
        let connected = unsafe { ConnectNamedPipe(handle, None) };
        if let Err(error) = connected
            && error.code() != ERROR_PIPE_CONNECTED.to_hresult()
        {
            return None;
        }
        let mut message = Vec::new();
        let mut buffer = vec![0_u8; 16 * 1024];
        loop {
            let mut read = 0_u32;
            // SAFETY: `buffer` is valid for its length; `read` is an out-pointer.
            let result = unsafe { ReadFile(handle, Some(&mut buffer), Some(&mut read), None) };
            message.extend_from_slice(&buffer[..read as usize]);
            if message.len() > MAX_MESSAGE_BYTES {
                return None;
            }
            match result {
                Ok(()) => return Some(message),
                Err(error) if error.code() == ERROR_MORE_DATA.to_hresult() => continue,
                Err(_) => return None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_round_trip_and_reject_anything_else() {
        let args = vec!["drifting://open/a".to_owned(), "--flag".to_owned()];
        assert_eq!(decode(&encode(&args).unwrap()), Some(args));
        assert_eq!(decode(b"not json"), None);
        assert_eq!(decode(br#"{"drifting.instance":2,"args":[]}"#), None);
        assert_eq!(decode(br#"{"args":["x"]}"#), None);
        assert!(encode(&["x".repeat(MAX_MESSAGE_BYTES)]).is_none());
    }

    #[cfg(not(windows))]
    #[test]
    fn every_process_is_the_primary_outside_windows() {
        assert!(
            acquire(&crate::identity::DEVELOPMENT, &[])
                .primary()
                .is_some()
        );
    }
}
