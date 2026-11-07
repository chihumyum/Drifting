# dr-doc fuzz targets

Not run in CI. Two targets, both must never panic:

- `load_bytes`: arbitrary bytes as stored blobs, loaded and imported into
  prose and book documents, then read and edited.
- `bad_structure`: well-formed Loro documents with a damaged structure
  (written with the raw Loro API: no final newline, paragraph marks on letters,
  fields of the wrong type, trees repeating a domain id, two writers), then
  loaded, read and edited through dr-doc.

With cargo-fuzz installed:

```bash
cargo +nightly fuzz run bad_structure -- -max_total_time=90
```

Without it, the same build by hand (what cargo-fuzz does):

```bash
RUSTFLAGS="--cfg fuzzing -Cpasses=sancov-module -Cllvm-args=-sanitizer-coverage-level=4 \
  -Cllvm-args=-sanitizer-coverage-inline-8bit-counters -Cllvm-args=-sanitizer-coverage-pc-table \
  -Cllvm-args=-sanitizer-coverage-trace-compares -Zsanitizer=address" \
  cargo +nightly build --release --bin bad_structure --target aarch64-apple-darwin
mkdir -p corpus/bad_structure
target/aarch64-apple-darwin/release/bad_structure corpus/bad_structure -max_total_time=90
```

The fuzz crate is its own workspace (its `Cargo.lock`, corpus and artifacts
are not committed). Inputs that once crashed are kept as regression tests in
`../tests/fuzz-regressions/`, replayed by `../tests/fuzz_regressions.rs`
through the same code (`fuzz_targets/common.rs`); add new ones there.
