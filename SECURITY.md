# Security policy

Security fixes are provided for the current `main` branch and the latest
release on GitHub Releases. Community forks and independently operated services
are not covered.

Use GitHub’s private vulnerability-reporting form under the repository
Security tab. Do not put exploit details, API keys, manuscripts, databases, or
personal data in a public issue. If private reporting is temporarily
unavailable, open a minimal issue asking the maintainer to enable a private
channel without including vulnerability details.

Please include the affected revision, platform, impact, reproduction steps,
and whether a proof of concept contains sensitive data. The project aims to
acknowledge a report within seven days; remediation and disclosure timing
depend on severity and release constraints.

API keys, the ChatGPT sign-in and the Hosted session are stored in the macOS
Keychain. An API key is sent only to the provider it belongs to; the ChatGPT
sign-in token is read and refreshed only by native code. Hosted sync is not
end-to-end encrypted: HTTPS protects the transport, and the service can read
synced projects, so signing in is a decision to trust the Hosted operator with
project content. Access from another device goes through the Hosted account;
there is no separate recovery code. Updates are signed, and the app installs
only an update whose signature matches the key built into it. See
[PRIVACY.md](PRIVACY.md) and [docs/official-service.md](docs/official-service.md)
before enabling network features.
