# Official hosted-service boundary

This repository is the AGPL-licensed Drifting client. It does not contain the
private official server, payment system, production credentials, deployment
configuration, or an entitlement to use official infrastructure.

The default build is local-only. Hosted accounts and the hosted sync provider
require a separately operated compatible service and explicit build configuration.
Hosted AI and billing are outside the current implementation. The implemented Google Drive
provider is a separate, author-connected SyncEngine capability and does not make
the official service reachable. The source license does not grant API capacity,
an account, hosted support, or permission to bypass authentication, rate limits,
abuse controls, or service terms.

In that default build, desktop and mobile Settings omit the Account and
Subscription entries and do not mount their hosted API clients. Privacy also
omits the hosted telemetry controls rather than presenting disabled upload or
official-service placeholders. The first-run guide describes the local data
boundary and offers only Continue locally; it has no Drive or quick-guide
entry. It makes no trial account or hosted storage claim. Trash and the separate
30-day entity history are local SQLite capabilities and do not require a
subscription. Trash items remain local until the author restores or permanently
deletes them. The project-scoped mobile workspace owns its Trash surface; the
standalone Settings route deliberately remains independent of a project runtime.
One explicitly configured application supports both local writing and optional
account sync; its first-run actions are Continue locally and Sign in / sign up
and sync. The account action reuses the login, registration and email
verification flow, explaining the cloud download and local upload before entry.
The source-default flag describes whether an operator supplied a compatible
service, not two editions the user must install or switch between.
An explicitly configured Hosted build exposes accounts on both the standalone
Settings route and the project settings panel. Login controls cloud access only:
the local library, Trash and history remain available offline. Subscription
surfaces remain retired.

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
Hosted sync implements the same immutable opaque-object contract
as every other SyncEngine provider; it does not restore the retired entity,
Yjs, preference, or snapshot CRUD push/pull APIs. Account APIs remain separately versioned. The private service must not import or link AGPL
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

Current client integration, local operator commands and acceptance boundaries:
[Hosted sync](hosted-sync/README.md).
