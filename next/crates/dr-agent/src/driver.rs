//! M28's seam: adapters turn their protocol into this stream. They own HTTP
//! and SSE decoding; fragmented tool JSON is complete before `ToolCall`.

use crate::{Cancellation, Error, Result, ToolCall, ToolDescriptor, Usage};
use dr_model::conversation::ConversationEntry;
use futures::{StreamExt, channel::oneshot, stream::BoxStream};
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub struct DriverRequest {
    pub config: Arc<crate::RunConfig>,
    pub session: String,
    pub turn: u32,
    pub round: u32,
    pub conversation: Vec<ConversationEntry>,
    pub tools: Vec<ToolDescriptor>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FinishReason {
    Complete,
    Tools,
}

#[derive(Clone, Debug)]
pub enum DriverEvent {
    TextDelta {
        index: u32,
        text: String,
    },
    ThinkingDelta {
        index: u32,
        text: String,
    },
    ThinkingSignature {
        index: u32,
        signature: Option<String>,
        replay: Option<Value>,
    },
    ToolCall(ToolCall),
    /// Cumulative totals for this model round, not token deltas.
    Usage(Usage),
    Replay {
        replay: crate::ProviderReplay,
    },
    ProviderTool {
        activity: crate::ProviderTool,
    },
    Finish(FinishReason),
}

pub trait Driver: Send + Sync + 'static {
    /// Must return promptly and yield without blocking the runtime worker.
    /// Dropping the stream cancels transport I/O; also honor cancellation.
    fn stream(
        &self,
        request: DriverRequest,
        cancel: Cancellation,
    ) -> BoxStream<'static, Result<DriverEvent>>;
}

/// Deterministic, offline driver. No credentials or network are involved.
pub mod scripted {
    use super::*;

    pub enum Step {
        Event(DriverEvent),
        Wait(oneshot::Receiver<()>),
        Fail(String),
    }

    pub struct ScriptedDriver {
        scripts: Mutex<VecDeque<Vec<Step>>>,
        requests: Mutex<Vec<DriverRequest>>,
    }

    impl ScriptedDriver {
        pub fn new(scripts: Vec<Vec<Step>>) -> Self {
            Self {
                scripts: Mutex::new(scripts.into()),
                requests: Mutex::new(Vec::new()),
            }
        }

        pub fn requests(&self) -> Vec<DriverRequest> {
            self.requests.lock().expect("script requests").clone()
        }
    }

    impl Driver for ScriptedDriver {
        fn stream(
            &self,
            request: DriverRequest,
            cancel: Cancellation,
        ) -> BoxStream<'static, Result<DriverEvent>> {
            self.requests.lock().expect("script requests").push(request);
            let script = self
                .scripts
                .lock()
                .expect("scripts")
                .pop_front()
                .unwrap_or_else(|| vec![Step::Fail("script exhausted".into())]);
            futures::stream::unfold(
                (VecDeque::from(script), cancel),
                |(mut steps, cancel)| async move {
                    loop {
                        if cancel.is_cancelled() {
                            return None;
                        }
                        match steps.pop_front()? {
                            Step::Wait(rx) => {
                                let _ = rx.await;
                            }
                            Step::Event(event) => return Some((Ok(event), (steps, cancel))),
                            Step::Fail(error) => {
                                return Some((Err(Error::Driver(error)), (steps, cancel)));
                            }
                        }
                    }
                },
            )
            .boxed()
        }
    }
}
