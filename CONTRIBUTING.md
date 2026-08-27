# Contributing to Drifting

Thank you for improving Drifting. Open an issue before a large architectural
change so maintainers and contributors can agree on scope.

## License agreement

By submitting a pull request, you confirm that you have read and agree to
[CLA.md](CLA.md). Contributions to the client and documentation are licensed
under `AGPL-3.0-or-later`. Contributions under `packages/prose-metrics/**` are
licensed under `Apache-2.0`.

Do not submit employer, school, client, or third-party material unless you have
the right to license it on these terms. You remain responsible for reviewing
AI-assisted work and confirming its originality, accuracy, and license
compatibility; an AI tool is not a contributor or copyright holder.

## Content and privacy rules

Never commit credentials, `.env` files, local databases, signing material,
personal absolute paths, session/project identifiers, unpublished manuscripts,
customer data, or copyrighted evaluation corpora. Test fixtures must be
synthetic or have documented redistribution rights.

Third-party code and assets must identify the exact source, version, license,
copyright notice, and modifications. Generated files must identify their
canonical source and generator.

The private official service is a separate work. Do not copy private service
code into this repository. Community AGPL contributions must not be copied into
a proprietary client or service without the contributor permission described
in the CLA.

## Checks

Acceptance tests should assert stable behavior, protocol boundaries, or the
specific migration that introduced a feature. Do not lock a feature test to a
mutable aggregate store version with a source-string assertion such as
`toContain('version: N')`; test the migration behavior and require the current
version to be at least the introducing version instead.

GitHub Actions runs client checks and two Vitest shards independently, then
reports their aggregate through the stable `client` required-check context.
The `native` context covers Rust formatting, compilation, and unit tests.
Alpha tags are validated only by the exact-SHA release workflow, so they do not
also start a duplicate ordinary CI run.

```bash
pnpm install --frozen-lockfile
pnpm ci:contract:check
pnpm public:check
pnpm lint
pnpm typecheck
pnpm test
pnpm agent:capabilities:check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
```

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
