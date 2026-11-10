use dr_model::id::BookId;
use dr_store::{Library, StoreError};
use serde::{Deserialize, Serialize};

use super::{CheckinCard, CheckinOutcome, DeltaCursor};
use crate::{Error, Result};

pub const CHECKIN_COOLDOWN_MS: i64 = 90 * 60 * 1_000;
pub const CHECKIN_AWAY_MS: i64 = 6 * 60 * 60 * 1_000;
pub const CHECKIN_LOOKBACK_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
const SCOPE: &str = "agent.proactive";
const MAX_STORED_CARDS: usize = 12;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CardStatus {
    Open,
    Starting { claim: String },
    Started { conversation: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredCard {
    pub card: CheckinCard,
    pub created_ms: i64,
    pub status: CardStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuggestionTicket {
    pub id: String,
    pub started_ms: i64,
    pub coverage: DeltaCursor,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ActiveSuggestion {
    Checkin { ticket: SuggestionTicket },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProactiveState {
    pub version: u32,
    pub revision: u64,
    pub last_opened_ms: Option<i64>,
    pub last_attempt_ms: Option<i64>,
    pub last_checkin_ms: Option<i64>,
    pub checkin_cursor: DeltaCursor,
    pub cards: Vec<StoredCard>,
    pub active: Option<ActiveSuggestion>,
    pub error: Option<String>,
}

impl Default for ProactiveState {
    fn default() -> Self {
        Self {
            version: 1,
            revision: 0,
            last_opened_ms: None,
            last_attempt_ms: None,
            last_checkin_ms: None,
            checkin_cursor: DeltaCursor::default(),
            cards: Vec::new(),
            active: None,
            error: None,
        }
    }
}

/// The caller collects under its resource lease and then atomically claims
/// this state revision immediately before starting a model/session.
#[derive(Clone, Debug)]
pub struct SuggestionStart {
    pub expected_revision: u64,
    pub id: String,
    pub now_ms: i64,
    pub enabled: bool,
    pub coverage: DeltaCursor,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardClaim {
    pub id: String,
    pub card: CheckinCard,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckinMode {
    Changes,
    Resume,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckinDecision {
    Disabled,
    ModelUnavailable,
    Busy,
    Cooldown,
    NothingNew,
    Run(CheckinMode),
}

pub struct CheckinEligibility<'a> {
    pub state: &'a ProactiveState,
    pub now_ms: i64,
    pub enabled: bool,
    pub model_ready: bool,
    pub has_changes: bool,
    pub has_recent_changes: bool,
    pub previous_opened_ms: Option<i64>,
}

/// Every check-in trigger uses the same 90 minutes.
pub fn decide_checkin(input: CheckinEligibility<'_>) -> CheckinDecision {
    if !input.enabled {
        return CheckinDecision::Disabled;
    }
    if !input.model_ready {
        return CheckinDecision::ModelUnavailable;
    }
    if input.state.active.is_some() {
        return CheckinDecision::Busy;
    }
    if input
        .state
        .last_attempt_ms
        .is_some_and(|at| input.now_ms.saturating_sub(at) < CHECKIN_COOLDOWN_MS)
    {
        return CheckinDecision::Cooldown;
    }
    if input.has_changes {
        return CheckinDecision::Run(CheckinMode::Changes);
    }
    let waiting = input
        .state
        .cards
        .iter()
        .any(|c| matches!(c.status, CardStatus::Open | CardStatus::Starting { .. }));
    if !waiting
        && input.has_recent_changes
        && input
            .previous_opened_ms
            .is_some_and(|at| input.now_ms.saturating_sub(at) >= CHECKIN_AWAY_MS)
    {
        CheckinDecision::Run(CheckinMode::Resume)
    } else {
        CheckinDecision::NothingNew
    }
}

fn invalid(message: impl ToString) -> StoreError {
    StoreError::Invalid {
        what: "proactive state",
        value: message.to_string(),
    }
}

fn decode(raw: Option<&str>) -> std::result::Result<ProactiveState, StoreError> {
    let state: ProactiveState = raw
        .map(serde_json::from_str)
        .transpose()
        .map_err(invalid)?
        .unwrap_or_default();
    if state.version != 1 {
        return Err(invalid("unsupported state version"));
    }
    Ok(state)
}

/// No retained Library/Workspace reference. Every operation borrows the
/// caller's lease and uses one local transaction for book existence + CAS.
pub struct ProactiveStore;

impl ProactiveStore {
    pub fn load(lib: &Library, book: &BookId) -> Result<ProactiveState> {
        Ok(decode(lib.local_get(SCOPE, book.as_str())?.as_deref())?)
    }

    fn update<T>(
        lib: &Library,
        book: &BookId,
        work: impl FnOnce(&mut ProactiveState) -> std::result::Result<(T, bool), StoreError>,
    ) -> Result<T> {
        Ok(lib.local_write(|tx| {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM loro_doc WHERE doc_id = ?1 AND kind = 'book')",
                [format!("book:{book}")],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(StoreError::NotFound(book.to_string()));
            }
            let raw = tx.get_state(SCOPE, book.as_str())?;
            let mut state = decode(raw.as_deref())?;
            let (result, changed) = work(&mut state)?;
            if changed {
                state.revision = state
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| invalid("revision exhausted"))?;
                tx.set_state(
                    SCOPE,
                    book.as_str(),
                    &serde_json::to_string(&state).map_err(invalid)?,
                    Some(book.as_str()),
                )?;
            }
            Ok(result)
        })?)
    }

    pub fn record_open(lib: &Library, book: &BookId, now_ms: i64) -> Result<Option<i64>> {
        Self::update(lib, book, |state| {
            let old = state.last_opened_ms.replace(now_ms);
            Ok((old, old != Some(now_ms)))
        })
    }

    pub fn begin_checkin(
        lib: &Library,
        book: &BookId,
        start: &SuggestionStart,
    ) -> Result<Option<SuggestionTicket>> {
        Self::begin(lib, book, start)
    }

    fn begin(
        lib: &Library,
        book: &BookId,
        start: &SuggestionStart,
    ) -> Result<Option<SuggestionTicket>> {
        dr_model::id::check_id(&start.id).map_err(|e| Error::Protocol(e.to_string()))?;
        Self::update(lib, book, |state| {
            if !start.enabled
                || state.revision != start.expected_revision
                || state.active.is_some()
                || (state
                    .last_attempt_ms
                    .is_some_and(|at| start.now_ms.saturating_sub(at) < CHECKIN_COOLDOWN_MS))
            {
                return Ok((None, false));
            }
            let ticket = SuggestionTicket {
                id: start.id.clone(),
                started_ms: start.now_ms,
                coverage: start.coverage.clone(),
            };

            state.last_attempt_ms = Some(start.now_ms);
            state.active = Some(ActiveSuggestion::Checkin {
                ticket: ticket.clone(),
            });

            state.error = None;
            Ok((Some(ticket), true))
        })
    }

    pub fn complete_checkin(
        lib: &Library,
        book: &BookId,
        ticket: &SuggestionTicket,
        result: &CheckinOutcome,
    ) -> Result<bool> {
        Self::update(lib, book, |state| {
            if !matches!(&state.active, Some(ActiveSuggestion::Checkin { ticket: current }) if current == ticket)
            {
                return Ok((false, false));
            }
            if result.cards.len() > 4 {
                return Err(invalid("too many suggestion cards"));
            }
            let mut cards: Vec<_> = result
                .cards
                .iter()
                .cloned()
                .map(|card| StoredCard {
                    card,
                    created_ms: ticket.started_ms,
                    status: CardStatus::Open,
                })
                .collect();
            cards.extend(
                state
                    .cards
                    .iter()
                    .filter(|card| !matches!(card.status, CardStatus::Open))
                    .cloned(),
            );
            cards.truncate(MAX_STORED_CARDS);
            state.cards = cards;
            state.checkin_cursor = ticket.coverage.clone();
            state.last_checkin_ms = Some(ticket.started_ms);
            state.active = None;
            state.error = None;
            Ok((true, true))
        })
    }

    pub fn fail_checkin(
        lib: &Library,
        book: &BookId,
        ticket: &SuggestionTicket,
        message: &str,
    ) -> Result<bool> {
        Self::update(lib, book, |state| {
            if !matches!(&state.active, Some(ActiveSuggestion::Checkin { ticket: current }) if current == ticket)
            {
                return Ok((false, false));
            }
            state.active = None;
            state.error = Some(super::delta::bounded(message, 500));
            Ok((true, true))
        })
    }

    pub fn dismiss_card(lib: &Library, book: &BookId, card: &str) -> Result<bool> {
        Self::update(lib, book, |state| {
            let old = state.cards.len();
            state
                .cards
                .retain(|c| c.card.id != card || matches!(c.status, CardStatus::Starting { .. }));
            let changed = old != state.cards.len();
            Ok((changed, changed))
        })
    }

    pub fn claim_card(
        lib: &Library,
        book: &BookId,
        card: &str,
        claim: &str,
        enabled: bool,
    ) -> Result<Option<CardClaim>> {
        dr_model::id::check_id(claim).map_err(|e| Error::Protocol(e.to_string()))?;
        Self::update(lib, book, |state| {
            if !enabled {
                return Ok((None, false));
            }
            let Some(card) = state
                .cards
                .iter_mut()
                .find(|c| c.card.id == card && c.status == CardStatus::Open)
            else {
                return Ok((None, false));
            };
            card.status = CardStatus::Starting {
                claim: claim.into(),
            };
            Ok((
                Some(CardClaim {
                    id: claim.into(),
                    card: card.card.clone(),
                }),
                true,
            ))
        })
    }

    pub fn settle_card(
        lib: &Library,
        book: &BookId,
        claim: &CardClaim,
        conversation: Option<&str>,
    ) -> Result<bool> {
        Self::update(lib, book, |state| {
            let Some(card) = state.cards.iter_mut().find(|c| {
                c.card.id == claim.card.id
                    && matches!(&c.status, CardStatus::Starting { claim: id } if id == &claim.id)
            }) else {
                return Ok((false, false));
            };
            card.status = conversation
                .map(|id| CardStatus::Started {
                    conversation: id.into(),
                })
                .unwrap_or(CardStatus::Open);
            Ok((true, true))
        })
    }

    /// On startup only, after old runtime sessions have been recovered. A
    /// crashed request is never replayed, and its cooldown remains in force.
    pub fn recover(lib: &Library, book: &BookId) -> Result<bool> {
        Self::update(lib, book, |state| {
            let mut changed = state.active.take().is_some();
            for card in &mut state.cards {
                if matches!(card.status, CardStatus::Starting { .. }) {
                    card.status = CardStatus::Open;
                    changed = true;
                }
            }
            Ok((changed, changed))
        })
    }
}
