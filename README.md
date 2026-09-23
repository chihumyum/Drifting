# Drifting

一个仍在早期开发中的本地优先写作应用。

我正在持续探索它的交互、架构和功能。当前版本尚不成熟，存在已知问题，
界面和功能也会继续调整。源码在这里公开维护，供感兴趣的人阅读、构建和交流。

## 开发

项目使用 Tauri、Rust、React 和 TypeScript。默认构建在本地运行，不需要
Drifting 账号；此仓库不包含托管服务的服务端实现。

开始前请阅读[开发环境配置](docs/contributor-quick-start.md)，安装依赖并完成
目标平台的准备工作。macOS 本地运行需要自己的开发签名证书。

```bash
pnpm install --frozen-lockfile
pnpm dev:check
pnpm dev
```

- [文档索引](docs/README.md)
- [已知问题](KNOWN_ISSUES.md)
- [参与开发](CONTRIBUTING.md)

## Licensing and project policy

项目主体采用 [AGPL-3.0-or-later](LICENSE)；`packages/prose-metrics` 单独采用
[Apache-2.0](packages/prose-metrics/LICENSE)。第三方代码和素材保留各自的许可证。

[第三方声明](THIRD_PARTY_NOTICES.md) · [商标说明](TRADEMARKS.md) ·
[隐私边界](PRIVACY.md) · [安全反馈](SECURITY.md) · [源码历史说明](docs/public-history.md)
