# 项目路由代码加载

`AppRoutes` 保留 URL 和认证处理，工作区、项目首页及五种编辑路由改用 `DeferredProjectRoute`。
`project-route-module` 通过普通 Vite dynamic import 加载 `project-route-components`，让 Vite 一并
处理静态 JS 依赖和 CSS。组件注册表只缓存代码，ProjectRuntime、Yjs/编辑会话与 incoming ready
屏障仍在原来的壳层内；AppEffects 继续位于路由外。

加载期间可返回书架。尚未完成的 import 可以继续下载，但不会在已离开的路由挂载工作区。
快速切换项目后，成功结果由当前路由参数使用。后续访问直接使用成功的模块缓存。

首次加载失败发生在这个 renderer 尚未挂载任何工作区之前，局部显示错误与重试。
显式重试刷新当前文档并保留 URL，清除浏览器对失败共享 JS/CSS 的缓存。
只给入口追加 query 无法修复静态依赖的失败，因此这里没有使用入口换键重试。
模块一旦成功就不再失效，已挂载的工作区不会经过这个刷新分支。

独立设置现在直接由 `AppRoutes` 挂载，不再经过项目路由代码门槛。
设置导航、外观与语言无需等待工作区；其余面板按功能组加载，见
[设置入口](settings-entry-loading.md)。项目内设置弹窗保留连续滚动，按组重试失败代码。

## 首次进入的等待（2026-10-01）

书架读完项目摘要后，通过 `useProjectRoutePreload` 在空闲时预加载共享路由代码。
沿用现有单任务预加载队列：隐藏页面、节流网络和离线状态不启动推测加载；离开书架会
取消尚未开始的任务。已开始的 import 与首次点击共享同一个 Promise，成功代码供后续
项目复用。预加载不挂载工作区、不读取项目正文，也不改变 SQLite/Yjs 的初始化边界。
后台加载失败不弹错误，真正进入时仍尝试加载，失败保留重试与返回书架。

开发服务器通过 Vite `server.warmup.clientFiles` 提前转换项目路由及静态依赖，减少
首次点击时的转换瀑布；这只预热服务器缓存，不在客户端执行工作区，也不改变发布包。
开发服务器重新启动后生效。静态入口仍保持 dynamic import，历史 F7g 的首次访问前
不请求代码约束仅描述当时版本；当前书架可在空闲时请求代码。

必须等待时使用简单转圈与实际阶段文案：准备工作区、读取项目内容。没有百分比或
人为最短停留时间，命中缓存直接进入；减少动态效果偏好关闭旋转。加载失败停止转圈。
补齐中英文 `common.loading`，避免其他使用该键的界面显示原始键名。

新增验收入口：

```bash
node scripts/run-renderer-project-entry.mjs
node scripts/run-renderer-project-entry.mjs --check
```

`acceptance/project-entry.json` 使用真实开发模块图、加载组件与预加载 hook，并用合成
书架和工作区隔离作者数据。对比关闭优化、仅服务器预热、服务器预热加书架预加载；
每种模式使用独立缓存与相同书架停留时间。耗时是单次诊断样本，不代表原生窗口中的
整个项目打开耗时。还覆盖后台准备不挂载、重复进入、加载中返回、迟到结果归属、失败
重试、中英文案及减少动态效果。`.qa/project-entry/` 保留本机视觉检查截图。

## 历史 F7g 证据

下列报告记录设置仍与项目共享入口时的边界，不能作为当前独立设置入口的验收。
当前入口使用上面的 `project-entry.json` 和 `settings-entry.json`。

- [f7-project-routes.json](acceptance/f7-project-routes.json)：精确 `c290c998` 对照当前源指纹；
  首屏静态 JS 为 4,409,079 → 2,362,731 字节，减少 46.4%。四类目标模块在访问前均未请求、
  解析、执行；同时检查五个后续功能入口的静态依赖和 CSS 已在路由门槛就绪。
- 11 项真实无头浏览器检查覆盖共享 JS 和 CSS 请求失败、加载中及失败后返回、刷新重试、
  迟到项目归属、六种页面选择、合成父级草稿 DOM 连续性、缓存再开和设置不挂载合成工作区。
- [f7-settings-after-routes.json](acceptance/f7-settings-after-routes.json)：沿用设置真实组件/资源失败、
  重试和偏好修改测试，重新验证共享依赖边界变化。
- [code-delivery-regression.json](acceptance/code-delivery-regression.json)：当前源码的确定性组合回归。

生产入口/模块图保留真实导入，路由浏览器观察使用测试专属 bootstrap 和合成叶子组件，
不启动完整应用的数据库或原生运行时。因此它证明代码加载及路由挂载归属，不能替代完整
ProjectRuntime/编辑器组合验收。普通生产构建不包含这段观察 bootstrap。

```bash
node scripts/run-renderer-project-routes.mjs
node scripts/run-renderer-project-routes.mjs --check
node scripts/run-renderer-deferred-settings.mjs --check --historical --report=docs/renderer-performance/acceptance/f7-settings-after-routes.json
node scripts/run-renderer-performance.mjs --ci --output=docs/renderer-performance/acceptance/code-delivery-regression.json
```

报告保留运行时的父提交及真实源指纹，不将提交前测量冒充为提交后运行。完整设备验收及
整 App/首次功能访问预算继续保持未完成，详见[代码交付与手动验收](code-delivery.md)。
