# F7g：项目与独立设置的路由代码边界

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

独立设置也经过同一代码门槛，但不挂载 ProjectRuntime。设置、图谱和资料的既有重试入口依赖
工作区共享代码：门槛先加载这些依赖，之后入口可以保留原来的局部换键重试。
书架用户菜单不提前预加载设置内容；项目内的设置、图谱等意图预加载继续保留。
首次访问设置会加载工作区共用代码，这是本批明确保留的加载成本。

## 证据

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
node scripts/run-renderer-deferred-settings.mjs --report=docs/renderer-performance/acceptance/f7-settings-after-routes.json
node scripts/run-renderer-performance.mjs --ci --output=docs/renderer-performance/acceptance/code-delivery-regression.json
```

报告保留运行时的父提交及真实源指纹，不将提交前测量冒充为提交后运行。完整设备验收及
整 App/首次功能访问预算继续保持未完成，详见[代码交付与手动验收](code-delivery.md)。
