# Drifting 本地开发指南

## 快速开始

### 安装依赖
```bash
pnpm install
```

### 启动开发模式
```bash
pnpm start
```

应用将自动启动 Electron 窗口，并开启热重载功能。

## 本地优先模式

应用当前配置为**本地优先模式**（类似 Obsidian），提供更好的离线开发和使用体验。

### 特性

✅ **完全离线工作** - 无需网络连接
✅ **无需登录** - 直接进入应用
✅ **本地数据库** - 所有数据存储在 SQLite
✅ **快速启动** - 无需等待服务器同步
✅ **专注创作** - 简化的界面，移除干扰

### 数据存储位置

- **macOS**: `~/Library/Application Support/Drifting/databases/`
- **Windows**: `%APPDATA%/Drifting/databases/`
- **Linux**: `~/.config/Drifting/databases/`

数据库文件名：`default-project.db`

## 配置文件

### 修改应用模式

编辑 [src/renderer/lib/config.ts](src/renderer/lib/config.ts)：

```typescript
export const APP_CONFIG = {
  // 本地优先模式开关
  LOCAL_ONLY_MODE: true,  // false = 启用网络功能
  
  // 同步配置
  ENABLE_SYNC: false,     // true = 启用服务器同步
  
  // 认证配置
  REQUIRE_AUTH: false,    // true = 需要登录
  
  // API 地址（仅在非本地模式下使用）
  API_BASE_URL: 'http://localhost:3000',
}
```

### 切换到在线模式

如果要启用服务器同步功能：

1. 将 `LOCAL_ONLY_MODE` 设置为 `false`
2. 将 `ENABLE_SYNC` 设置为 `true`
3. 将 `REQUIRE_AUTH` 设置为 `true`
4. 配置 `API_BASE_URL` 为你的后端地址
5. 重启应用

## 开发工具

### 调试面板

在应用中打开 Settings → Advanced → 数据调试工具，可以查看：
- 本地数据库内容
- 网络请求日志（如果启用）
- 应用状态

### Chrome DevTools

应用在开发模式下会自动打开 DevTools。可以：
- 查看 Console 日志
- 调试 React 组件
- 检查网络请求
- 分析性能

### 热重载

修改 `src/renderer` 中的代码会自动热重载。
修改 `src/main` 中的代码需要在终端输入 `rs` 重启主进程。

## 项目结构

```
core/
├── src/
│   ├── main/                 # Electron 主进程
│   │   ├── main.ts           # 应用入口
│   │   ├── preload.ts        # Preload 脚本
│   │   └── database.ts       # 数据库 IPC 处理
│   └── renderer/             # React 应用（渲染进程）
│       ├── main.tsx          # React 入口
│       ├── App.tsx           # 主应用组件
│       ├── lib/              
│       │   ├── config.ts     # ⚙️ 配置文件
│       │   ├── db.ts         # 数据库接口
│       │   └── sync/         # 同步管理（本地模式下禁用）
│       ├── components/       # React 组件
│       ├── views/            # 页面视图
│       ├── store/            # 状态管理
│       └── ...
```

## 常见问题

### Q: 如何清空数据重新开始？

A: 删除数据库文件：
```bash
# macOS
rm ~/Library/Application\ Support/Drifting/databases/*.db*

# Windows
del %APPDATA%\Drifting\databases\*.db*

# Linux
rm ~/.config/Drifting/databases/*.db*
```

### Q: 如何查看数据库内容？

A: 使用 SQLite 工具：
```bash
# 安装 sqlite3（如果没有）
brew install sqlite3  # macOS
apt install sqlite3   # Linux

# 打开数据库
sqlite3 ~/Library/Application\ Support/Drifting/databases/default-project.db

# 查看表
.tables

# 查看数据
SELECT * FROM nodes;
```

### Q: 为什么修改代码后没有生效？

A: 检查：
1. 是否保存了文件
2. 终端是否有错误信息
3. 尝试完全重启应用（Ctrl+C 然后 `pnpm start`）
4. 清空缓存：删除 `.vite` 目录后重启

### Q: 如何连接后端服务器？

A: 
1. 确保后端服务正在运行（通常在 `backend/` 目录）
2. 修改 `config.ts` 中的配置
3. 重启 Electron 应用

## 打包发布

### 打包当前平台
```bash
pnpm package
```

### 创建安装包
```bash
pnpm make
```

生成的安装包在 `out/` 目录。

## 技术栈

- **Electron** - 跨平台桌面应用框架
- **React 19** - UI 框架
- **TypeScript** - 类型安全
- **Vite** - 快速构建工具
- **Better-SQLite3** - 高性能 SQLite 数据库
- **Zustand** - 轻量级状态管理
- **Tiptap** - 富文本编辑器

## 贡献指南

1. Fork 项目
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 打开 Pull Request

## License

MIT
