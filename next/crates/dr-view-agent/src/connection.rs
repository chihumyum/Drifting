//! Shared model connections for the companion and Settings. Credentials never
//! enter serializable view state. Conversation sends still use M27's runtime;
//! the only direct completion here is the author's explicit connection test.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use dr_agent::{
    Cancellation, Driver, DriverEvent, DriverRequest, FinishReason, LocalRoute, ModelCapabilities,
    ModelErrorCategory, ModelRoute, Provider, RunConfig, ThinkingLevel,
};
use dr_agent_providers::{
    ProviderDriver,
    catalog::{self, Catalog, CatalogCache, CatalogSource, ModelInfo},
    credentials::Credentials,
    oauth::{AccountSummary, DeviceCode, OAuthCancellation},
};
use dr_model::conversation::{ConversationEntry, ConversationEntryKind};
use dr_shell::{Settings, settings::registry};
use futures::{FutureExt, StreamExt, future::BoxFuture, future::Shared};
use gpui::{App, Context, Task};
use serde::{Deserialize, Serialize};

use crate::local::{self, LocalFailure, LocalServer, LocalServerModel};

pub const PROVIDERS: [Provider; 4] = [
    Provider::Chatgpt,
    Provider::Deepseek,
    Provider::Anthropic,
    Provider::Openai,
];

pub fn provider_name(provider: Provider) -> &'static str {
    match provider {
        Provider::Chatgpt => "ChatGPT",
        Provider::Deepseek => "DeepSeek",
        Provider::Anthropic => "Anthropic",
        Provider::Openai => "OpenAI",
        // Each local server is shown by its own name (`LocalServer::label`).
        Provider::Local => "Local",
    }
}

pub fn key_page(provider: Provider) -> Option<&'static str> {
    match provider {
        Provider::Deepseek => Some("https://platform.deepseek.com/api_keys"),
        Provider::Anthropic => Some("https://console.anthropic.com/settings/keys"),
        Provider::Openai => Some("https://platform.openai.com/api-keys"),
        Provider::Chatgpt | Provider::Local => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Readiness {
    Checking,
    Missing,
    Ready,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preferences {
    pub route: ModelRoute,
    pub max_model_rounds: Option<u32>,
    /// With a local route: which server (device memory, not an account
    /// preference — the address means nothing on another computer).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_server: Option<String>,
}

impl Default for Preferences {
    fn default() -> Self {
        let model = catalog::bundled_models(Provider::Deepseek).remove(0);
        Self {
            route: ModelRoute {
                provider: model.provider,
                model: model.id.clone(),
                thinking: default_thinking(&model),
                local: None,
            },
            max_model_rounds: Some(50),
            local_server: None,
        }
    }
}

impl Preferences {
    pub fn read(cx: &App) -> Self {
        if !cx.has_global::<Settings>() {
            return Self::default();
        }
        let file = Settings::read(cx);
        Self::from_value(Some(serde_json::json!({
            "route": {"provider":file.get(registry::AGENT_PROVIDER), "model":file.get(registry::AGENT_MODEL), "thinking":file.get(registry::AGENT_THINKING)},
            "max_model_rounds":file.get(registry::AGENT_MAX_MODEL_ROUNDS),
            "local_server":local::read_selected(cx),
        })))
    }
    pub fn from_value(value: Option<serde_json::Value>) -> Self {
        value
            .and_then(|value| serde_json::from_value::<Self>(value).ok())
            .filter(|value| {
                !value.route.model.trim().is_empty() && value.max_model_rounds != Some(0)
            })
            .unwrap_or_default()
    }
}

pub fn thinking_levels(model: &ModelInfo) -> Vec<ThinkingLevel> {
    let mut levels = Vec::new();
    if model.thinking_modes.iter().any(|mode| mode == "off") {
        levels.push(ThinkingLevel::Off);
    }
    if model.thinking_modes.iter().any(|mode| mode == "adaptive") {
        levels.extend(model.efforts.iter().filter_map(|effort| {
            serde_json::from_value::<ThinkingLevel>(serde_json::Value::String(effort.clone())).ok()
        }));
    }
    levels
}

pub fn default_thinking(model: &ModelInfo) -> ThinkingLevel {
    let levels = thinking_levels(model);
    let preferred = if model.default_thinking == "off" {
        ThinkingLevel::Off
    } else {
        serde_json::from_value(serde_json::Value::String(model.default_effort.clone()))
            .unwrap_or(ThinkingLevel::High)
    };
    if levels.contains(&preferred) {
        preferred
    } else {
        levels.first().copied().unwrap_or_default()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Failure {
    #[error("enter an API key")]
    Empty,
    #[error("the credential store refused the change")]
    Storage,
    #[error("the provider request failed")]
    Provider(ModelErrorCategory),
    #[error("select an available model")]
    Unavailable,
    #[error("the device login code expired")]
    Expired,
}

impl From<dr_agent_providers::ProviderError> for Failure {
    fn from(error: dr_agent_providers::ProviderError) -> Self {
        Self::Provider(error.category)
    }
}

impl From<dr_agent::Error> for Failure {
    fn from(error: dr_agent::Error) -> Self {
        Self::Provider(match error {
            dr_agent::Error::Provider(failure) => failure.category,
            _ => ModelErrorCategory::InvalidResponse,
        })
    }
}

/// The network/credential part is independently testable with a loopback
/// ProviderDriver and SecretStore::in_memory, without opening a GPUI window.
#[derive(Clone)]
pub struct ConnectionService {
    driver: ProviderDriver,
    catalog: Arc<CatalogCache>,
    catalog_endpoints: HashMap<Provider, String>,
    /// How long 「测试连接」 waits for a local model's answer.
    local_wait: Duration,
}

impl ConnectionService {
    pub fn new(driver: ProviderDriver) -> Self {
        Self {
            driver,
            catalog: Arc::default(),
            catalog_endpoints: HashMap::new(),
            local_wait: dr_agent_providers::local::MODEL_WAIT,
        }
    }

    /// Tests wait less than [`dr_agent_providers::local::MODEL_WAIT`].
    pub fn with_local_test_wait(mut self, wait: Duration) -> Self {
        self.local_wait = wait;
        self
    }

    pub(crate) fn local_wait(&self) -> Duration {
        self.local_wait
    }
    pub fn driver(&self) -> ProviderDriver {
        self.driver.clone()
    }

    /// Explicit loopback/gateway seam, like ProviderDriver::with_endpoints.
    /// Tests provide every endpoint they exercise; there is no environment or
    /// global production fallback injected by the view.
    pub fn with_catalog_endpoint(mut self, provider: Provider, endpoint: String) -> Self {
        self.catalog_endpoints.insert(provider, endpoint);
        self
    }

    pub async fn probe(&self, model: &ModelInfo, candidate: Option<&str>) -> Result<(), Failure> {
        let driver = match candidate {
            Some(value) => self
                .driver
                .with_credentials(Credentials::candidate(model.provider, value)?),
            None => self.driver.clone(),
        };
        let levels = thinking_levels(model);
        let thinking = levels.first().copied().ok_or(Failure::Unavailable)?;
        let config = model.run_config(thinking)?;
        let output = if model.provider == Provider::Anthropic || thinking != ThinkingLevel::Off {
            1024
        } else {
            32
        };
        match tokio::time::timeout(Duration::from_secs(90), say_ok(&driver, config, output)).await {
            Ok(result) => result,
            // Dropping the timed-out stream cancels its transport task.
            Err(_) => Err(Failure::Provider(ModelErrorCategory::Network)),
        }
    }

    pub async fn connect_key(&self, model: &ModelInfo, value: String) -> Result<(), Failure> {
        let value = value.trim();
        if value.is_empty() {
            return Err(Failure::Empty);
        }
        self.probe(model, Some(value)).await?;
        self.driver
            .credentials()
            .set_api_key(model.provider, value.to_owned())
            .await
            .map_err(|_| Failure::Storage)?;
        self.catalog.clear();
        Ok(())
    }

    async fn list(&self, provider: Provider) -> Catalog {
        let endpoint = self.catalog_endpoints.get(&provider).map(String::as_str);
        if provider == Provider::Chatgpt {
            self.catalog
                .list_chatgpt(
                    self.driver.http().raw(),
                    self.driver.oauth(),
                    &OAuthCancellation::default(),
                    endpoint,
                )
                .await
        } else {
            self.catalog
                .list(
                    self.driver.http().raw(),
                    self.driver.credentials(),
                    provider,
                    endpoint,
                )
                .await
        }
    }
}

/// A run on one local server's model: no reasoning setting, no hosted search.
fn local_config(server: &LocalServer, model: &LocalServerModel) -> RunConfig {
    let mut config = RunConfig::new(Provider::Local, &model.id);
    config.route.local = Some(LocalRoute {
        server: server.id.clone(),
        base_url: server.base_url.clone(),
    });
    config.web_search = false;
    config.capabilities = Some(ModelCapabilities {
        context_window: model.context_window(),
        supports_thinking_off: Some(true),
        ..ModelCapabilities::default()
    });
    config
}

/// One short exchange: the model must answer 「OK」 in text and finish. The
/// caller decides how long to wait (dropping the future cancels the request).
pub(crate) async fn say_ok(
    driver: &ProviderDriver,
    mut config: RunConfig,
    max_output_tokens: u32,
) -> Result<(), Failure> {
    config.system_prompt = "Return exactly OK.".into();
    config.web_search = false;
    config.max_model_rounds = Some(1);
    config.max_output_tokens = Some(max_output_tokens);
    let request = DriverRequest {
        purpose: dr_agent::RequestPurpose::Chat,
        config: Arc::new(config),
        session: "connectivity-check".into(),
        turn: 1,
        round: 1,
        conversation: vec![ConversationEntry {
            id: "connectivity-check:1".into(),
            session: "connectivity-check".into(),
            turn: 1,
            kind: ConversationEntryKind::User,
            payload: serde_json::json!({"text":"Return exactly OK."}),
        }],
        tools: Vec::new(),
    };
    let mut stream = driver.stream(request, Cancellation::default());
    let mut text = false;
    let mut finish = false;
    while let Some(event) = stream.next().await {
        match event? {
            DriverEvent::TextDelta { text: delta, .. } => text |= !delta.trim().is_empty(),
            DriverEvent::Finish(FinishReason::Complete) => finish = true,
            DriverEvent::ToolCall(_) | DriverEvent::Finish(FinishReason::Tools) => {
                return Err(Failure::Provider(ModelErrorCategory::InvalidResponse));
            }
            _ => {}
        }
    }
    if text && finish {
        Ok(())
    } else {
        Err(Failure::Provider(ModelErrorCategory::InvalidResponse))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Connecting(Provider),
    Testing(Provider),
    Removing(Provider),
    Login,
    Logout,
}

/// Only public display fields of the device capability reach the view.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoginCode {
    pub user_code: String,
    pub verification_url: String,
    pub expires_at_ms: u64,
}

impl From<&DeviceCode> for LoginCode {
    fn from(device: &DeviceCode) -> Self {
        Self {
            user_code: device.user_code.clone(),
            verification_url: device.verification_url.clone(),
            expires_at_ms: device.expires_at_ms,
        }
    }
}

type LoginCleanup = Shared<BoxFuture<'static, dr_agent_providers::Result<()>>>;

/// Cleanup is dispatched on the provider executor immediately, independently
/// of the GPUI task. Dropping a login UI cannot abandon an in-flight native
/// credential write. All cancellation paths await the same logout barrier.
#[derive(Clone)]
struct LoginCancellation {
    cancel: OAuthCancellation,
    driver: ProviderDriver,
    cleanup: Arc<Mutex<Option<LoginCleanup>>>,
}

impl LoginCancellation {
    fn new(driver: ProviderDriver) -> Self {
        Self {
            cancel: OAuthCancellation::default(),
            driver,
            cleanup: Arc::new(Mutex::new(None)),
        }
    }

    fn cancel(&self) -> LoginCleanup {
        self.cancel.cancel();
        let mut cleanup = self
            .cleanup
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        cleanup
            .get_or_insert_with(|| {
                let oauth = self.driver.oauth().clone();
                let task = self
                    .driver
                    .http()
                    .spawn(async move { oauth.logout().await });
                async move {
                    task.await.map_err(|_| {
                        dr_agent_providers::ProviderError::protocol("OAuth cleanup worker failed")
                    })?
                }
                .boxed()
                .shared()
            })
            .clone()
    }
}

pub struct Connections {
    service: ConnectionService,
    preferences: Preferences,
    readiness: HashMap<Provider, Readiness>,
    catalogs: HashMap<Provider, Catalog>,
    pub account: Option<AccountSummary>,
    pub operation: Option<Operation>,
    pub failure: Option<Failure>,
    pub failure_provider: Option<Provider>,
    pub tested: Option<Provider>,
    pub login: Option<LoginCode>,
    generation: u64,
    refresh_generation: u64,
    catalog_generation: HashMap<Provider, u64>,
    login_cancel: Option<LoginCancellation>,
    task: Option<Task<()>>,
    local: Vec<LocalServer>,
    /// 「测试连接」 for one server: `None` while it runs.
    pub local_test: Option<(String, Option<Result<(), LocalFailure>>)>,
    /// The test still waiting for a model; 「断开」 or a reconnect stops it.
    local_test_abort: Option<tokio::task::AbortHandle>,
    local_test_generation: u64,
    /// A failed key removal or disconnect, shown under that server.
    pub local_failure: Option<(String, LocalFailure)>,
    local_listed: HashMap<String, std::time::Instant>,
    local_generation: u64,
}

impl Connections {
    pub fn new(driver: ProviderDriver, cx: &mut Context<Self>) -> Self {
        Self::with_service(ConnectionService::new(driver), cx)
    }

    pub fn with_service(service: ConnectionService, cx: &mut Context<Self>) -> Self {
        let preferences = Preferences::read(cx);
        let mut connections = Self {
            service,
            preferences,
            readiness: PROVIDERS
                .into_iter()
                .map(|provider| (provider, Readiness::Checking))
                .collect(),
            catalogs: PROVIDERS
                .into_iter()
                .map(|provider| {
                    (
                        provider,
                        Catalog {
                            models: catalog::bundled_models(provider),
                            source: CatalogSource::Bundled,
                            refresh_after_ms: 0,
                            failure: None,
                        },
                    )
                })
                .collect(),
            account: None,
            operation: None,
            failure: None,
            failure_provider: None,
            tested: None,
            login: None,
            generation: 0,
            refresh_generation: 0,
            catalog_generation: HashMap::new(),
            login_cancel: None,
            task: None,
            local: local::read(cx),
            local_test: None,
            local_test_abort: None,
            local_test_generation: 0,
            local_failure: None,
            local_listed: HashMap::new(),
            local_generation: 0,
        };
        // The round limit is also written behind this entity's back: by
        // preference sync (M37) and by the 0.1 import's settings
        // (`dr_shell::settings::v1`). Follow it, or the next `save` would
        // write the old limit back.
        let this = cx.weak_entity();
        dr_shell::settings::on_changed(cx, move |cx| {
            let this = this.clone();
            cx.defer(move |cx| {
                let _ = this.update(cx, |connections, cx| connections.follow_settings(cx));
            });
        });
        connections.refresh(cx);
        connections
    }

    /// Takes the round limit the settings hold now, when it is not this
    /// entity's (the route stays this entity's: it checks it).
    fn follow_settings(&mut self, cx: &mut Context<Self>) {
        if !cx.has_global::<Settings>() {
            return;
        }
        // `null`: no cap; the registry keeps any other value a positive one.
        let rounds = Settings::read(cx)
            .get(registry::AGENT_MAX_MODEL_ROUNDS)
            .as_u64()
            .and_then(|n| u32::try_from(n).ok());
        if rounds != self.preferences.max_model_rounds {
            self.preferences.max_model_rounds = rounds;
            cx.notify();
        }
    }

    pub fn driver(&self) -> ProviderDriver {
        self.service.driver()
    }

    /// Configure an explicit catalog endpoint before opening a model menu.
    pub fn set_catalog_endpoint(&mut self, provider: Provider, endpoint: String) {
        self.service.catalog_endpoints.insert(provider, endpoint);
        self.service.catalog.clear();
        *self.catalog_generation.entry(provider).or_default() += 1;
    }
    pub fn preferences(&self) -> &Preferences {
        &self.preferences
    }
    pub fn readiness(&self, provider: Provider) -> Readiness {
        self.readiness
            .get(&provider)
            .copied()
            .unwrap_or(Readiness::Checking)
    }
    pub fn usable(&self) -> Option<bool> {
        if self.preferences.route.provider == Provider::Local {
            // No live check: a server that is down still counts as connected
            // and the send reports the failure (作者 2026-11-16, 甲).
            return Some(self.selected_local().is_some());
        }
        match self.readiness(self.preferences.route.provider) {
            Readiness::Checking => None,
            Readiness::Ready => Some(true),
            _ => Some(false),
        }
    }
    pub fn models(&self, provider: Provider) -> &[ModelInfo] {
        self.catalogs
            .get(&provider)
            .map(|catalog| catalog.models.as_slice())
            .unwrap_or_default()
    }
    pub fn catalog(&self, provider: Provider) -> Option<&Catalog> {
        self.catalogs.get(&provider)
    }
    pub fn selected_model(&self) -> Option<&ModelInfo> {
        self.models(self.preferences.route.provider)
            .iter()
            .find(|model| model.id == self.preferences.route.model)
    }
    pub fn run_config(&self) -> dr_agent::Result<RunConfig> {
        if self.preferences.route.provider == Provider::Local {
            let (server, model) = self.selected_local().ok_or_else(|| {
                dr_agent::Error::Protocol("connect the selected local model".into())
            })?;
            let mut config = local_config(server, model);
            config.max_model_rounds = self.preferences.max_model_rounds;
            return Ok(config);
        }
        if self.usable() != Some(true) {
            return Err(dr_agent::Error::Protocol(
                "connect the selected model provider".into(),
            ));
        }
        let model = self
            .selected_model()
            .ok_or_else(|| dr_agent::Error::Protocol("select an available model".into()))?;
        let mut config = model.run_config(self.preferences.route.thinking)?;
        config.max_model_rounds = self.preferences.max_model_rounds;
        Ok(config)
    }

    fn save(&self, cx: &mut App) {
        if !cx.has_global::<Settings>() {
            return;
        }
        Settings::update(cx, |file| {
            for (key, value) in [
                (
                    registry::AGENT_PROVIDER,
                    serde_json::json!(self.preferences.route.provider),
                ),
                (
                    registry::AGENT_MODEL,
                    serde_json::json!(self.preferences.route.model),
                ),
                (
                    registry::AGENT_THINKING,
                    serde_json::json!(self.preferences.route.thinking),
                ),
                (
                    registry::AGENT_MAX_MODEL_ROUNDS,
                    serde_json::json!(self.preferences.max_model_rounds),
                ),
            ] {
                file.set(key, value, None)
                    .expect("validated Agent preference");
            }
        });
        local::write_selected(self.preferences.local_server.as_deref(), cx);
        cx.refresh_windows();
    }

    pub fn select_provider(&mut self, provider: Provider, cx: &mut Context<Self>) -> bool {
        if self.operation.is_some() || self.readiness(provider) != Readiness::Ready {
            return false;
        }
        let id = self
            .models(provider)
            .iter()
            .find(|model| model.id == self.preferences.route.model)
            .or_else(|| self.models(provider).first())
            .map(|model| model.id.clone());
        id.is_some_and(|id| self.select_model(provider, &id, cx))
    }

    pub fn select_model(&mut self, provider: Provider, id: &str, cx: &mut Context<Self>) -> bool {
        if self.operation.is_some() || self.readiness(provider) != Readiness::Ready {
            return false;
        }
        let Some(model) = self.models(provider).iter().find(|model| model.id == id) else {
            return false;
        };
        let thinking = if thinking_levels(model).contains(&self.preferences.route.thinking) {
            self.preferences.route.thinking
        } else {
            default_thinking(model)
        };
        self.preferences.route = ModelRoute {
            provider,
            model: id.into(),
            thinking,
            local: None,
        };
        self.preferences.local_server = None;
        self.failure = None;
        self.save(cx);
        cx.notify();
        true
    }

    pub fn set_thinking(&mut self, level: ThinkingLevel, cx: &mut Context<Self>) -> bool {
        if self.operation.is_some()
            || !self
                .selected_model()
                .is_some_and(|model| thinking_levels(model).contains(&level))
        {
            return false;
        }
        self.preferences.route.thinking = level;
        self.save(cx);
        cx.notify();
        true
    }

    pub fn set_max_model_rounds(&mut self, rounds: Option<u32>, cx: &mut Context<Self>) -> bool {
        if rounds == Some(0) {
            return false;
        }
        self.preferences.max_model_rounds = rounds;
        self.save(cx);
        cx.notify();
        true
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.operation.is_some() {
            return;
        }
        self.refresh_generation += 1;
        let generation = self.refresh_generation;
        let service = self.service.clone();
        let http = service.driver.http().clone();
        let task = http.spawn(async move {
            let mut statuses = HashMap::new();
            for provider in [Provider::Deepseek, Provider::Anthropic, Provider::Openai] {
                statuses.insert(
                    provider,
                    match service.driver.credentials().has_api_key(provider).await {
                        Ok(true) => Readiness::Ready,
                        Ok(false) => Readiness::Missing,
                        Err(_) => Readiness::Failed,
                    },
                );
            }
            let account = service.driver.oauth().status().await;
            statuses.insert(
                Provider::Chatgpt,
                match &account {
                    Ok(Some(_)) => Readiness::Ready,
                    Ok(None) => Readiness::Missing,
                    Err(_) => Readiness::Failed,
                },
            );
            (statuses, account.ok().flatten())
        });
        cx.spawn(async move |this, cx| {
            if let Ok((statuses, account)) = task.await {
                this.update(cx, |this, cx| {
                    if this.refresh_generation == generation {
                        this.readiness = statuses;
                        this.account = account;
                        cx.notify();
                    }
                })
                .ok();
            }
        })
        .detach();
    }

    pub fn load_catalog(&mut self, provider: Provider, cx: &mut Context<Self>) {
        if self.operation.is_some() || self.readiness(provider) != Readiness::Ready {
            return;
        }
        let generation = self.catalog_generation.entry(provider).or_default();
        *generation += 1;
        let generation = *generation;
        let service = self.service.clone();
        let http = service.driver.http().clone();
        let task = http.spawn(async move { service.list(provider).await });
        cx.spawn(async move |this, cx| {
            if let Ok(catalog) = task.await {
                this.update(cx, |this, cx| {
                    if this.catalog_generation.get(&provider) == Some(&generation)
                        && this.readiness(provider) == Readiness::Ready
                    {
                        this.catalogs.insert(provider, catalog);
                        cx.notify();
                    }
                })
                .ok();
            }
        })
        .detach();
    }

    fn begin(&mut self, operation: Operation, cx: &mut Context<Self>) -> Option<u64> {
        if self.operation.is_some() || dr_shell::release::is_releasing(cx) {
            return None;
        }
        self.generation += 1;
        self.refresh_generation += 1;
        self.operation = Some(operation);
        self.failure = None;
        self.failure_provider = Some(match operation {
            Operation::Connecting(provider)
            | Operation::Testing(provider)
            | Operation::Removing(provider) => provider,
            Operation::Login | Operation::Logout => Provider::Chatgpt,
        });
        self.tested = None;
        cx.notify();
        Some(self.generation)
    }

    pub fn connect_key(&mut self, provider: Provider, value: String, cx: &mut Context<Self>) {
        // The companion's path adds only. Replacement is an explicit Settings operation.
        if self.readiness(provider) == Readiness::Ready {
            return;
        }
        self.save_key(provider, value, cx);
    }

    /// Settings alone exposes replacement. A failed replacement preserves the old key.
    pub fn replace_key(&mut self, provider: Provider, value: String, cx: &mut Context<Self>) {
        self.save_key(provider, value, cx);
    }

    fn save_key(&mut self, provider: Provider, value: String, cx: &mut Context<Self>) {
        if provider == Provider::Chatgpt {
            return;
        }
        if value.trim().is_empty() {
            self.failure = Some(Failure::Empty);
            self.failure_provider = Some(provider);
            cx.notify();
            return;
        }
        let Some(model) = self
            .models(provider)
            .iter()
            .find(|model| model.id == self.preferences.route.model)
            .or_else(|| self.models(provider).first())
            .cloned()
        else {
            return;
        };
        let Some(generation) = self.begin(Operation::Connecting(provider), cx) else {
            return;
        };
        let service = self.service.clone();
        let http = service.driver.http().clone();
        let task = http.spawn(async move { service.connect_key(&model, value).await });
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = task
                .await
                .unwrap_or(Err(Failure::Provider(ModelErrorCategory::Network)));
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.operation = None;
                match result {
                    Ok(()) => {
                        this.readiness.insert(provider, Readiness::Ready);
                        this.tested = Some(provider);
                        this.select_provider(provider, cx);
                        this.load_catalog(provider, cx);
                    }
                    Err(error) => this.failure = Some(error),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    pub fn retest(&mut self, provider: Provider, cx: &mut Context<Self>) {
        let Some(model) = self
            .models(provider)
            .iter()
            .find(|model| model.id == self.preferences.route.model)
            .or_else(|| self.models(provider).first())
            .cloned()
        else {
            return;
        };
        let Some(generation) = self.begin(Operation::Testing(provider), cx) else {
            return;
        };
        let service = self.service.clone();
        let http = service.driver.http().clone();
        let task = http.spawn(async move { service.probe(&model, None).await });
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = task
                .await
                .unwrap_or(Err(Failure::Provider(ModelErrorCategory::Network)));
            this.update(cx, |this, cx| {
                if this.generation == generation {
                    this.operation = None;
                    this.failure = result.err();
                    this.tested = this.failure.is_none().then_some(provider);
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    pub fn remove_key(&mut self, provider: Provider, cx: &mut Context<Self>) {
        if provider == Provider::Chatgpt {
            return;
        }
        let Some(generation) = self.begin(Operation::Removing(provider), cx) else {
            return;
        };
        let service = self.service.clone();
        let http = service.driver.http().clone();
        let task = http.spawn(async move {
            service
                .driver
                .credentials()
                .remove_api_key(provider)
                .await
                .map_err(|_| Failure::Storage)
        });
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = task.await.unwrap_or(Err(Failure::Storage));
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.operation = None;
                this.failure = result.err();
                if this.failure.is_none() {
                    this.readiness.insert(provider, Readiness::Missing);
                    this.service.catalog.clear();
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Returns the operation identity for the view that owns this login.
    pub fn start_login(&mut self, cx: &mut Context<Self>) -> Option<u64> {
        let generation = self.begin(Operation::Login, cx)?;
        let service = self.service.clone();
        let cancellation = LoginCancellation::new(service.driver.clone());
        let cancel = cancellation.cancel.clone();
        self.login_cancel = Some(cancellation.clone());
        self.login = None;
        self.task = Some(cx.spawn(async move |this, cx| {
            let oauth = service.driver.oauth().clone();
            let http = service.driver.http().clone();
            let start_oauth = oauth.clone();
            let start_http = http.clone();
            let start_cancel = cancel.clone();
            let started = http
                .spawn(async move { start_oauth.start(start_http.raw(), &start_cancel).await })
                .await;
            let result = match started {
                Ok(Ok(device)) => {
                    let current = this
                        .update(cx, |this, cx| {
                            if this.generation != generation || cancel.is_cancelled() {
                                return false;
                            }
                            this.login = Some(LoginCode::from(&device));
                            cx.notify();
                            true
                        })
                        .unwrap_or(false);
                    if !current {
                        cancellation.cancel().await.ok();
                        Ok(Err(dr_agent_providers::ProviderError::cancelled()))
                    } else {
                        let finish_http = http.clone();
                        http.spawn(async move {
                            oauth.complete(finish_http.raw(), &device, &cancel).await
                        })
                        .await
                    }
                }
                other => other.map(|result| result.map(|_| unreachable!())),
            };
            let result = if cancellation.cancel.is_cancelled() {
                // Keep the operation lease until native storage and the
                // independently dispatched logout have both settled.
                Ok(Err(cancellation.cancel().await.err().unwrap_or_else(
                    dr_agent_providers::ProviderError::cancelled,
                )))
            } else {
                result
            };
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                let expired = this.login.as_ref().is_some_and(|login| {
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .is_ok_and(|elapsed| elapsed.as_millis() >= u128::from(login.expires_at_ms))
                });
                this.operation = None;
                this.login = None;
                this.login_cancel = None;
                match result {
                    Ok(Ok(account)) => {
                        this.account = Some(account);
                        this.readiness.insert(Provider::Chatgpt, Readiness::Ready);
                        this.select_provider(Provider::Chatgpt, cx);
                        this.load_catalog(Provider::Chatgpt, cx);
                    }
                    Ok(Err(error)) => {
                        if error.category == ModelErrorCategory::Cancelled {
                            this.account = None;
                            this.readiness.insert(Provider::Chatgpt, Readiness::Missing);
                            this.service.catalog.clear();
                        }
                        this.failure = Some(
                            if expired && error.category != ModelErrorCategory::Cancelled {
                                Failure::Expired
                            } else {
                                error.into()
                            },
                        )
                    }
                    Err(_) => this.failure = Some(Failure::Provider(ModelErrorCategory::Network)),
                }
                cx.notify();
            })
            .ok();
        }));
        Some(generation)
    }

    pub fn cancel_login(&mut self, cx: &mut Context<Self>) {
        if self.operation != Some(Operation::Login) {
            return;
        }
        if let Some(cancel) = &self.login_cancel {
            drop(cancel.cancel());
        }
        // Keep the operation lease until OAuth settles (including native I/O).
        self.login = None;
        cx.notify();
    }

    pub(crate) fn cancel_owned_login(&mut self, generation: u64, cx: &mut Context<Self>) {
        if self.generation == generation {
            self.cancel_login(cx);
        }
    }

    /// Ordinary quit/library release must wait for the same native-I/O and
    /// logout barrier as the login UI. The shell gate rejects new operations.
    pub fn prepare_release(
        &mut self,
        cx: &mut Context<Self>,
    ) -> BoxFuture<'static, Result<(), String>> {
        self.cancel_login(cx);
        match &self.login_cancel {
            Some(cancel) => {
                let cleanup = cancel.cancel();
                async move { cleanup.await.map_err(|error| error.to_string()) }.boxed()
            }
            None => async { Ok(()) }.boxed(),
        }
    }

    pub fn logout(&mut self, cx: &mut Context<Self>) {
        let Some(generation) = self.begin(Operation::Logout, cx) else {
            return;
        };
        let service = self.service.clone();
        let http = service.driver.http().clone();
        let task = http.spawn(async move { service.driver.oauth().logout().await });
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.operation = None;
                match result {
                    Ok(Ok(())) => {
                        this.account = None;
                        this.readiness.insert(Provider::Chatgpt, Readiness::Missing);
                        this.service.catalog.clear();
                    }
                    _ => this.failure = Some(Failure::Storage),
                }
                cx.notify();
            })
            .ok();
        }));
    }
}

/// Local model servers. The connection form (`local_view`) does the network
/// step through [`ConnectionService::probe_local`]; these keep the list,
/// the selection and the per-model settings.
impl Connections {
    pub fn service(&self) -> ConnectionService {
        self.service.clone()
    }

    pub fn local_servers(&self) -> &[LocalServer] {
        &self.local
    }

    pub fn local_server(&self, id: &str) -> Option<&LocalServer> {
        self.local.iter().find(|server| server.id == id)
    }

    /// The selected local server and model, if both still exist.
    pub fn selected_local(&self) -> Option<(&LocalServer, &LocalServerModel)> {
        if self.preferences.route.provider != Provider::Local {
            return None;
        }
        let server = self.local_server(self.preferences.local_server.as_deref()?)?;
        Some((server, server.model(&self.preferences.route.model)?))
    }

    fn write_local(&mut self, cx: &mut Context<Self>) {
        local::write(&self.local, cx);
        cx.notify();
    }

    /// A connected (or reconnected) server. `select` makes its first model
    /// the route, as connecting one of the four providers does.
    pub fn put_local(&mut self, server: LocalServer, select: bool, cx: &mut Context<Self>) {
        let id = server.id.clone();
        let first = server.models.first().map(|model| model.id.clone());
        match self.local.iter_mut().find(|old| old.id == server.id) {
            Some(old) => *old = server,
            None => self.local.push(server),
        }
        self.local_listed
            .insert(id.clone(), std::time::Instant::now());
        self.local_failure = None;
        self.stop_local_test();
        self.write_local(cx);
        let selected_here = self.preferences.route.provider == Provider::Local
            && self.preferences.local_server.as_deref() == Some(id.as_str());
        if let Some(first) = first
            && (select || (selected_here && self.selected_local().is_none()))
        {
            self.select_local(&id, &first, cx);
        }
    }

    pub fn select_local(&mut self, server: &str, model: &str, cx: &mut Context<Self>) -> bool {
        if self
            .local_server(server)
            .and_then(|found| found.model(model))
            .is_none()
        {
            return false;
        }
        // The reasoning level stays what it was for the providers that
        // have one; a local run always goes without (`run_config`).
        self.preferences.route = ModelRoute {
            provider: Provider::Local,
            model: model.into(),
            thinking: self.preferences.route.thinking,
            local: None,
        };
        self.preferences.local_server = Some(server.into());
        self.failure = None;
        self.save(cx);
        cx.notify();
        true
    }

    /// 「断开」: the key goes first; the server stays if that fails.
    pub fn disconnect_local(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(server) = self.local_server(id).cloned() else {
            return;
        };
        self.local_generation += 1;
        let generation = self.local_generation;
        let service = self.service.clone();
        let http = service.driver().http().clone();
        let task = http.spawn(async move { service.forget_local_key(&server.id).await });
        let id = id.to_owned();
        cx.spawn(async move |this, cx| {
            let result = task.await.unwrap_or(Err(LocalFailure::Storage));
            this.update(cx, |this, cx| {
                if this.local_generation != generation {
                    return;
                }
                match result {
                    Ok(()) => {
                        this.local.retain(|server| server.id != id);
                        this.local_listed.remove(&id);
                        if this
                            .local_test
                            .as_ref()
                            .is_some_and(|(test, _)| *test == id)
                        {
                            this.stop_local_test();
                        }
                        this.local_failure = None;
                        this.write_local(cx);
                    }
                    Err(error) => {
                        this.local_failure = Some((id.clone(), error));
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    fn stop_local_test(&mut self) {
        if let Some(abort) = self.local_test_abort.take() {
            abort.abort();
        }
        self.local_test = None;
    }

    /// The model 「测试连接」 asks: the selected one when it is on this
    /// server, otherwise the server's first.
    pub fn local_test_model(&self, id: &str) -> Option<&LocalServerModel> {
        let server = self.local_server(id)?;
        match self.selected_local() {
            Some((selected, model)) if selected.id == id => Some(model),
            _ => server.models.first(),
        }
    }

    /// 「测试连接」: one short sentence to the model; 「可用」 once it answers,
    /// else 「连不上这个地址」, 「密钥无效」 or the request-failed line.
    pub fn test_local(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(server) = self.local_server(id).cloned() else {
            return;
        };
        let Some(model) = self.local_test_model(id).cloned() else {
            return;
        };
        if self
            .local_test
            .as_ref()
            .is_some_and(|(_, result)| result.is_none())
        {
            return;
        }
        self.local_test = Some((id.to_owned(), None));
        self.local_test_generation += 1;
        let generation = self.local_test_generation;
        self.local_failure = None;
        cx.notify();
        let service = self.service.clone();
        let http = service.driver().http().clone();
        let config = local_config(&server, &model);
        let task = http.spawn(async move { service.test_local(&server, config).await });
        self.local_test_abort = Some(task.abort_handle());
        let id = id.to_owned();
        cx.spawn(async move |this, cx| {
            let result = task.await.unwrap_or(Err(LocalFailure::RequestFailed));
            this.update(cx, |this, cx| {
                if this.local_test_generation == generation
                    && this
                        .local_test
                        .as_ref()
                        .is_some_and(|(test, pending)| *test == id && pending.is_none())
                {
                    this.local_test = Some((id, Some(result)));
                    this.local_test_abort = None;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// A model name typed for a server without a model list.
    pub fn add_local_model(&mut self, id: &str, model: &str, cx: &mut Context<Self>) -> bool {
        let model = model.trim();
        if !dr_agent_providers::local::valid_model_id(model) {
            return false;
        }
        let Some(server) = self.local.iter_mut().find(|server| server.id == id) else {
            return false;
        };
        if server.model(model).is_none() {
            server.models.push(LocalServerModel::new(model, None));
        }
        self.write_local(cx);
        true
    }

    /// The × on a typed model. The last one gone takes the server with it.
    pub fn remove_local_model(&mut self, id: &str, model: &str, cx: &mut Context<Self>) {
        let Some(server) = self.local.iter_mut().find(|server| server.id == id) else {
            return;
        };
        server.models.retain(|old| old.id != model);
        if server.models.is_empty() {
            self.disconnect_local(id, cx);
        } else {
            self.write_local(cx);
        }
    }

    /// 「上下文」 in Settings: the author's value wins over the server's.
    pub fn set_local_context(
        &mut self,
        id: &str,
        model: &str,
        context: Option<u64>,
        cx: &mut Context<Self>,
    ) {
        let Some(found) = self
            .local
            .iter_mut()
            .find(|server| server.id == id)
            .and_then(|server| server.models.iter_mut().find(|old| old.id == model))
        else {
            return;
        };
        if found.context_override != context {
            found.context_override = context;
            self.write_local(cx);
        }
    }

    /// Opening the model menu asks listed servers again, at most every five
    /// minutes each. A server that does not answer keeps its list.
    pub fn load_local_catalogs(&mut self, cx: &mut Context<Self>) {
        let due: Vec<LocalServer> = self
            .local
            .iter()
            .filter(|server| {
                !server.manual
                    && self.local_listed.get(&server.id).is_none_or(|at| {
                        at.elapsed() >= std::time::Duration::from_millis(catalog::CACHE_MS)
                    })
            })
            .cloned()
            .collect();
        for server in due {
            self.local_listed
                .insert(server.id.clone(), std::time::Instant::now());
            let service = self.service.clone();
            let http = service.driver().http().clone();
            let asked = server.clone();
            let task = http.spawn(async move { service.relist_local(&asked).await });
            cx.spawn(async move |this, cx| {
                let Ok(Some(discovery)) = task.await else {
                    return;
                };
                this.update(cx, |this, cx| {
                    let Some(current) = this
                        .local
                        .iter_mut()
                        .find(|current| current.id == server.id)
                    else {
                        return;
                    };
                    // Changed meanwhile (edited, models typed): leave it.
                    if current.base_url != server.base_url || current.manual {
                        return;
                    }
                    let models = local::merge_models(&current.models, &discovery.models);
                    if current.models != models {
                        current.models = models;
                        this.write_local(cx);
                    }
                })
                .ok();
            })
            .detach();
        }
    }
}

impl Drop for Connections {
    fn drop(&mut self) {
        if let Some(cancel) = &self.login_cancel {
            drop(cancel.cancel());
        }
    }
}
