# Drifting client privacy boundary

Last updated: 2026-08-20

This document describes the public-source client. It is not a privacy policy
for every fork or independently operated service. A fork operator is
responsible for its own disclosures and data practices.

## Default source build

The default build is local-only. It stores projects in local SQLite/Yjs data,
uses OS secure storage for provider credentials, keeps imported assets and
caches in the application data directory, and does not require an account or
connect a cloud provider by default. Google Drive sync starts only after the
author explicitly connects a Google account. Usage-stat and crash-log
preferences default to off; this repository currently contains no production
analytics uploader.

User-imported fonts remain device-local. You are responsible for having the
right to use any imported manuscript, image, PDF, or font.

## Google Drive sync

Google Drive sync is optional. Connecting uses Google OAuth and the Drive
`appDataFolder` belonging to the selected Google account. Google OAuth and
Google Drive are inside the cloud trust boundary. Drifting does not
end-to-end encrypt synced project objects against Google; HTTPS and Google's
own storage encryption do not change that boundary.

The client may transmit the Google account subject, project metadata, Yjs
checkpoints and updates containing full manuscript content, snapshots,
comments, synced Agent memory, and imported project assets such as images or
PDFs. Google can process those objects under the terms and policies applicable
to the selected Google account.

Google sign-in is the cross-device access authority. Connect and new-device
restore use the same flow: sign-in followed by automatic account-scoped
discovery. Drifting does not require an account of its
own and does not create a recovery phrase, recovery QR, or separate restore
secret. It also does not create an application-managed Project content key.
Disconnect stops the client from using the provider and follows the
native OAuth revocation path; it does not imply that every already-uploaded
object has been deleted from Google's systems.

## Other configured network services

An operator can configure a compatible service and explicitly enable account
and synchronization features. The client may then transmit account and device
identifiers, project metadata, Yjs checkpoints and updates containing full
manuscript content, snapshots, comments, synced Agent memory, and uploaded
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

Local-only mode disables Drifting-operated account and hosted-service traffic;
it does not disable a personal-cloud provider that the author explicitly
connects. Google Drive synchronization can therefore run in local-only mode
after the author completes Google sign-in. A BYOK AI request still sends the
prompt and selected context directly to the provider you choose. For a fully
offline session, do not connect Google Drive or invoke BYOK, external-content,
or remote Agent-extension features. You can export local projects, remove local
databases and imported assets through your operating system, disconnect Google
Drive from Settings, and contact Google or the operator of another configured
service for remote access or deletion requests.

The current Google Drive trust and restore contract is documented in
[docs/sync-engine/trusted-cloud-google-drive.md](docs/sync-engine/trusted-cloud-google-drive.md).

For a security issue, follow [SECURITY.md](SECURITY.md). For the distinction
between this client and the official hosted service, see
[docs/official-service.md](docs/official-service.md).
