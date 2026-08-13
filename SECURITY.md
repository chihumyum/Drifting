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

BYOK credentials are stored through platform secure storage, but a build using
proxy AI transport sends the selected credential transiently to its configured
service. Cloud synchronization is not end-to-end encrypted. See
[PRIVACY.md](PRIVACY.md) and [docs/official-service.md](docs/official-service.md)
before enabling network features.
