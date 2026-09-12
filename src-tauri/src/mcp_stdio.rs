use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;

const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_STDERR_LINES: usize = 200;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioStartInput {
    process_id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: HashMap<String, String>,
    config_revision: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioStartResult {
    process_id: String,
    pid: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioRequestInput {
    process_id: String,
    request_id: String,
    message: String,
    timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioNotifyInput {
    process_id: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioStatusResult {
    process_id: String,
    running: bool,
    pid: Option<u32>,
    config_revision: Option<String>,
    fatal_error: Option<String>,
    stderr_lines: Vec<String>,
}

#[cfg(desktop)]
mod desktop {
    use super::*;
    use std::collections::VecDeque;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::path::Path;
    use std::process::{Child, ChildStdin, Command, Stdio};
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::Duration;

    type PendingResult = Result<String, String>;

    pub struct ProcessEntry {
        pub child: Mutex<Child>,
        pub stdin: Mutex<ChildStdin>,
        pub pending: Arc<Mutex<HashMap<String, mpsc::Sender<PendingResult>>>>,
        pub fatal: Arc<Mutex<Option<String>>>,
        pub stderr: Arc<Mutex<VecDeque<String>>>,
        pub pid: u32,
        pub config_revision: String,
    }

    #[derive(Default)]
    pub struct McpStdioState {
        pub processes: Mutex<HashMap<String, Arc<ProcessEntry>>>,
    }

    impl Drop for McpStdioState {
        fn drop(&mut self) {
            if let Ok(mut processes) = self.processes.lock() {
                for (_, entry) in processes.drain() {
                    if let Ok(mut child) = entry.child.lock() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    fail_pending(&entry, "MCP stdio host stopped");
                }
            }
        }
    }

    pub fn start(
        state: &McpStdioState,
        input: McpStdioStartInput,
    ) -> Result<McpStdioStartResult, String> {
        validate_start(&input)?;
        {
            let processes = state
                .processes
                .lock()
                .map_err(|_| "MCP stdio state poisoned")?;
            if processes.contains_key(&input.process_id) {
                return Err("MCP stdio process id is already active".into());
            }
        }

        let mut command = Command::new(&input.command);
        command
            .args(&input.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear();
        for key in ["PATH", "HOME", "TMPDIR", "TEMP", "SYSTEMROOT"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command.envs(&input.env);
        if let Some(cwd) = &input.cwd {
            command.current_dir(cwd);
        }
        let mut child = command
            .spawn()
            .map_err(|_| "MCP stdio executable could not be started".to_string())?;
        let pid = child.id();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "MCP stdio stdin is unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "MCP stdio stdout is unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "MCP stdio stderr is unavailable".to_string())?;

        let entry = Arc::new(ProcessEntry {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending: Arc::new(Mutex::new(HashMap::new())),
            fatal: Arc::new(Mutex::new(None)),
            stderr: Arc::new(Mutex::new(VecDeque::new())),
            pid,
            config_revision: input.config_revision.clone(),
        });
        spawn_stdout_reader(entry.clone(), stdout);
        spawn_stderr_reader(entry.clone(), stderr);
        state
            .processes
            .lock()
            .map_err(|_| "MCP stdio state poisoned")?
            .insert(input.process_id.clone(), entry);
        Ok(McpStdioStartResult {
            process_id: input.process_id,
            pid,
        })
    }

    pub async fn request(
        state: &McpStdioState,
        input: McpStdioRequestInput,
    ) -> Result<String, String> {
        validate_request(&input)?;
        let entry = state
            .processes
            .lock()
            .map_err(|_| "MCP stdio state poisoned")?
            .get(&input.process_id)
            .cloned()
            .ok_or_else(|| "MCP stdio process is not active".to_string())?;
        if let Some(error) = entry
            .fatal
            .lock()
            .map_err(|_| "MCP stdio state poisoned")?
            .clone()
        {
            return Err(error);
        }
        {
            let child_done = entry
                .child
                .lock()
                .map_err(|_| "MCP stdio child state poisoned")?
                .try_wait()
                .map_err(|_| "MCP stdio process status failed")?
                .is_some();
            if child_done {
                return Err("MCP stdio process exited".into());
            }
        }

        let (sender, receiver) = mpsc::channel();
        {
            let mut pending = entry
                .pending
                .lock()
                .map_err(|_| "MCP stdio state poisoned")?;
            if pending.insert(input.request_id.clone(), sender).is_some() {
                return Err("MCP stdio request id is already pending".into());
            }
        }
        let write_result = (|| -> Result<(), String> {
            let mut stdin = entry.stdin.lock().map_err(|_| "MCP stdio stdin poisoned")?;
            stdin
                .write_all(input.message.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush())
                .map_err(|_| "MCP stdio request write failed".to_string())
        })();
        if let Err(error) = write_result {
            if let Ok(mut pending) = entry.pending.lock() {
                pending.remove(&input.request_id);
            }
            return Err(error);
        }

        let request_id = input.request_id.clone();
        let pending = entry.pending.clone();
        let timeout = Duration::from_millis(input.timeout_ms);
        let result = tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(timeout))
            .await
            .map_err(|_| "MCP stdio response wait failed".to_string())?;
        match result {
            Ok(value) => value,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Ok(mut map) = pending.lock() {
                    map.remove(&request_id);
                }
                Err("MCP stdio request timed out".into())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("MCP stdio process disconnected".into())
            }
        }
    }

    pub fn notify(state: &McpStdioState, input: McpStdioNotifyInput) -> Result<(), String> {
        validate_notification(&input)?;
        let entry = state
            .processes
            .lock()
            .map_err(|_| "MCP stdio state poisoned")?
            .get(&input.process_id)
            .cloned()
            .ok_or_else(|| "MCP stdio process is not active".to_string())?;
        if let Some(error) = entry
            .fatal
            .lock()
            .map_err(|_| "MCP stdio state poisoned")?
            .clone()
        {
            return Err(error);
        }
        let mut stdin = entry.stdin.lock().map_err(|_| "MCP stdio stdin poisoned")?;
        stdin
            .write_all(input.message.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|_| "MCP stdio notification write failed".to_string())
    }

    pub fn stop(state: &McpStdioState, process_id: String) -> Result<bool, String> {
        validate_id(&process_id, "process id")?;
        let entry = state
            .processes
            .lock()
            .map_err(|_| "MCP stdio state poisoned")?
            .remove(&process_id);
        let Some(entry) = entry else { return Ok(false) };
        fail_pending(&entry, "MCP stdio process stopped");
        let mut child = entry
            .child
            .lock()
            .map_err(|_| "MCP stdio child state poisoned")?;
        let _ = child.kill();
        let _ = child.wait();
        Ok(true)
    }

    pub fn status(
        state: &McpStdioState,
        process_id: String,
    ) -> Result<McpStdioStatusResult, String> {
        validate_id(&process_id, "process id")?;
        let entry = state
            .processes
            .lock()
            .map_err(|_| "MCP stdio state poisoned")?
            .get(&process_id)
            .cloned();
        let Some(entry) = entry else {
            return Ok(McpStdioStatusResult {
                process_id,
                running: false,
                pid: None,
                config_revision: None,
                fatal_error: None,
                stderr_lines: Vec::new(),
            });
        };
        let running = entry
            .child
            .lock()
            .map_err(|_| "MCP stdio child state poisoned")?
            .try_wait()
            .map_err(|_| "MCP stdio process status failed")?
            .is_none();
        let fatal_error = entry
            .fatal
            .lock()
            .map_err(|_| "MCP stdio state poisoned")?
            .clone();
        let stderr_lines = entry
            .stderr
            .lock()
            .map_err(|_| "MCP stdio stderr state poisoned")?
            .iter()
            .cloned()
            .collect();
        Ok(McpStdioStatusResult {
            process_id,
            running,
            pid: Some(entry.pid),
            config_revision: Some(entry.config_revision.clone()),
            fatal_error,
            stderr_lines,
        })
    }

    fn spawn_stdout_reader(entry: Arc<ProcessEntry>, stdout: impl Read + Send + 'static) {
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                match reader.read_until(b'\n', &mut bytes) {
                    Ok(0) => {
                        set_fatal(&entry, "MCP stdio process closed stdout");
                        break;
                    }
                    Ok(_) => {
                        if bytes.len() > MAX_MESSAGE_BYTES {
                            set_fatal(&entry, "MCP stdio response exceeded the message limit");
                            break;
                        }
                        while matches!(bytes.last(), Some(b'\n' | b'\r')) {
                            bytes.pop();
                        }
                        let Ok(text) = String::from_utf8(bytes) else {
                            set_fatal(&entry, "MCP stdio response was not UTF-8");
                            break;
                        };
                        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                            set_fatal(&entry, "MCP stdio stdout contained a non-JSON message");
                            break;
                        };
                        let Some(object) = value.as_object() else {
                            set_fatal(&entry, "MCP stdio response was not a JSON object");
                            break;
                        };
                        if object.get("jsonrpc").and_then(|value| value.as_str()) != Some("2.0") {
                            set_fatal(
                                &entry,
                                "MCP stdio response used an invalid JSON-RPC version",
                            );
                            break;
                        }
                        let Some(id) = object.get("id") else {
                            // Notifications are deliberately isolated from the Agent transcript.
                            if object
                                .get("method")
                                .and_then(|value| value.as_str())
                                .is_some()
                            {
                                continue;
                            }
                            set_fatal(&entry, "MCP stdio response omitted its request id");
                            break;
                        };
                        let Some(key) = json_rpc_id_key(id) else {
                            set_fatal(&entry, "MCP stdio response used an invalid request id");
                            break;
                        };
                        let sender = entry
                            .pending
                            .lock()
                            .ok()
                            .and_then(|mut pending| pending.remove(&key));
                        if let Some(sender) = sender {
                            let _ = sender.send(Ok(text));
                        } else {
                            set_fatal(
                                &entry,
                                "MCP stdio response used an unknown or expired request id",
                            );
                            break;
                        }
                    }
                    Err(_) => {
                        set_fatal(&entry, "MCP stdio stdout read failed");
                        break;
                    }
                }
            }
        });
    }

    fn spawn_stderr_reader(entry: Arc<ProcessEntry>, stderr: impl Read + Send + 'static) {
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                if let Ok(mut lines) = entry.stderr.lock() {
                    if lines.len() >= MAX_STDERR_LINES {
                        lines.pop_front();
                    }
                    lines.push_back(line.chars().take(1_000).collect());
                }
            }
        });
    }

    fn set_fatal(entry: &ProcessEntry, message: &str) {
        if let Ok(mut fatal) = entry.fatal.lock() {
            if fatal.is_none() {
                *fatal = Some(message.to_string());
            }
        }
        fail_pending(entry, message);
    }

    fn fail_pending(entry: &ProcessEntry, message: &str) {
        if let Ok(mut pending) = entry.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err(message.to_string()));
            }
        }
    }

    fn validate_start(input: &McpStdioStartInput) -> Result<(), String> {
        validate_id(&input.process_id, "process id")?;
        validate_id(&input.config_revision, "config revision")?;
        if !Path::new(&input.command).is_absolute() || input.command.len() > 2_000 {
            return Err("MCP stdio command must be an absolute path".into());
        }
        if input.args.len() > 64 || input.args.iter().any(|value| invalid_value(value, 2_000)) {
            return Err("MCP stdio arguments are invalid".into());
        }
        if let Some(cwd) = &input.cwd {
            if !Path::new(cwd).is_absolute() || invalid_value(cwd, 2_000) {
                return Err("MCP stdio cwd must be an absolute path".into());
            }
        }
        if input.env.len() > 64
            || input.env.iter().any(|(key, value)| {
                key.is_empty()
                    || key.len() > 200
                    || !key.chars().enumerate().all(|(index, ch)| {
                        ch == '_'
                            || ch.is_ascii_alphanumeric() && (index > 0 || ch.is_ascii_alphabetic())
                    })
                    || invalid_value(value, 8_000)
            })
        {
            return Err("MCP stdio environment is invalid".into());
        }
        Ok(())
    }

    fn validate_request(input: &McpStdioRequestInput) -> Result<(), String> {
        validate_id(&input.process_id, "process id")?;
        validate_id(&input.request_id, "request id")?;
        if input.timeout_ms == 0 || input.timeout_ms > 300_000 {
            return Err("MCP stdio timeout is invalid".into());
        }
        if input.message.len() > MAX_MESSAGE_BYTES
            || input.message.contains('\n')
            || input.message.contains('\r')
        {
            return Err("MCP stdio request is invalid".into());
        }
        let value: serde_json::Value =
            serde_json::from_str(&input.message).map_err(|_| "MCP stdio request is not JSON")?;
        let object = value
            .as_object()
            .ok_or("MCP stdio request is not an object")?;
        if object.get("jsonrpc").and_then(|value| value.as_str()) != Some("2.0") {
            return Err("MCP stdio request uses an invalid JSON-RPC version".into());
        }
        let id = object.get("id").ok_or("MCP stdio request id is missing")?;
        if json_rpc_id_key(id).as_deref() != Some(input.request_id.as_str()) {
            return Err("MCP stdio request id does not match its envelope".into());
        }
        let method = object
            .get("method")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if !matches!(method, "initialize" | "ping" | "tools/list" | "tools/call") {
            return Err("MCP stdio method is not enabled by this host".into());
        }
        Ok(())
    }

    fn validate_notification(input: &McpStdioNotifyInput) -> Result<(), String> {
        validate_id(&input.process_id, "process id")?;
        if input.message.len() > MAX_MESSAGE_BYTES
            || input.message.contains('\n')
            || input.message.contains('\r')
        {
            return Err("MCP stdio notification is invalid".into());
        }
        let value: serde_json::Value = serde_json::from_str(&input.message)
            .map_err(|_| "MCP stdio notification is not JSON")?;
        let object = value
            .as_object()
            .ok_or("MCP stdio notification is not an object")?;
        if object.get("jsonrpc").and_then(|value| value.as_str()) != Some("2.0")
            || object.contains_key("id")
        {
            return Err("MCP stdio notification envelope is invalid".into());
        }
        let method = object
            .get("method")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if !matches!(
            method,
            "notifications/initialized" | "notifications/cancelled"
        ) {
            return Err("MCP stdio notification is not enabled by this host".into());
        }
        Ok(())
    }

    fn json_rpc_id_key(value: &serde_json::Value) -> Option<String> {
        match value {
            serde_json::Value::String(value) if !value.is_empty() => Some(value.clone()),
            serde_json::Value::Number(value) => Some(value.to_string()),
            _ => None,
        }
    }

    fn validate_id(value: &str, label: &str) -> Result<(), String> {
        if value.is_empty()
            || value.len() > 200
            || !value
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':' | '.'))
        {
            return Err(format!("MCP stdio {label} is invalid"));
        }
        Ok(())
    }

    fn invalid_value(value: &str, max: usize) -> bool {
        value.len() > max || value.contains('\0') || value.contains('\r') || value.contains('\n')
    }

    #[cfg(all(test, unix))]
    mod tests {
        use super::*;
        use std::fs;

        fn fixture_script(source: &str) -> (tempfile::TempDir, String) {
            // Parallel tests can observe the same clock tick. A unique directory
            // keeps one subprocess fixture from overwriting another's script.
            let directory = tempfile::Builder::new()
                .prefix("drifting-mcp-stdio-")
                .tempdir()
                .expect("fixture directory");
            let path = directory.path().join("fixture.mjs");
            fs::write(&path, source).expect("write fixture");
            (directory, path.to_string_lossy().into_owned())
        }

        fn start_input(process_id: &str, script: String) -> McpStdioStartInput {
            McpStdioStartInput {
                process_id: process_id.into(),
                command: "/usr/bin/env".into(),
                args: vec!["node".into(), script],
                cwd: None,
                env: HashMap::new(),
                config_revision: format!("sha256:{}", "a".repeat(64)),
            }
        }

        fn request_input(process_id: &str, request_id: &str, method: &str) -> McpStdioRequestInput {
            McpStdioRequestInput {
                process_id: process_id.into(),
                request_id: request_id.into(),
                message: format!(
                    r#"{{"jsonrpc":"2.0","id":"{request_id}","method":"{method}","params":{{}}}}"#
                ),
                timeout_ms: 5_000,
            }
        }

        #[test]
        fn real_process_round_trip_status_notification_and_stop() {
            let (_directory, script) = fixture_script(
                r#"
import readline from 'node:readline';
const lines = readline.createInterface({ input: process.stdin });
console.error('fixture-ready');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, 'id')) return;
  const result = message.method === 'initialize'
    ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
"#,
            );
            let state = McpStdioState::default();
            let started = start(&state, start_input("fixture:roundtrip", script.clone()))
                .expect("start fixture");
            assert!(started.pid > 0);
            let response = tauri::async_runtime::block_on(request(
                &state,
                request_input("fixture:roundtrip", "rpc:1", "initialize"),
            ))
            .expect("initialize response");
            let json: serde_json::Value = serde_json::from_str(&response).expect("json response");
            assert_eq!(json["id"], "rpc:1");
            notify(
                &state,
                McpStdioNotifyInput {
                    process_id: "fixture:roundtrip".into(),
                    message: r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.into(),
                },
            )
            .expect("initialized notification");
            let running_status = status(&state, "fixture:roundtrip".into()).expect("status");
            assert!(running_status.running);
            let expected_revision = format!("sha256:{}", "a".repeat(64));
            assert_eq!(
                running_status.config_revision.as_deref(),
                Some(expected_revision.as_str())
            );
            assert!(stop(&state, "fixture:roundtrip".into()).expect("stop"));
            assert!(
                !status(&state, "fixture:roundtrip".into())
                    .expect("stopped status")
                    .running
            );
        }

        #[test]
        fn malformed_stdout_fails_pending_and_marks_process_fatal() {
            let (_directory, script) = fixture_script(
                r#"
import readline from 'node:readline';
const lines = readline.createInterface({ input: process.stdin });
lines.once('line', () => process.stdout.write('not-json\n'));
"#,
            );
            let state = McpStdioState::default();
            start(&state, start_input("fixture:malformed", script.clone())).expect("start fixture");
            let error = tauri::async_runtime::block_on(request(
                &state,
                request_input("fixture:malformed", "rpc:1", "initialize"),
            ))
            .expect_err("malformed stdout must fail");
            assert!(error.contains("non-JSON"));
            let status = status(&state, "fixture:malformed".into()).expect("status");
            assert!(status.fatal_error.unwrap_or_default().contains("non-JSON"));
            stop(&state, "fixture:malformed".into()).expect("stop");
        }
    }
}

#[cfg(desktop)]
pub use desktop::McpStdioState;

#[cfg(not(desktop))]
#[derive(Default)]
pub struct McpStdioState;

#[tauri::command]
pub fn mcp_stdio_start(
    state: State<'_, McpStdioState>,
    input: McpStdioStartInput,
) -> Result<McpStdioStartResult, String> {
    #[cfg(desktop)]
    return desktop::start(state.inner(), input);
    #[cfg(not(desktop))]
    {
        let _ = (state, input);
        Err("MCP stdio is unsupported on mobile; use Streamable HTTP".into())
    }
}

#[tauri::command]
pub async fn mcp_stdio_request(
    state: State<'_, McpStdioState>,
    input: McpStdioRequestInput,
) -> Result<String, String> {
    #[cfg(desktop)]
    return desktop::request(state.inner(), input).await;
    #[cfg(not(desktop))]
    {
        let _ = (state, input);
        Err("MCP stdio is unsupported on mobile; use Streamable HTTP".into())
    }
}

#[tauri::command]
pub fn mcp_stdio_notify(
    state: State<'_, McpStdioState>,
    input: McpStdioNotifyInput,
) -> Result<(), String> {
    #[cfg(desktop)]
    return desktop::notify(state.inner(), input);
    #[cfg(not(desktop))]
    {
        let _ = (state, input);
        Err("MCP stdio is unsupported on mobile; use Streamable HTTP".into())
    }
}

#[tauri::command]
pub fn mcp_stdio_stop(state: State<'_, McpStdioState>, process_id: String) -> Result<bool, String> {
    #[cfg(desktop)]
    return desktop::stop(state.inner(), process_id);
    #[cfg(not(desktop))]
    {
        let _ = (state, process_id);
        Ok(false)
    }
}

#[tauri::command]
pub fn mcp_stdio_status(
    state: State<'_, McpStdioState>,
    process_id: String,
) -> Result<McpStdioStatusResult, String> {
    #[cfg(desktop)]
    return desktop::status(state.inner(), process_id);
    #[cfg(not(desktop))]
    {
        let _ = state;
        Ok(McpStdioStatusResult {
            process_id,
            running: false,
            pid: None,
            config_revision: None,
            fatal_error: Some("MCP stdio is unsupported on mobile; use Streamable HTTP".into()),
            stderr_lines: Vec::new(),
        })
    }
}
