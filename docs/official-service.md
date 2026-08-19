# Official hosted-service boundary

This repository is the AGPL-licensed Drifting client. It does not contain the
private official server, payment system, production credentials, deployment
configuration, or an entitlement to use official infrastructure.

The default build is local-only. Hosted accounts, a hosted sync provider,
billing, and proxy-backed AI features require a separately operated compatible
service and explicit build/runtime configuration. The implemented Google Drive
provider is a separate, author-connected SyncEngine capability and does not make
the official service reachable. The source license does not grant API capacity,
an account, hosted support, or permission to bypass authentication, rate limits,
abuse controls, or service terms.

In that default build, desktop and mobile Settings omit the Account and
Subscription entries and do not mount their hosted API clients. Privacy also
omits the hosted telemetry controls rather than presenting disabled upload or
official-service placeholders. The first-run guide describes the local data
boundary instead of a trial account or hosted storage. Trash and the separate
30-day entity history are local SQLite capabilities and do not require a
subscription. Trash items remain local until the author restores or permanently
deletes them. The project-scoped mobile workspace owns its Trash surface; the
standalone Settings route deliberately remains independent of a project runtime.
A compatible hosted operator can restore the account and billing surfaces only
by explicitly enabling authentication.

`LOCAL_ONLY_MODE` is a hard client boundary, not presentation-only UI. It
overrides a stale `REQUIRE_AUTH` setting, account/native OAuth actions reject
before dispatch, the shared hosted HTTP client rejects before its network
adapter runs, and Better Auth's own custom fetch transport applies the same
gate. Direct calls to `authClient` therefore cannot bypass local-only mode.

Product network access is classified as one of `hosted-service`,
`personal-cloud`, `byok-provider`, `external-content`, or `agent-extension`.
The local-first build allows only author-initiated non-hosted purposes while the
device is online. Pasted-URL metadata and remote preview images use
`external-content`; both fail closed while offline. BYOK clients check
`byok-provider` before creating or using a direct provider transport. Remote
Agent extensions already require explicit per-server configuration and durable
per-tool grants, so `agent-extension` records availability and purpose rather
than adding a second permission switch. Google Drive uses the `personal-cloud`
purpose, native OAuth, and an explicit provider-authority binding. Classifying
the network purpose by itself does not connect an account, activate a provider,
or send project content.

The official service and the public client are built and deployed separately.
If hosted sync returns, it implements the same immutable opaque-object contract
as every other SyncEngine provider; it does not restore the retired entity,
Yjs, preference, or snapshot CRUD push/pull APIs. Account and billing APIs may
remain separately versioned. The private service must not import or link AGPL
client source. The only implementation shared with independent services in
this repository is `packages/prose-metrics`, licensed separately under
Apache-2.0.

Fork operators must supply their own service policy, privacy disclosures,
credentials, domains, signing identity, bundle identifier, and branding. A
compatible service implementation is not currently supplied by this project.

The public production CSP intentionally contains no Drifting hosted origin. It
allows the currently supported direct BYOK origins, and HTTPS images only for
the explicitly gated external-preview surface. The native Google Drive
transport does not depend on renderer CSP access. Changing `VITE_API_BASE_URL`
alone is therefore not sufficient for an operator build. Fork operators must
provide a production CSP containing their exact HTTPS and WebSocket service
origins, add any renderer-based personal-cloud origin they implement, update the
development CSP when needed, and verify the result without broadly relaxing the
remaining policy.

This document describes an engineering and licensing boundary; it is not a
consumer Terms of Service. A build that enables account creation must configure
a real operator-owned Terms URL and privacy policy before distribution.
