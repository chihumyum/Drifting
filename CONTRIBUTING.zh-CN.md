# 参与 Drifting 开发

[English](CONTRIBUTING.md) | 简体中文

感谢你帮助改进 Drifting。较大的架构改动请先开一个 issue，让维护者和贡献者先就范围达成一致。

从[开发环境配置](docs/contributor-quick-start.md)开始，其中包括 macOS 证书的设置，以及不需要证书的代码检查流程。
在 Windows 上开发见[在 Windows 上开发](docs/windows.md#developing-on-windows)。

## 授权协议

提交 pull request 即表示你已阅读并同意 [CLA.md](CLA.md)。对客户端和文档的贡献以
`AGPL-3.0-or-later` 授权；`packages/prose-metrics/**` 下的贡献以 `Apache-2.0` 授权。

除非你有权按这些条款授权，否则不要提交属于雇主、学校、客户或其他第三方的材料。AI 辅助完成的工作仍由你负责审阅，
并确认其原创性、准确性和授权兼容性；AI 工具不是贡献者，也不是著作权人。

## 内容与隐私规则

不要提交凭据、`.env` 文件、本地数据库、签名材料、个人的绝对路径、会话或项目标识、未发表的稿件、用户数据，
以及受著作权保护的评测语料。测试数据必须是合成的，或者有书面记录的再分发授权。

第三方代码和素材必须注明确切的来源、版本、许可证、版权声明以及所做的修改。生成的文件必须注明其规范来源和生成器。

官方私有服务是另一部独立的作品。不要把私有服务的代码复制进这个仓库。社区以 AGPL 授权的贡献，未经 CLA
所述的贡献者许可，不得复制进专有的客户端或服务。

## 检查

验收测试应断言稳定的行为、协议边界，或引入某项功能的那次迁移。不要用 `toContain('version: N')`
这类源码字符串断言，把功能测试绑死在会变化的聚合存储版本上；应当测试迁移的行为，并要求当前版本不低于引入该功能的版本。

GitHub Actions 会分别运行客户端检查、两组 Vitest 分片和渲染层契约，再通过稳定的 `client`
必需检查汇总结果。`native` 检查覆盖 Rust 格式、编译和单元测试，包括共享数据库、文档和正文
crate 的 `pnpm core:test`；`core:test` 会先用 TypeScript 参照实现核对正文日志样例，所以这一组也安装锁定的
Node 依赖。随后它运行 `pnpm security:rust`：用 [cargo-audit](https://github.com/rustsec/rustsec)
（`cargo install cargo-audit --locked`）对照 RustSec 漏洞库审计每个被跟踪的 `Cargo.lock`，出现任何漏洞即失败，
和 `pnpm security:dependencies` 对 npm 高危及严重漏洞的处理一样。两组检查在每次推送 `main` 时运行；`main`
的规则集要求它们通过，管理员可绕过。Tauri 客户端的只读 Yrs
搜索投影需要 Rust 1.96 或更新版本；CI 和正式构建明确使用 1.96.0。

运行 `pnpm perf:rust-reuse` 重新生成合成的 Rust 复用基准，运行 `pnpm perf:rust-reuse:check`
核对它们的源码指纹和结果。测得的边界和被否决的候选方案见 [Rust reuse performance](docs/rust-reuse-performance.md)。
版本标签（`v*`）由发布工作流验证（见[发布流程](docs/releasing.md)），不经过普通的 CI 运行。

```bash
pnpm install --frozen-lockfile
pnpm ci:contract:check
pnpm public:check
pnpm security:dependencies
pnpm security:rust
pnpm lint
pnpm typecheck
pnpm test
pnpm agent:capabilities:check
pnpm agent:conversation-sync:check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
pnpm core:test
```

安全漏洞请按 [SECURITY.md](SECURITY.md) 所述私下报告。

本文是 [CONTRIBUTING.md](CONTRIBUTING.md) 的中文译本；两者不一致时，以英文版为准。
