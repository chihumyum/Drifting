//! Native CoreAudio/WASAPI capture on an owned worker. No recordings on disk.
//! The callback never blocks; overload stops capture with an explicit error.
use super::client::{Failure, MAX_AUDIO_BYTES};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use futures::{
    FutureExt as _,
    channel::{mpsc as asynchronous, oneshot},
    future::{BoxFuture, Shared},
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
    mpsc,
};
use std::time::Duration;

pub const SAMPLE_RATE: u32 = 16_000;
pub const MAX_SECONDS: usize = 4 * 60;
pub const MAX_PENDING: usize = 4;
static MICROPHONE: AtomicBool = AtomicBool::new(false);
pub type Completion = Shared<BoxFuture<'static, ()>>;

pub enum Event {
    Segment(Arc<Vec<u8>>),
    Stopped(Option<Failure>),
}
struct Lease;
impl Drop for Lease {
    fn drop(&mut self) {
        MICROPHONE.store(false, Ordering::Release);
    }
}

pub struct Capture {
    command: Arc<AtomicU8>,
    pending: Arc<AtomicUsize>,
    pub done: Completion,
}
impl Capture {
    pub fn start(
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<(Self, asynchronous::UnboundedReceiver<Event>), Failure> {
        if MICROPHONE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(Failure::Microphone);
        }
        let lease = Lease;
        let command = Arc::new(AtomicU8::new(0));
        let pending = Arc::new(AtomicUsize::new(0));
        let (send, receive) = asynchronous::unbounded();
        let (done, finished) = oneshot::channel();
        let (control, count) = (command.clone(), pending.clone());
        std::thread::Builder::new()
            .name("dr-dictation".into())
            .spawn(move || {
                let result = record(&control, &count, &send, &cancel);
                let _ = send.unbounded_send(Event::Stopped(result.err()));
                drop(lease);
                let _ = done.send(());
            })
            .map_err(|_| Failure::Microphone)?;
        Ok((
            Self {
                command,
                pending,
                done: async move {
                    let _ = finished.await;
                }
                .boxed()
                .shared(),
            },
            receive,
        ))
    }
    pub fn stop(&self) {
        let _ = self
            .command
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire);
    }
    pub fn cancel(&self) {
        self.command.store(2, Ordering::Release);
    }
    pub fn acknowledge(&self) {
        let _ = self
            .pending
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1));
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.cancel();
    }
}

/// Stateful mono conversion with an integrating rate converter. Fractional
/// source-frame weights cross callback boundaries, so splitting a callback
/// cannot drop or repeat a sample at 44.1 kHz. Four-minute and byte limits both
/// apply; the byte guard can roll a segment slightly earlier.
pub struct Encoder {
    rate: u32,
    channels: usize,
    phase: u32,
    sum: f64,
    frame: Vec<f32>,
    pcm: Vec<i16>,
    limit: usize,
}
impl Encoder {
    pub fn new(rate: u32, channels: usize) -> Result<Self, Failure> {
        if !(8_000..=384_000).contains(&rate) || channels == 0 || channels > 64 {
            return Err(Failure::Microphone);
        }
        Ok(Self {
            rate,
            channels,
            phase: 0,
            sum: 0.,
            frame: Vec::new(),
            pcm: Vec::new(),
            limit: (SAMPLE_RATE as usize * MAX_SECONDS).min((MAX_AUDIO_BYTES - 44) / 2),
        })
    }
    pub fn push(&mut self, samples: &[f32]) -> Vec<Vec<u8>> {
        let mut ready = Vec::new();
        for &sample in samples {
            self.frame.push(if sample.is_finite() {
                sample.clamp(-1., 1.)
            } else {
                0.
            });
            if self.frame.len() < self.channels {
                continue;
            }
            let value = self.frame.iter().map(|s| *s as f64).sum::<f64>() / self.channels as f64;
            self.frame.clear();
            let mut remaining = SAMPLE_RATE;
            while remaining > 0 {
                let weight = remaining.min(self.rate - self.phase);
                self.sum += value * weight as f64;
                self.phase += weight;
                remaining -= weight;
                if self.phase == self.rate {
                    self.pcm
                        .push((self.sum / self.rate as f64 * i16::MAX as f64).round() as i16);
                    self.phase = 0;
                    self.sum = 0.;
                    if self.pcm.len() == self.limit {
                        ready.push(self.flush().expect("full segment"));
                    }
                }
            }
        }
        ready
    }
    pub fn flush(&mut self) -> Option<Vec<u8>> {
        if self.pcm.is_empty() {
            return None;
        }
        let pcm = std::mem::take(&mut self.pcm);
        let size = pcm.len() as u32 * 2;
        let mut wav = Vec::with_capacity(size as usize + 44);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(size + 36).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
        wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&size.to_le_bytes());
        for sample in pcm {
            wav.extend_from_slice(&sample.to_le_bytes());
        }
        Some(wav)
    }
}

fn record(
    command: &AtomicU8,
    pending: &AtomicUsize,
    output: &asynchronous::UnboundedSender<Event>,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<(), Failure> {
    if command.load(Ordering::Acquire) != 0 || cancel.is_cancelled() {
        return Ok(());
    }
    let device = cpal::default_host()
        .default_input_device()
        .ok_or(Failure::Microphone)?;
    let supported = device
        .default_input_config()
        .map_err(|_| Failure::Microphone)?;
    let config = supported.config();
    let encoder = Encoder::new(config.sample_rate, config.channels as usize)?;
    let (send, receive) = mpsc::sync_channel(32);
    let fault = Arc::new(AtomicBool::new(false));
    let input_fault = fault.clone();
    let error_fault = fault.clone();
    let stream = device
        .build_input_stream_raw(
            config,
            supported.sample_format(),
            move |data, _| {
                let values = samples(data);
                if values.is_none_or(|values| send.try_send(values).is_err()) {
                    input_fault.store(true, Ordering::Release);
                }
            },
            move |_| {
                error_fault.store(true, Ordering::Release);
            },
            None,
        )
        .map_err(|_| Failure::Microphone)?;
    if command.load(Ordering::Acquire) != 0 || cancel.is_cancelled() {
        return Ok(());
    }
    stream.play().map_err(|_| Failure::Microphone)?;
    encode_recording(
        encoder,
        receive,
        CaptureState {
            command,
            pending,
            fault: &fault,
            cancel,
        },
        output,
        move || drop(stream),
    )
}

struct CaptureState<'a> {
    command: &'a AtomicU8,
    pending: &'a AtomicUsize,
    fault: &'a AtomicBool,
    cancel: &'a tokio_util::sync::CancellationToken,
}

// The native callback's bounded frame queue is also the synthetic-audio test
// seam. Closing the stream must precede draining accepted frames or cancellation.
fn encode_recording(
    mut encoder: Encoder,
    receive: mpsc::Receiver<Vec<f32>>,
    state: CaptureState<'_>,
    output: &asynchronous::UnboundedSender<Event>,
    close_stream: impl FnOnce(),
) -> Result<(), Failure> {
    let CaptureState {
        command,
        pending,
        fault,
        cancel,
    } = state;
    let send_segment = |wav| -> Result<(), Failure> {
        pending.fetch_add(1, Ordering::AcqRel);
        output
            .unbounded_send(Event::Segment(Arc::new(wav)))
            .map_err(|_| Failure::Cancelled)?;
        if pending.load(Ordering::Acquire) >= MAX_PENDING {
            return Err(Failure::Backlog);
        }
        Ok(())
    };
    let mut result = Ok(());
    while command.load(Ordering::Acquire) == 0 && !cancel.is_cancelled() {
        if fault.load(Ordering::Acquire) {
            result = Err(Failure::Microphone);
            break;
        }
        match receive.recv_timeout(Duration::from_millis(20)) {
            Ok(samples) => {
                for wav in encoder.push(&samples) {
                    if let Err(error) = send_segment(wav) {
                        result = Err(error);
                        break;
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => (),
            Err(_) => {
                result = Err(Failure::Microphone);
                break;
            }
        }
        if result.is_err() {
            break;
        }
    }
    close_stream(); // no more callbacks before draining the final frames
    if command.load(Ordering::Acquire) == 2 || cancel.is_cancelled() {
        return Ok(());
    }
    if result.is_ok() {
        for samples in receive.try_iter() {
            for wav in encoder.push(&samples) {
                if let Err(error) = send_segment(wav) {
                    result = Err(error);
                    break;
                }
            }
            if result.is_err() {
                break;
            }
        }
    }
    if pending.load(Ordering::Acquire) < MAX_PENDING
        && let Some(wav) = encoder.flush()
    {
        let _ = send_segment(wav);
    }
    result
}

// Native defaults differ by device (notably PCM32 on some WASAPI inputs).
fn samples(data: &cpal::Data) -> Option<Vec<f32>> {
    use cpal::Sample as _;
    macro_rules! convert {
        ($($kind:ty),+) => { $(
            if let Some(samples) = data.as_slice::<$kind>() {
                return Some(samples.iter().map(|sample| sample.to_sample::<f32>()).collect());
            }
        )+ };
    }
    convert!(
        f32,
        i16,
        u16,
        i32,
        u32,
        i8,
        u8,
        cpal::I24,
        cpal::U24,
        i64,
        u64,
        f64
    );
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::{StreamExt as _, executor::block_on};
    use tokio_util::sync::CancellationToken;

    #[test]
    fn stop_closes_stream_before_draining_accepted_tail_and_cancel_discards_it() {
        for cancelled in [false, true] {
            let command = AtomicU8::new(if cancelled { 2 } else { 1 });
            let pending = AtomicUsize::new(0);
            let fault = AtomicBool::new(false);
            let cancel = CancellationToken::new();
            let (frames, receive) = mpsc::sync_channel(4);
            frames.send(vec![0.125; 3200]).unwrap();
            let (events, mut output) = asynchronous::unbounded();
            let closed = AtomicBool::new(false);
            encode_recording(
                Encoder::new(SAMPLE_RATE, 1).unwrap(),
                receive,
                CaptureState {
                    command: &command,
                    pending: &pending,
                    fault: &fault,
                    cancel: &cancel,
                },
                &events,
                || {
                    frames.send(vec![0.25; 1600]).unwrap();
                    drop(frames);
                    closed.store(true, Ordering::Release);
                },
            )
            .unwrap();
            assert!(closed.load(Ordering::Acquire));
            drop(events);
            let segments = block_on(async { output.by_ref().collect::<Vec<_>>().await });
            if cancelled {
                assert!(segments.is_empty());
                assert_eq!(pending.load(Ordering::Acquire), 0);
            } else {
                assert_eq!(segments.len(), 1);
                let Event::Segment(wav) = &segments[0] else {
                    panic!("expected final segment");
                };
                let mut expected = Encoder::new(SAMPLE_RATE, 1).unwrap();
                expected.push(&vec![0.125; 3200]);
                expected.push(&vec![0.25; 1600]);
                assert_eq!(**wav, expected.flush().unwrap());
                assert_eq!(pending.load(Ordering::Acquire), 1);
            }
        }
    }

    #[test]
    fn backlog_closes_stream_and_retains_exactly_the_bounded_queue() {
        let command = AtomicU8::new(0);
        let pending = AtomicUsize::new(0);
        let fault = AtomicBool::new(false);
        let cancel = CancellationToken::new();
        let (frames, receive) = mpsc::sync_channel(4);
        frames.send(vec![0.25; 20]).unwrap();
        let mut encoder = Encoder::new(SAMPLE_RATE, 1).unwrap();
        encoder.limit = 4;
        let (events, output) = asynchronous::unbounded();
        let closed = AtomicBool::new(false);
        assert_eq!(
            encode_recording(
                encoder,
                receive,
                CaptureState {
                    command: &command,
                    pending: &pending,
                    fault: &fault,
                    cancel: &cancel,
                },
                &events,
                || {
                    drop(frames);
                    closed.store(true, Ordering::Release);
                },
            ),
            Err(Failure::Backlog)
        );
        assert!(closed.load(Ordering::Acquire));
        drop(events);
        let segments = block_on(output.collect::<Vec<_>>());
        assert_eq!(segments.len(), MAX_PENDING);
        assert_eq!(pending.load(Ordering::Acquire), MAX_PENDING);
        for event in segments {
            let Event::Segment(wav) = event else {
                panic!("expected retained segment");
            };
            assert_eq!(wav.len(), 44 + 4 * 2);
        }
    }
}
