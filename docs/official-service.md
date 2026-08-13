# Official hosted-service boundary

This repository is the AGPL-licensed Drifting client. It does not contain the
private official server, payment system, production credentials, deployment
configuration, or an entitlement to use official infrastructure.

The default build is local-only. Account, cloud synchronization, billing, and
proxy-backed AI features require a separately operated compatible service and
explicit build/runtime configuration. The source license does not grant API
capacity, an account, hosted support, or permission to bypass authentication,
rate limits, abuse controls, or service terms.

The official service and the public client are built and deployed separately.
They communicate over versioned HTTP/WebSocket contracts. The private service
must not import or link AGPL client source. The only implementation shared with
independent services in this repository is `packages/prose-metrics`, licensed
separately under Apache-2.0.

Fork operators must supply their own service policy, privacy disclosures,
credentials, domains, signing identity, bundle identifier, and branding. A
compatible service implementation is not currently supplied by this project.

Changing `VITE_API_BASE_URL` alone is not sufficient for a packaged Tauri
build. Fork operators using another origin must also update the production and
development `connect-src` entries in `src-tauri/tauri.conf.json`, then verify
that their exact HTTPS and WebSocket origins are allowed without broadening the
remaining Content Security Policy.

This document describes an engineering and licensing boundary; it is not a
consumer Terms of Service. A build that enables account creation must configure
a real operator-owned Terms URL and privacy policy before distribution.
