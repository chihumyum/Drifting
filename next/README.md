# next/：Rust + GPUI + Loro 重写工作区

计划见 [docs/rust-rewrite](../docs/rust-rewrite/README.md)，各路进度见 [progress.md](../docs/rust-rewrite/progress.md)。

```bash
cd next
cargo run -p drifting
```

- GPUI 钉在 Zed `v1.27.0`，工具链由 `rust-toolchain.toml` 指定（1.98.1），Loro 精确钉 `=1.17.1`。
- 开发构建用 GPUI 的 `runtime_shaders`：Metal 着色器在启动时编译，不需要另装 Xcode 的 Metal Toolchain。
- `members` 一行一个、按字母排；新依赖加进 `[workspace.dependencies]`。
