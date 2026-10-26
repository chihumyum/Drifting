use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;

const NO_PENDING_REQUEST: u64 = 0;
const NO_PENDING_ACTION: u8 = 0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum ShutdownAction {
    CloseWindow = 1,
    ExitApp = 2,
    /// Relaunch after a verified update was installed.
    RestartApp = 3,
}

impl ShutdownAction {
    fn from_u8(value: u8) -> Option<Self> {
        match value {
            value if value == Self::CloseWindow as u8 => Some(Self::CloseWindow),
            value if value == Self::ExitApp as u8 => Some(Self::ExitApp),
            value if value == Self::RestartApp as u8 => Some(Self::RestartApp),
            _ => None,
        }
    }

    /// Ending the process outranks hiding a window, and an explicit quit
    /// outranks the relaunch that follows an installed update.
    fn rank(self) -> u8 {
        match self {
            Self::CloseWindow => 0,
            Self::RestartApp => 1,
            Self::ExitApp => 2,
        }
    }
}

#[derive(Default)]
pub struct DeepLinkQueue(Mutex<Vec<String>>);

impl DeepLinkQueue {
    pub fn push_all(&self, urls: impl IntoIterator<Item = String>) {
        self.0
            .lock()
            .expect("deep-link queue mutex poisoned")
            .extend(urls);
    }

    /// Take the queued URLs that start with `prefix`, leaving every other URL
    /// for its own consumer (OAuth callbacks vs. location links).
    pub fn drain_matching(&self, prefix: &str) -> Vec<String> {
        let mut queue = self.0.lock().expect("deep-link queue mutex poisoned");
        let (taken, kept) = queue.drain(..).partition(|url| url.starts_with(prefix));
        *queue = kept;
        taken
    }
}

#[cfg(test)]
mod deep_link_queue_tests {
    use super::DeepLinkQueue;

    #[test]
    fn each_consumer_drains_only_its_prefix() {
        let queue = DeepLinkQueue::default();
        queue.push_all([
            "drifting://auth/callback?nativeState=a".to_string(),
            "drifting://open/p/chapters/id-x/prose.md#L3".to_string(),
        ]);
        assert_eq!(
            queue.drain_matching("drifting://open/"),
            vec!["drifting://open/p/chapters/id-x/prose.md#L3".to_string()]
        );
        assert!(queue.drain_matching("drifting://open/").is_empty());
        assert_eq!(
            queue.drain_matching("drifting://auth/"),
            vec!["drifting://auth/callback?nativeState=a".to_string()]
        );
    }
}

#[derive(Default)]
pub struct CloseCoordinator {
    next_request_id: AtomicU64,
    pending_request_id: AtomicU64,
    pending_action: AtomicU8,
    allow_next_close: AtomicBool,
    allow_next_exit: AtomicBool,
}

impl CloseCoordinator {
    pub fn begin(&self, action: ShutdownAction) -> u64 {
        let pending = self.pending_request_id.load(Ordering::Acquire);
        if pending != NO_PENDING_REQUEST {
            // One flush covers every overlapping request. Never downgrade the
            // pending action when requests arrive in either order.
            let _ =
                self.pending_action
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                        match ShutdownAction::from_u8(current) {
                            Some(current) if current.rank() >= action.rank() => None,
                            _ => Some(action as u8),
                        }
                    });
            return pending;
        }

        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.pending_action.store(action as u8, Ordering::Release);
        self.pending_request_id.store(request_id, Ordering::Release);
        request_id
    }

    pub fn complete(&self, request_id: u64) -> Option<ShutdownAction> {
        if request_id == NO_PENDING_REQUEST {
            return None;
        }

        let completed = self
            .pending_request_id
            .compare_exchange(
                request_id,
                NO_PENDING_REQUEST,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok();
        if !completed {
            return None;
        }

        ShutdownAction::from_u8(
            self.pending_action
                .swap(NO_PENDING_ACTION, Ordering::AcqRel),
        )
    }

    pub fn pending_request_id(&self) -> Option<u64> {
        match self.pending_request_id.load(Ordering::Acquire) {
            NO_PENDING_REQUEST => None,
            request_id => Some(request_id),
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub fn permit_next_close(&self) {
        self.allow_next_close.store(true, Ordering::Release);
    }

    #[cfg(desktop)]
    pub fn consume_close_permission(&self) -> bool {
        self.allow_next_close.swap(false, Ordering::AcqRel)
    }

    #[cfg(not(target_os = "macos"))]
    pub fn permit_next_exit(&self) {
        self.allow_next_exit.store(true, Ordering::Release);
    }

    pub fn consume_exit_permission(&self) -> bool {
        self.allow_next_exit.swap(false, Ordering::AcqRel)
    }
}

#[cfg(test)]
mod tests {
    use super::{CloseCoordinator, ShutdownAction};

    #[test]
    fn only_the_matching_close_request_can_complete() {
        let coordinator = CloseCoordinator::default();
        let request_id = coordinator.begin(ShutdownAction::CloseWindow);

        assert_eq!(coordinator.complete(request_id + 1), None);
        assert_eq!(coordinator.pending_request_id(), Some(request_id));
        assert_eq!(
            coordinator.complete(request_id),
            Some(ShutdownAction::CloseWindow)
        );
        assert_eq!(coordinator.pending_request_id(), None);
        assert_eq!(coordinator.complete(request_id), None);
    }

    #[test]
    fn an_exit_request_upgrades_an_existing_window_close() {
        let coordinator = CloseCoordinator::default();
        let request_id = coordinator.begin(ShutdownAction::CloseWindow);
        assert_eq!(coordinator.begin(ShutdownAction::ExitApp), request_id);
        assert_eq!(
            coordinator.complete(request_id),
            Some(ShutdownAction::ExitApp)
        );
    }

    #[test]
    fn an_update_restart_outranks_a_window_close_but_not_a_quit() {
        let coordinator = CloseCoordinator::default();
        let request_id = coordinator.begin(ShutdownAction::CloseWindow);
        assert_eq!(coordinator.begin(ShutdownAction::RestartApp), request_id);
        assert_eq!(coordinator.begin(ShutdownAction::CloseWindow), request_id);
        assert_eq!(
            coordinator.complete(request_id),
            Some(ShutdownAction::RestartApp)
        );

        let request_id = coordinator.begin(ShutdownAction::ExitApp);
        assert_eq!(coordinator.begin(ShutdownAction::RestartApp), request_id);
        assert_eq!(
            coordinator.complete(request_id),
            Some(ShutdownAction::ExitApp)
        );
    }
}
