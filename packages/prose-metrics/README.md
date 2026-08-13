# @drifting/prose-metrics

Portable prose-metric contracts and deterministic implementations shared by the Drifting client
and independently operated services.

This package is licensed under Apache License 2.0, separately from the AGPL client at the repository
root. It is intentionally marked `private` on npm while it uses a source-first workspace export.
That flag prevents an accidental broken publication; it does not change the Apache-2.0 grant.
A future npm release must add a reproducible `dist` build before publication.
