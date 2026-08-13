# Drifting client privacy boundary

Last updated: 2026-08-14

This document describes the public-source client. It is not a privacy policy
for every fork or independently operated service. A fork operator is
responsible for its own disclosures and data practices.

## Default source build

The default build is local-only. It stores projects in local SQLite/Yjs data,
uses OS secure storage for provider credentials, keeps imported assets and
caches in the application data directory, does not require an account, and
does not enable cloud sync. Usage-stat and crash-log preferences default to
off; this repository currently contains no production analytics uploader.

User-imported fonts remain device-local. You are responsible for having the
right to use any imported manuscript, image, PDF, or font.

## When network features are enabled

An operator can configure a compatible service and explicitly enable account
and synchronization features. The client may then transmit account and device
identifiers, project metadata, Yjs checkpoints and updates containing full
manuscript content, snapshots, comments, Agent working memory, and uploaded
project assets such as images or PDFs. Synced manuscript content is not
currently end-to-end encrypted.

The service may necessarily process network metadata such as IP address,
user-agent, request timing, and authentication/session identifiers. Retention,
backup, deletion, payment, email, OAuth, object-storage, and subprocessors are
the responsibility of that service operator.

## AI and BYOK

In direct mode, prompts, selected manuscript context, conversation history,
and the user’s credential go directly to the selected model provider. In proxy
mode, the same request and a transient BYOK credential may pass through the
configured service before reaching the provider. Credentials are not intended
to be persisted by the proxy, but operators must verify their own deployment.

Drifting’s source license does not control a third-party model provider’s data
retention or training practices. Those practices depend on the provider,
account type, region, and current provider terms. Review them before sending
private writing. This public client contains no manuscript-training pipeline.
Any configured service operator must publish its own policy; this repository
does not make promises on that operator's behalf.

## Your controls

Local-only mode disables account and synchronization traffic. A BYOK AI request
still sends the prompt and selected context directly to the provider you choose;
do not invoke it when you want a fully offline session. You can export local
projects, remove local databases and imported assets through your operating
system, delete provider keys from Settings, and contact the operator of any
configured service for server-side access or deletion requests.

For a security issue, follow [SECURITY.md](SECURITY.md). For the distinction
between this client and the official hosted service, see
[docs/official-service.md](docs/official-service.md).
