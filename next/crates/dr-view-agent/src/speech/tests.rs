use super::{
    audio::Encoder,
    client::{Client, Failure, KEY, MAX_AUDIO_BYTES},
    context,
};
use dr_agent_providers::HttpClient;
use dr_platform::secrets::SecretStore;
use futures::executor::block_on;
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub(super) fn audio() -> Arc<Vec<u8>> {
    let mut encoder = Encoder::new(48_000, 2).unwrap();
    encoder.push(&vec![0.125; 9600]);
    Arc::new(encoder.flush().unwrap())
}
pub(super) struct Server {
    pub endpoint: String,
    pub requests: Arc<Mutex<Vec<Value>>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    pub fn new(replies: Vec<(u16, Value)>, delay: Duration) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}/asr", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stopped = stop.clone();
        let worker = std::thread::spawn(move || {
            let mut replies = replies.into_iter();
            while !stopped.load(std::sync::atomic::Ordering::Acquire) {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(_) => return,
                };
                // macOS accepted sockets can inherit the listener's nonblocking
                // mode. Read a complete HTTP request rather than treating
                // a not-yet-arrived header as EOF and closing the fake server.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(4)))
                    .unwrap();
                let mut bytes = Vec::new();
                let end = loop {
                    let mut one = [0; 1];
                    if stream.read_exact(&mut one).is_err() {
                        return;
                    }
                    bytes.push(one[0]);
                    if bytes.ends_with(b"\r\n\r\n") {
                        break bytes.len();
                    }
                };
                let headers = String::from_utf8_lossy(&bytes).to_lowercase();
                assert!(headers.contains("authorization: bearer synthetic-speech-key"));
                let length: usize = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .unwrap()
                    .trim()
                    .parse()
                    .unwrap();
                bytes.resize(end + length, 0);
                stream.read_exact(&mut bytes[end..]).unwrap();
                recorded
                    .lock()
                    .unwrap()
                    .push(serde_json::from_slice(&bytes[end..]).unwrap());
                let (status, value) = replies.next().unwrap_or((500, json!({})));
                std::thread::sleep(delay);
                if status == 0 {
                    continue; // Unknown network outcome: accepted, then EOF.
                }
                let body = value.to_string();
                let response = format!(
                    "HTTP/1.1 {status} Synthetic\r\nContent-Length: {}\r\nContent-Type: application/json\r\nRetry-After: 0\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        Self {
            endpoint,
            requests,
            stop,
            worker: Some(worker),
        }
    }
    pub fn client(&self) -> Client {
        let secrets = Arc::new(SecretStore::in_memory());
        secrets.set(KEY, "synthetic-speech-key").unwrap();
        Client::new(HttpClient::new().unwrap(), secrets)
            .with_endpoint(&self.endpoint)
            .unwrap()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
    }
}
pub(super) fn transcript(text: &str) -> Value {
    json!({"output":{"choices":[{"message":{"content":[{"text":text}]}}]}})
}

#[test]
fn wav_segments_and_resampling_preserve_frames_across_callback_boundaries() {
    let mut whole = Encoder::new(44_100, 2).unwrap();
    let mut split = Encoder::new(44_100, 2).unwrap();
    let source: Vec<f32> = (0..88_200).map(|i| ((i % 97) as f32 - 48.) / 48.).collect();
    whole.push(&source);
    for chunk in source.chunks(513) {
        split.push(chunk);
    }
    let wave = whole.flush().unwrap();
    assert_eq!(split.flush().unwrap(), wave);
    assert_eq!(wave.len(), 44 + 32_000);
    assert_eq!(&wave[0..4], b"RIFF");
    assert_eq!(u32::from_le_bytes(wave[24..28].try_into().unwrap()), 16_000);
    assert!(whole.flush().is_none());
    let mut rolling = Encoder::new(16_000, 1).unwrap();
    let frames = (MAX_AUDIO_BYTES - 44) / 2;
    let mut segments = rolling.push(&vec![0.; frames + 1600]);
    segments.push(rolling.flush().unwrap());
    assert_eq!(segments.len(), 2);
    assert_eq!(
        segments.iter().map(|s| (s.len() - 44) / 2).sum::<usize>(),
        frames + 1600
    );
    assert!(segments.iter().all(|s| s.len() <= MAX_AUDIO_BYTES));
}

#[test]
fn fake_asr_checks_wire_context_audio_and_bounded_retry() {
    use base64::Engine as _;
    let service = Server::new(
        vec![
            (429, json!({})),
            (503, json!({})),
            (200, transcript(" synthetic name ")),
        ],
        Duration::ZERO,
    );
    let audio = audio();
    let context = context::pack(vec!["synthetic name".into(), "alias".into()]);
    let result = block_on(service.client().transcribe(
        audio.clone(),
        context.clone(),
        CancellationToken::new(),
    ))
    .unwrap();
    assert_eq!(result, "synthetic name");
    let requests = service.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests.iter().all(|request| request == &requests[0]));
    assert_eq!(requests[0]["model"], "qwen3-asr-flash");
    assert_eq!(
        requests[0]["parameters"]["asr_options"]["enable_itn"],
        false
    );
    assert_eq!(
        requests[0]["input"]["messages"][0]["content"][0]["text"],
        context
    );
    let data = requests[0]["input"]["messages"][1]["content"][0]["audio"]
        .as_str()
        .unwrap()
        .strip_prefix("data:audio/wav;base64,")
        .unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .unwrap(),
        *audio
    );
}

#[test]
fn failed_segment_can_retry_without_changing_audio_and_auth_does_not_retry() {
    let service = Server::new(
        vec![
            (401, json!({"secret":"never surfaced"})),
            (200, transcript("recovered")),
        ],
        Duration::ZERO,
    );
    let client = service.client();
    assert_eq!(
        block_on(client.transcribe(audio(), String::new(), CancellationToken::new())),
        Err(Failure::Authentication)
    );
    assert_eq!(service.requests.lock().unwrap().len(), 1);
    assert_eq!(
        block_on(client.transcribe(audio(), String::new(), CancellationToken::new())).unwrap(),
        "recovered"
    );
    let requests = service.requests.lock().unwrap();
    assert_eq!(requests[0], requests[1]);
}

#[test]
fn unknown_outcomes_and_protocol_errors_are_not_repeated_and_rate_limits_are_bounded() {
    for (replies, expected, count) in [
        (vec![(0, json!({}))], Err(Failure::Transport), 1),
        (vec![(400, json!({}))], Err(Failure::Rejected), 1),
        (vec![(200, json!({}))], Err(Failure::Rejected), 1),
        (vec![(429, json!({})); 3], Err(Failure::Transport), 3),
        (vec![(200, transcript(""))], Ok(String::new()), 1),
    ] {
        let service = Server::new(replies, Duration::ZERO);
        assert_eq!(
            block_on(
                service
                    .client()
                    .transcribe(audio(), String::new(), CancellationToken::new())
            ),
            expected
        );
        assert_eq!(service.requests.lock().unwrap().len(), count);
    }
    let service = Server::new(vec![], Duration::ZERO);
    let client = service.client();
    client.secrets.delete(KEY).unwrap();
    assert_eq!(
        block_on(client.transcribe(audio(), String::new(), CancellationToken::new())),
        Err(Failure::NoKey)
    );
    assert!(service.requests.lock().unwrap().is_empty());
}

#[test]
fn cancellation_waits_for_worker_ack_and_prevents_late_transcript() {
    let service = Server::new(vec![(200, transcript("late"))], Duration::from_millis(100));
    let cancel = CancellationToken::new();
    let control = cancel.clone();
    let requests = service.requests.clone();
    let worker = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while requests.lock().unwrap().is_empty() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        control.cancel();
    });
    assert_eq!(
        block_on(service.client().transcribe(audio(), String::new(), cancel)),
        Err(Failure::Cancelled)
    );
    worker.join().unwrap();
}

#[test]
fn glossary_uses_seed_names_and_aliases_and_stays_bounded() {
    use dr_testkit::seed::{self, Preset};
    let dir = tempfile::tempdir().unwrap();
    let ws = dr_workspace::Workspace::open_dir(dir.path(), "speech-context").unwrap();
    let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    seeded.write_to(ws.library()).unwrap();
    let book = seeded.books[0].book_id().clone();
    let expected = seeded.books[0]
        .book
        .view()
        .elements()
        .into_iter()
        .find(|e| e.deleted_at.is_none())
        .unwrap();
    let context = context::glossary(ws.library(), &book).unwrap();
    assert!(context.contains(&expected.name));
    for alias in &expected.aliases {
        assert!(context.contains(alias));
    }
    let packed = context::pack(vec![
        "x".repeat(10_000),
        "合成专名".into(),
        "合成专名".into(),
    ]);
    assert!(packed.chars().count() <= context::MAX_CONTEXT_CHARS);
    assert_eq!(packed.matches("合成专名").count(), 1);
    ws.shutdown().unwrap();
}

#[test]
fn application_barrier_outlives_view_owner_and_waits_for_ack() {
    use futures::{FutureExt as _, channel::oneshot};
    let jobs = super::Jobs::default();
    let app_owner = jobs.clone();
    let cancel = CancellationToken::new();
    let (send, receive) = oneshot::channel::<()>();
    jobs.track(
        cancel.clone(),
        async move {
            receive.await.unwrap();
        }
        .boxed()
        .shared(),
    );
    drop(jobs);
    let drain = app_owner.drain().boxed().shared();
    assert!(cancel.is_cancelled());
    assert!(drain.clone().now_or_never().is_none());
    send.send(()).unwrap();
    block_on(drain);
}
