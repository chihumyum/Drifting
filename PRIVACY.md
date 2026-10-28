# Drifting client privacy boundary

Last updated: 2026-10-28

This document describes the public-source client. It is not a privacy policy
for every fork or independently operated service. A fork operator is
responsible for its own disclosures and data practices.

## Default source build

The default build is local-only. It stores projects in local SQLite/Yjs data,
uses OS secure storage for provider credentials, keeps imported assets and
caches in the application data directory, and does not require an account or
connect a cloud provider by default. Hosted account/sync features require an
operator-configured build and explicit sign-in. Google Drive sync is retired.
Usage analytics have no production uploader. Configured Hosted builds can send
content-free crash/integrity reports according to the Privacy setting; local-only
builds do not upload them.

User-imported fonts remain device-local. You are responsible for having the
right to use any imported manuscript, image, PDF, or font.

## Hosted account and synchronization

An operator can configure a compatible service and explicitly enable account
and synchronization features. The client may then transmit account and device
identifiers, project metadata, Yjs checkpoints and updates containing full
manuscript content, snapshots, comments, synced Agent memory, settled Agent
conversations and necessary tool results, and uploaded
project assets such as images or PDFs. Unless that service publishes and proves
a separate encryption contract, synced manuscript content must be treated as
readable within that service's trust boundary.

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

Copilot and General Agent are Experimental. Their output can be inaccurate or
destructive, and the author must review proposed changes. Model-provider costs,
privacy, retention, training, availability, and output risks are governed by
the selected provider rather than Drifting.

## Recovery snapshots and diagnostics

Before a new application version migrates SQLite, Drifting creates a native
safety snapshot in the application data directory and retains only a bounded
number per version. This snapshot is used by the database recovery boundary;
it is not a general-purpose library export. A diagnostic summary, when copied
or exported by the author, must contain operational state,
counts, versions, and error categories only—not manuscript content, tokens,
credentials, or absolute filesystem paths. Drifting does not upload that
summary automatically.

## Your controls

Local-only mode disables Drifting-operated account and Hosted traffic. A BYOK
request still sends the prompt and selected context to the provider you choose;
remote Agent extensions require explicit configuration and grants. For a fully
offline session, do not invoke those network features.

Hosted sign-in connects the current local library: cloud projects are downloaded
and local projects are uploaded. Disconnecting sync or signing out keeps local
projects and does not delete uploaded copies. Permanent Hosted project deletion
requires an owning account and a verified service deletion receipt; service
retention, backups and account access/deletion requests follow the operator's
published policy. Offline failure retains local work.

Google Drive OAuth, transport and controls have been removed. Previously stored
Drive records and protected credentials are not automatically erased or revoked;
the client can adopt the verified local replica into Hosted without contacting
Drive, fetching unseen remote changes, or deleting the old remote copy.

Local projects support readable Markdown exports and automatic read-only
projection. A complete `.drifting` backup currently requires a stable local
library without a cloud binding; Markdown output is not a full backup.
See [Hosted behavior](docs/hosted-sync/README.md) and
[library backup](docs/library-backup.md).

For a security issue, follow [SECURITY.md](SECURITY.md). For the distinction
between this client and the official hosted service, see
[docs/official-service.md](docs/official-service.md).
