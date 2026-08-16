# Security policy

Security fixes are provided for the current `main` branch and the latest
official release, when one exists. Community forks and custom backends are not
covered by the official support policy.

Use GitHub’s private vulnerability-reporting form under the repository
Security tab. Do not put exploit details, API keys, manuscripts, databases, or
personal data in a public issue. If private reporting is temporarily
unavailable, open a minimal issue asking the maintainer to enable a private
channel without including vulnerability details.

Please include the affected revision, platform, impact, reproduction steps,
and whether a proof of concept contains sensitive data. The project aims to
acknowledge a report within seven days; remediation and disclosure timing
depend on severity and release constraints.

BYOK and Google OAuth credentials are stored through platform secure storage,
but a build using proxy AI transport sends the selected BYOK credential
transiently to its configured service. Google OAuth and Google Drive are inside
the optional sync trust boundary: Drifting does not end-to-end encrypt synced
projects against Google and does not create an application-managed Project
content key. HTTPS and Google's storage protections apply, but connecting or
restoring is still a decision to trust the selected Google account and Google
Drive with Project content. Google sign-in is the cross-device access
authority; there is no recovery code or QR. See
[PRIVACY.md](PRIVACY.md) and [docs/official-service.md](docs/official-service.md)
before enabling network features.
