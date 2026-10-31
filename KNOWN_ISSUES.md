# Drifting Alpha known issues

This file tracks user-visible limitations for the next desktop Alpha. It is not
evidence that a public installer is available.

- Only macOS 13+ on Apple Silicon is in scope.
- Copilot and General Agent are experimental BYOK features. Review every
  proposed change before accepting it.
- The General Agent "ChatGPT subscription" route signs in with your own
  ChatGPT account through OpenAI's Codex device login. OpenAI offers no
  third-party contract for it, so it is unsupported, counts against your
  ChatGPT plan, and may stop working without notice.
- Hosted sync trusts the configured service; synchronized manuscript data is
  readable within that operator's trust boundary and is not end-to-end encrypted.
- Relational Markdown is a readable export and is not an app-state import or
  restore format.
- The public release contract and gates are paused during restructuring. Hosted
  distribution configuration, signed installers, public update delivery and
  real-account acceptance must be established before broad promotion. See
  [current onboarding and Hosted readiness](docs/client-onboarding-and-hosted-readiness.md).
- Mobile, Intel Mac, Windows, and Linux are not release-supported yet.
- iOS source builds require iOS 15+. Native smoke-test results and remaining
  mobile acceptance gaps are in [the 2026-09-23 report](docs/qa/native-acceptance-2026-09-23.md).
  These binary-release gaps do not prevent accurately documented source publication.

Report reproducible problems to `support@drifting.cc` without attaching private
manuscript text, API keys, OAuth tokens, or credential screenshots.
