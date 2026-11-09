//! M37 Preference sync (`/api/account/v1/preferences`).
//!
//! Synchronizes account-scoped user preferences across devices using per-key
//! last-write-wins (`changedAt` ISO-8601 timestamp).
//!
//! - Untouched local defaults carry `UNCHANGED_AT` (`1970-01-01T00:00:00.000Z`)
//!   so they seed missing keys on the server without overwriting real edits.
//! - Client timestamps ahead of the server clock are clamped by the server.
//! - If the server returns `404 Not Found` on `/api/account/v1/preferences`,
//!   preference sync treats the endpoint as unsupported without raising an error.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::client::{AccountError, AccountService, HostedClient};
use crate::endpoint::HostedOrigin;

/// Epoch timestamp used when a local preference still holds its untouched default.
pub const UNCHANGED_AT: &str = "1970-01-01T00:00:00.000Z";

/// One preference stored on the Hosted server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePreference {
    pub value: Value,
    pub changed_at: String,
}

/// One preference write sent to `PUT /api/account/v1/preferences`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceWrite {
    pub key: String,
    pub value: Value,
    pub changed_at: String,
}

/// Per-key timestamp and dirty bit in the local preference ledger.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreferenceLedgerEntry {
    pub changed_at: String,
    pub pending: bool,
}

/// Local preference ledger tracking account ownership and per-key change timestamps.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreferenceLedger {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default)]
    pub entries: BTreeMap<String, PreferenceLedgerEntry>,
}

/// Server response for `/api/account/v1/preferences`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreferenceEndpointStatus {
    /// Server supports preference sync and returned the current map.
    Supported(BTreeMap<String, RemotePreference>),
    /// Server returned `404 Not Found`; preferences remain local-only.
    Unsupported,
}

/// Outcome of a single preference sync round.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreferenceSyncOutcome {
    /// False when the server returned `404 Not Found`.
    pub supported: bool,
    /// Remote values that won over local state and should be applied locally.
    pub applied: BTreeMap<String, Value>,
    /// Keys that were uploaded to the server in this round.
    pub pushed_keys: Vec<String>,
    /// Updated ledger to persist locally (with `pending` cleared for synced keys).
    pub ledger: PreferenceLedger,
}

/// Format current UTC time as an ISO-8601 / RFC 3339 millisecond string.
#[must_use]
pub fn now_iso8601() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Compare two ISO-8601 / RFC 3339 timestamps chronologically.
#[must_use]
pub fn compare_iso_timestamps(a: &str, b: &str) -> Ordering {
    match (
        DateTime::parse_from_rfc3339(a),
        DateTime::parse_from_rfc3339(b),
    ) {
        (Ok(ta), Ok(tb)) => ta.cmp(&tb),
        _ => a.cmp(b),
    }
}

/// Clamp `client_changed_at` so it never exceeds `server_now`.
#[must_use]
pub fn clamp_to_server_clock(client_changed_at: &str, server_now: &str) -> String {
    if compare_iso_timestamps(client_changed_at, server_now) == Ordering::Greater {
        server_now.to_owned()
    } else {
        client_changed_at.to_owned()
    }
}

impl AccountService {
    /// Run one full preference sync round for the currently signed-in account.
    ///
    /// - `keys`: the allowlist of account-synced preference keys.
    /// - `local_values`: current local value for each key in `keys`.
    /// - `ledger`: current local preference ledger.
    pub fn sync_preferences(
        &self,
        keys: &[&str],
        local_values: &BTreeMap<String, Value>,
        ledger: &PreferenceLedger,
    ) -> Result<PreferenceSyncOutcome, AccountError> {
        let Some(origin) = self.config().origin() else {
            return Ok(PreferenceSyncOutcome {
                supported: false,
                applied: BTreeMap::new(),
                pushed_keys: Vec::new(),
                ledger: ledger.clone(),
            });
        };
        let state = self.state();
        let Some(user) = state.user else {
            return Ok(PreferenceSyncOutcome {
                supported: false,
                applied: BTreeMap::new(),
                pushed_keys: Vec::new(),
                ledger: ledger.clone(),
            });
        };
        let Some(token) = self.current_token() else {
            return Ok(PreferenceSyncOutcome {
                supported: false,
                applied: BTreeMap::new(),
                pushed_keys: Vec::new(),
                ledger: ledger.clone(),
            });
        };

        sync_preferences_with_client(
            self.client(),
            origin,
            &token,
            &user.id,
            keys,
            local_values,
            ledger,
        )
    }
}

/// Execute the preference sync protocol against `client`.
pub fn sync_preferences_with_client(
    client: &HostedClient,
    origin: &HostedOrigin,
    token: &str,
    account_id: &str,
    keys: &[&str],
    local_values: &BTreeMap<String, Value>,
    ledger: &PreferenceLedger,
) -> Result<PreferenceSyncOutcome, AccountError> {
    // Switching from one signed-in account to another clears pending flags from
    // the previous account so Account A's unpushed edits do not overwrite Account B.
    let mut next_ledger = if ledger.account_id.as_deref() == Some(account_id) {
        ledger.clone()
    } else {
        let clear_pending = ledger.account_id.is_some();
        let entries = ledger
            .entries
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    PreferenceLedgerEntry {
                        changed_at: v.changed_at.clone(),
                        pending: if clear_pending { false } else { v.pending },
                    },
                )
            })
            .collect();
        PreferenceLedger {
            account_id: Some(account_id.to_owned()),
            entries,
        }
    };

    let remote = match client.get_preferences(origin, token)? {
        PreferenceEndpointStatus::Unsupported => {
            return Ok(PreferenceSyncOutcome {
                supported: false,
                applied: BTreeMap::new(),
                pushed_keys: Vec::new(),
                ledger: next_ledger,
            });
        }
        PreferenceEndpointStatus::Supported(map) => map,
    };

    let mut to_put: Vec<PreferenceWrite> = Vec::new();
    let mut applied: BTreeMap<String, Value> = BTreeMap::new();

    for &key in keys {
        let Some(local_value) = local_values.get(key) else {
            continue;
        };
        let entry = next_ledger.entries.get(key);
        let local_at = entry.map(|e| e.changed_at.as_str()).unwrap_or(UNCHANGED_AT);

        if let Some(remote_entry) = remote.get(key) {
            if entry.is_some_and(|e| e.pending)
                && compare_iso_timestamps(local_at, &remote_entry.changed_at) == Ordering::Greater
            {
                to_put.push(PreferenceWrite {
                    key: key.to_owned(),
                    value: local_value.clone(),
                    changed_at: local_at.to_owned(),
                });
            } else {
                applied.insert(key.to_owned(), remote_entry.value.clone());
                next_ledger.entries.insert(
                    key.to_owned(),
                    PreferenceLedgerEntry {
                        changed_at: remote_entry.changed_at.clone(),
                        pending: false,
                    },
                );
            }
        } else {
            to_put.push(PreferenceWrite {
                key: key.to_owned(),
                value: local_value.clone(),
                changed_at: local_at.to_owned(),
            });
        }
    }

    let mut pushed_keys = Vec::new();
    if !to_put.is_empty() {
        match client.put_preferences(origin, token, &to_put)? {
            PreferenceEndpointStatus::Unsupported => {
                return Ok(PreferenceSyncOutcome {
                    supported: false,
                    applied: BTreeMap::new(),
                    pushed_keys: Vec::new(),
                    ledger: next_ledger,
                });
            }
            PreferenceEndpointStatus::Supported(saved) => {
                for item in to_put {
                    pushed_keys.push(item.key.clone());
                    let saved_entry = saved.get(&item.key);
                    let winner_at = saved_entry
                        .map(|s| s.changed_at.clone())
                        .unwrap_or_else(|| item.changed_at.clone());
                    if let Some(s) = saved_entry
                        && s.value != item.value
                    {
                        applied.insert(item.key.clone(), s.value.clone());
                    }
                    next_ledger.entries.insert(
                        item.key,
                        PreferenceLedgerEntry {
                            changed_at: winner_at,
                            pending: false,
                        },
                    );
                }
            }
        }
    }

    Ok(PreferenceSyncOutcome {
        supported: true,
        applied,
        pushed_keys,
        ledger: next_ledger,
    })
}
